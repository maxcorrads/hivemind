import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { HiveError } from "../shared/types.ts";
import type { WorkerTemplateSpec } from "../shared/worker-templates.ts";

const spec = (cap = 1): WorkerTemplateSpec => ({ label: "Codex", description: "Implement a task", software: "codex2",
  model: "", effort: "", extraFlags: "", environment: {}, secretNames: [], seniority: "mid", focus: "implementation",
  maxConcurrent: cap, enabled: true });
const contract = (objective = "Build a settings view") => ({ objective, scope: [], nonGoals: [], acceptanceCriteria: ["View works"],
  dependencies: [], evidenceSeqs: [] });
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-a3-workers-"));
  const hive = new Hive(path.join(dir, "hive.db"), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.createProject(human, { name: "Project", slug: "project", worktree: dir });
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const other = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const template = hive.workerTemplates.create(human, project.id, { slug: "codex", spec: spec() });
  const request = (requestId = randomUUID(), patch: Record<string, unknown> = {}) => hive.workerOrchestration.request(brain,
    { requestId, template: "codex", contract: contract(), ...patch });
  return { dir, hive, human, project, brain, other, template, request };
}

test("brain request is atomic, exact retries are stable, and pending workers are scoped", t => {
  const f = fixture(t), id = randomUUID();
  assert.equal(f.hive.workerOrchestration.templates(f.brain).templates[0]!.instancesInUse, 0);
  const first = f.request(id);
  assert.equal(first.request.state, "awaiting_approval");
  assert.equal(first.request.taskId, first.task.id);
  assert.equal(first.task.workerId, first.worker.id);
  assert.equal(f.request(id).worker.id, first.worker.id);
  assert.throws(() => f.request(id, { slug: "different" }), status(409));
  assert.equal(f.hive.identity.listAgents(f.other).some(a => a.id === first.worker.id), false);
  assert.equal(f.hive.identity.listAgents(f.brain).some(a => a.id === first.worker.id), true);
  const rosterWorker = f.hive.workerOrchestration.roster(f.brain).find(a => a.id === first.worker.id)!;
  assert.deepEqual(rosterWorker.origin, { type: "template", templateId: f.template.id });
  assert.equal(rosterWorker.openTasks, 1);
  assert.equal(rosterWorker.terminalSession, undefined);
  assert.throws(() => f.hive.channels.openDm(f.other, first.worker.name), status(404));
  assert.equal(f.hive.workerOrchestration.templates(f.brain).templates[0]!.instancesInUse, 0,
    "awaiting approval does not consume a running template slot");
  const count = () => f.hive.identity.listAgents(f.brain).filter(a => a.pending).length;
  assert.throws(() => f.request(randomUUID(), { contract: { ...contract(), evidenceSeqs: [999999] } }), status(404));
  assert.equal(count(), 1, "failed assignment rolls back its reservation");
  const grouped = f.request(randomUUID(), { job: { title: "Settings initiative" } });
  assert.ok(grouped.task.jobId);
  assert.equal(grouped.request.jobId, grouped.task.jobId);
  assert.equal(f.hive.jobs.get(f.brain, grouped.task.jobId!).counts.total, 1);
});

test("approval, native launch, task review and archive retain capacity until kill acknowledgement", t => {
  const f = fixture(t), first = f.request();
  f.hive.launcherQueue.approve(f.human, first.request.id);
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520");
  assert.ok(launch && launch.kind === "launch");
  f.hive.launcherQueue.result(launch.id, { status: "launched", session: launch.session });
  assert.equal(f.hive.tasks.get(f.brain, first.task.id).revision, 2, "launch outcome is a task event");
  const ticket = /hmc_[0-9a-f]{48}/.exec(launch.command)?.[0];
  assert.ok(ticket, "the private native command carries the one-use claim");
  const joined = f.hive.identity.join({ role: "worker", claim: ticket! });
  assert.equal(joined.agent.id, first.worker.id);
  const event = (actor: typeof f.brain, action: unknown) => f.hive.tasks.event(actor, first.task.id,
    { requestId: randomUUID(), expectedRevision: f.hive.tasks.get(f.brain, first.task.id).revision, action });
  event(joined.agent, { type: "accept" });
  event(joined.agent, { type: "result", result: { summary: "Done", artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
  event(f.brain, { type: "review", decision: "accepted", summary: "Checked", evidenceSeqs: [] });
  assert.equal(f.hive.tasks.get(f.brain, first.task.id).state, "accepted_complete");
  const released = f.hive.workerOrchestration.release(f.brain, { worker: joined.agent.name, reason: "Task accepted" });
  assert.equal(released.worker.archivedAt !== undefined, true);
  assert.equal(f.hive.identity.listAgents(f.human).some(a => a.id === first.worker.id), false);
  assert.throws(() => f.hive.identity.agentByToken(joined.token), status(401));
  assert.throws(() => f.hive.identity.join({ role: "worker", seniority: "mid", resumeName: joined.agent.name }), status(410));
  assert.match(f.hive.tasks.view(f.brain, first.task.id).workerName, /\(archived\)$/);
  f.hive.identity.setLaunchMode(f.human, f.brain.name, "auto");
  const autoBrain = f.hive.identity.getAgent(f.brain.id);
  assert.throws(() => f.hive.workerOrchestration.request(autoBrain,
    { requestId: randomUUID(), template: "codex", contract: contract("Second task") }), status(409));
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520");
  assert.ok(kill && kill.kind === "kill");
  f.hive.launcherQueue.result(kill.id, { status: "killed" });
  assert.equal(f.hive.workerOrchestration.templates(autoBrain).templates[0]!.instancesInUse, 0);
  assert.equal(f.hive.workerOrchestration.request(autoBrain,
    { requestId: randomUUID(), template: "codex", contract: contract("Second task") }).request.state, "approved");
});

test("an awaiting approval does not block another brain in Auto mode", t => {
  const f = fixture(t), waiting = f.request();
  f.hive.identity.setLaunchMode(f.human, f.other.name, "auto");
  const other = f.hive.identity.getAgent(f.other.id);
  const auto = f.hive.workerOrchestration.request(other, { requestId: randomUUID(), template: "codex",
    contract: contract("Independent task") });
  assert.equal(auto.request.state, "approved");
  assert.equal(f.hive.workerOrchestration.templates(other).templates[0]!.instancesInUse, 1);
  assert.throws(() => f.hive.launcherQueue.approve(f.human, waiting.request.id), status(409));
});

test("uncertain native launch failure retains its session slot until native kill confirms closure", t => {
  const f = fixture(t);
  f.hive.identity.setLaunchMode(f.human, f.brain.name, "auto");
  const brain = f.hive.identity.getAgent(f.brain.id);
  const first = f.hive.workerOrchestration.request(brain,
    { requestId: randomUUID(), template: "codex", contract: contract() });
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520");
  assert.ok(launch && launch.kind === "launch");
  f.hive.launcherQueue.result(launch.id, { status: "failed", error: "adapter timeout" });
  assert.equal(f.hive.identity.getAgent(first.worker.id).archivedAt !== undefined, true);
  assert.equal(f.hive.tasks.get(brain, first.task.id).state, "cancelled");
  assert.equal(f.hive.workerOrchestration.templates(brain).templates[0]!.instancesInUse, 1);
  assert.throws(() => f.hive.workerOrchestration.request(brain,
    { requestId: randomUUID(), template: "codex", contract: contract("Next") }), status(409));
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520");
  assert.ok(kill && kill.kind === "kill" && kill.session === launch.session);
  f.hive.launcherQueue.result(kill.id, { status: "killed" });
  assert.equal(f.hive.workerOrchestration.templates(brain).templates[0]!.instancesInUse, 0);
});

test("replacing a cancelled legacy DM task moves only its task thread to a private channel", t => {
  const f = fixture(t);
  const fixed = f.hive.identity.join({ role: "worker", seniority: "mid", project: f.project.slug }).agent;
  const dm = f.hive.channels.openDm(f.brain, fixed.name);
  const privateChat = f.hive.messages.postMessage(f.brain, { channel: dm.id, body: "Unrelated private conversation" });
  const task = f.hive.tasks.assign(f.brain, { requestId: "legacy-task", worker: fixed.name, contract: contract() }).task;
  f.hive.identity.removeAgent(f.human, fixed.name);
  const cancelled = f.hive.tasks.get(f.brain, task.id);
  assert.equal(cancelled.state, "cancelled");
  const replacement = f.request(randomUUID(), { taskId: task.id, expectedRevision: cancelled.revision });
  assert.notEqual(replacement.task.channelId, dm.id);
  assert.equal(f.hive.messageQueries.getMessageById(task.id).channelId, replacement.task.channelId);
  assert.equal(f.hive.messageQueries.getMessageById(privateChat.id).channelId, dm.id);
  assert.equal(f.hive.channels.canSeeChannel(replacement.worker, f.hive.channels.getChannel(dm.id)), false);
});

test("a project with a settled archived worker can be deleted", t => {
  const f = fixture(t), request = f.request();
  f.hive.launcherQueue.reject(f.human, request.request.id);
  f.hive.identity.setOffline(f.brain.id);
  f.hive.identity.setOffline(f.other.id);
  f.hive.projects.deleteProject(f.human, f.project.slug);
  assert.throws(() => f.hive.projects.getProjectBySlug(f.project.slug), status(404));
});

test("rejected launch cancels task, archives identity, and a revision assigns a fresh worker", t => {
  const f = fixture(t), first = f.request(randomUUID(), { job: { title: "Settings initiative" } });
  f.hive.launcherQueue.reject(f.human, first.request.id);
  const cancelled = f.hive.tasks.get(f.brain, first.task.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(f.hive.identity.getAgent(first.worker.id).archivedAt !== undefined, true);
  const next = f.request(randomUUID(), { taskId: cancelled.id, expectedRevision: cancelled.revision,
    contract: contract("Reattempt settings view") });
  assert.equal(next.task.id, first.task.id);
  assert.equal(next.task.workerId, next.worker.id);
  assert.equal(next.task.state, "sent");
  assert.equal(next.request.taskId, first.task.id);
  assert.equal(next.task.jobId, first.task.jobId);
  assert.equal(next.request.jobId, first.task.jobId);
  assert.throws(() => f.request(randomUUID(), { taskId: next.task.id, expectedRevision: next.task.revision }), status(409));
});
