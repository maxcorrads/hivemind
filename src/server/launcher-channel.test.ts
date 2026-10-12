import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { LauncherVerifier, launcherSignature } from "./launcher-channel.ts";
import { startServer } from "./serve.ts";
import { deleteRows, findRow, readValue, setAgentPresence, updateRows } from "./test-fixtures.ts";
import type { WorkerTemplate, WorkerTemplateSpec } from "../shared/worker-templates.ts";
import { toLaunchAccount, type AccountUsage } from "../shared/accounts.ts";

const SECRET = Buffer.alloc(32, 0x61);
const spec = (cap = 2): WorkerTemplateSpec => ({ label: "Worker", description: "Task work", software: "codex2",
  model: "gpt-6-sol", effort: "high", extraFlags: "", environment: { TASK_ENV: "safe" }, secretNames: [],
  seniority: "mid", focus: "tasks", maxConcurrent: cap, enabled: true });

function fixture(t: TestContext, cap = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-launcher-channel-"));
  const file = path.join(dir, "hive.db"), hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.createProject(human, { name: "Project", slug: "project", worktree: dir });
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const template = hive.workerTemplates.create(human, project.id, { slug: "worker", spec: spec(cap) });
  const app = createApp(hive, { instanceSecret: SECRET });
  const request = (approval = true) => {
    const { agent, ticket } = hive.identity.reserve(human, template, "task", approval);
    const id = randomUUID();
    const view = hive.launcherQueue.create({ requestId: id, brain, template, agent, ticket, reason: "Test task", approval });
    return { id, view, agent, ticket };
  };
  let nonceCounter = 0;
  const signed = async (method: string, target: string, body?: unknown, secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), nonce?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const n = nonce ?? (nonceCounter++).toString(16).padStart(64, "0");
    return app.request(target, { method, headers: { "content-type": "application/json",
      "x-hivemind-timestamp": timestamp, "x-hivemind-nonce": n,
      "x-hivemind-signature": launcherSignature(secret, method, target, timestamp, n, Buffer.from(raw)) },
    ...(body === undefined ? {} : { body: raw }) });
  };
  return { dir, file, hive, app, human, project, brain, template, request, signed };
}

test("signed channel authenticates method/path/query/body, rejects replay, skew, wrong secret and no-secret", async t => {
  const f = fixture(t);
  const target = "/api/launcher/next?timeoutMs=0";
  assert.equal((await f.signed("GET", target, undefined, Buffer.alloc(32))).status, 401);
  const stale = String(Math.floor(Date.now() / 1000) - 61);
  assert.equal((await f.signed("GET", target, undefined, SECRET, stale)).status, 401);
  const first = await f.signed("GET", target);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { command: null });
  const nonce = "f".repeat(64), at = String(Math.floor(Date.now() / 1000));
  assert.equal((await f.signed("GET", target, undefined, SECRET, at, nonce)).status, 200);
  assert.equal((await f.signed("GET", target, undefined, SECRET, at, nonce)).status, 401);
  const signature = launcherSignature(SECRET, "GET", target, at, "e".repeat(64), Buffer.alloc(0));
  const tampered = await f.app.request("/api/launcher/next?timeoutMs=1", { headers: {
    "x-hivemind-timestamp": at, "x-hivemind-nonce": "e".repeat(64), "x-hivemind-signature": signature } });
  assert.equal(tampered.status, 401);
  const unavailable = createApp(f.hive);
  assert.equal((await unavailable.request(target)).status, 404);
});

test("future-dated nonce stays rejected for its entire 120 second validity interval", async () => {
  let now = 1_000_000;
  const verifier = new LauncherVerifier(SECRET, () => now);
  const at = String(Math.floor(now / 1000) + 60), nonce = "a".repeat(64), target = "/api/launcher/next?timeoutMs=0";
  const request = () => new Request(`http://127.0.0.1${target}`, { headers: {
    "x-hivemind-timestamp": at, "x-hivemind-nonce": nonce,
    "x-hivemind-signature": launcherSignature(SECRET, "GET", target, at, nonce, Buffer.alloc(0)) } });
  await verifier.verify(request());
  now += 61_000;
  await assert.rejects(verifier.verify(request()), /Invalid launcher proof/);
  now += 58_000;
  await assert.rejects(verifier.verify(request()), /Invalid launcher proof/);
});

test("long poll wakes for a new approval with no launch command", async t => {
  const f = fixture(t);
  const pending = f.signed("GET", "/api/launcher/next?timeoutMs=5000");
  for (let n = 0; n < 30 && f.hive.bus.listenerCount("launch-requests") === 0; n++)
    await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.hive.bus.listenerCount("launch-requests"), 1);
  f.request();
  const result = await pending;
  assert.deepEqual(await result.json(), { command: null });
  assert.equal(f.hive.bus.listenerCount("launch-requests"), 0);
});

test("approval queues once, encrypted claim survives restart, result scrubs payload and public views hide ticket", async t => {
  const f = fixture(t), { id, ticket } = f.request();
  const nativePending = await f.signed("GET", "/api/launcher/approvals");
  assert.equal(nativePending.status, 200);
  const pendingList = await nativePending.json() as { requests: Array<{ id: string; reason: string }> };
  assert.equal(pendingList.requests.length, 1);
  assert.equal(pendingList.requests[0]!.id, id);
  assert.equal(pendingList.requests[0]!.reason, "Test task");
  assert.equal(JSON.stringify(pendingList).includes(ticket), false);
  const pending = await f.signed("GET", "/api/launcher/next?timeoutMs=0");
  assert.deepEqual(await pending.json(), { command: null });
  const list = await f.app.request("/api/ui/launch-requests");
  assert.equal(list.status, 200);
  assert.equal((await list.text()).includes(ticket), false);
  const row = findRow(f.hive, "launcher_commands", { request_id: id })!;
  assert.equal(String(row.payload).includes(ticket), false);
  assert.match(String(row.payload), /^v1:/);
  const key = path.join(f.dir, "launcher-queue.key");
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.file).includes(ticket), false);
  const approved = await f.signed("POST", `/api/launcher/requests/${id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as { request: { state: string } }).request.state, "approved");
  assert.deepEqual(await (await f.signed("GET", "/api/launcher/approvals")).json(), { requests: [] });
  const response = await f.signed("GET", "/api/launcher/next?timeoutMs=0");
  assert.equal(response.status, 200);
  const command = (await response.json() as { command: { id: string; kind: string; session: string; command: string; cwd: string } }).command;
  assert.equal(command.kind, "launch");
  assert.ok(command.command.includes(ticket));
  assert.equal(command.cwd, realpathSync(f.dir));
  assert.match(command.session, /^hm-project-/);
  const other = new Hive(f.file);
  t.after(async () => { await other.adaptiveTopology.stop(); other.db.close(); });
  assert.deepEqual(other.launcherQueue.next("http://127.0.0.1:7520"), command);
  const result = await f.signed("POST", `/api/launcher/${command.id}/result`, { status: "launched", session: command.session });
  assert.equal(result.status, 200);
  assert.equal((await f.signed("POST", `/api/launcher/${command.id}/result`, { status: "launched", session: command.session })).status, 200);
  assert.equal(readValue(f.hive, "launcher_commands", "payload", { id: command.id }), "");
  assert.equal((await f.signed("GET", "/api/launcher/next?timeoutMs=0")).status, 200);
  assert.equal(f.hive.launcherQueue.get(id).state, "launched");
});

test("native worker launch checks the renamed Bot context and fails closed on a broken catalog", async t => {
  const f = fixture(t), request = f.request(false);
  const catalog = path.join(f.dir, 'bot-definitions.json');
  writeFileSync(catalog, '{broken');
  const denied = await f.signed('GET', '/api/launcher/next?timeoutMs=0');
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: 'Project launch context is unavailable' });
  assert.equal(f.hive.launcherQueue.get(request.id).state, 'approved');
  assert.equal(readValue(f.hive, 'launcher_commands', 'state', { request_id: request.id }), 'queued');
  // Repair only this fixture's catalog. The same queued request can then prepare
  // its original worker command; no replacement identity or claim is needed.
  writeFileSync(catalog, '[]');
  const response = await f.signed('GET', '/api/launcher/next?timeoutMs=0');
  assert.equal(response.status, 200);
  const { command } = await response.json() as { command: { kind: string; requestId: string; command: string } };
  assert.equal(command.kind, 'launch');
  assert.equal(command.requestId, request.id);
  assert.ok(command.command.includes(request.ticket));
  assert.equal(f.hive.launcherQueue.get(request.id).state, 'launching');
});

test("signed launch wire omits an empty template environment and keeps nonempty variables", async t => {
  const f = fixture(t), withVariables = f.request(false);
  const target = "/api/launcher/next?timeoutMs=0";
  const first = await f.signed("GET", target);
  assert.equal(first.status, 200);
  const withEnvironment = (await first.json() as { command: Record<string, unknown> }).command;
  assert.equal(withEnvironment.kind, "launch");
  assert.deepEqual(withEnvironment.environment, { TASK_ENV: "safe" });
  assert.equal((await f.signed("POST", `/api/launcher/${withEnvironment.id}/result`,
    { status: "launched", session: withEnvironment.session })).status, 200);
  assert.equal(f.hive.launcherQueue.get(withVariables.id).state, "launched");

  const template = f.hive.workerTemplates.create(f.human, f.project.id,
    { slug: "no-variables", spec: { ...spec(), environment: {} } });
  const { agent, ticket } = f.hive.identity.reserve(f.human, template, "task", false);
  f.hive.launcherQueue.create({ requestId: randomUUID(), brain: f.brain, template, agent, ticket, approval: false });
  const second = await f.signed("GET", target);
  assert.equal(second.status, 200);
  const withoutEnvironment = (await second.json() as { command: Record<string, unknown> }).command;
  assert.equal(withoutEnvironment.kind, "launch");
  assert.equal("environment" in withoutEnvironment, false);
});

test("signed resume wire also omits an empty template environment", async t => {
  const f = fixture(t), target = "/api/launcher/next?timeoutMs=0";
  const template = f.hive.workerTemplates.create(f.human, f.project.id,
    { slug: "no-variables", spec: { ...spec(), environment: {} } });
  f.hive.identity.setLaunchMode(f.human, f.brain.name, "auto");
  const brain = f.hive.identity.getAgent(f.brain.id);
  const requested = f.hive.workerOrchestration.request(brain, { requestId: randomUUID(), template: template.slug,
    contract: { objective: "Build a view", scope: [], nonGoals: [], acceptanceCriteria: ["View works"],
      dependencies: [], evidenceSeqs: [] } });
  const claim = (await (await f.signed("GET", target)).json() as { command: Record<string, unknown> }).command;
  assert.equal(claim.kind, "launch");
  assert.equal("environment" in claim, false);
  const ticket = /hmc_[0-9a-f]{48}/.exec(String(claim.command))?.[0];
  assert.ok(ticket);
  assert.equal((await f.signed("POST", `/api/launcher/${claim.id}/result`,
    { status: "launched", session: claim.session })).status, 200);
  f.hive.identity.join({ role: "worker", claim: ticket });

  const task = () => f.hive.tasks.get(f.human, requested.task.id);
  const pause = f.hive.tasks.control(f.human, requested.task.id,
    { requestId: randomUUID(), expectedRevision: task().revision, action: { type: "pause", mode: "hard" } });
  f.hive.tasks.sweepHardPauses(pause.task.pause!.graceUntil!);
  const kill = (await (await f.signed("GET", target)).json() as { command: Record<string, unknown> }).command;
  assert.equal(kill.kind, "kill");
  assert.equal((await f.signed("POST", `/api/launcher/${kill.id}/result`, { status: "killed" })).status, 200);
  f.hive.tasks.control(f.human, requested.task.id,
    { requestId: randomUUID(), expectedRevision: task().revision, action: { type: "resume" } });
  const resume = (await (await f.signed("GET", target)).json() as { command: Record<string, unknown> }).command;
  assert.equal(resume.kind, "launch");
  assert.equal("environment" in resume, false);
});

test("missing, corrupt and non-private escrow keys fail closed while a command is pending", async t => {
  const f = fixture(t), { id } = f.request(false);
  const key = path.join(f.dir, "launcher-queue.key"), original = readFileSync(key);
  rmSync(key);
  assert.throws(() => new Hive(f.file), /key is missing/);
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  assert.throws(() => new Hive(f.file), /authentication failed/);
  writeFileSync(key, original, { mode: 0o600 });
  chmodSync(key, 0o644);
  assert.throws(() => new Hive(f.file), /private 0600/);
  chmodSync(key, 0o600);
  assert.equal(f.hive.launcherQueue.get(id).state, "approved");
});

test("Human approval cards retain older pending requests beyond the settled history page", async t => {
  const f = fixture(t), pending = f.request();
  for (let i = 0; i < 201; i++) {
    const settled = f.request();
    f.hive.launcherQueue.reject(f.human, settled.id);
  }
  const response = await f.app.request("/api/ui/launch-requests");
  assert.equal(response.status, 200);
  const body = await response.json() as { requests: Array<{ id: string }> };
  assert.deepEqual(body.requests.map(request => request.id), [pending.id]);
});

test("two pending approvals share one template cap; changing template and rejecting release reservations", async t => {
  const f = fixture(t, 1), first = f.request(), second = f.request();
  assert.equal(first.view.capBlocked, false);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${first.id}/approve`, {})).status, 200);
  assert.equal(f.hive.launcherQueue.get(second.id).capBlocked, true);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${second.id}/approve`, {})).status, 409);
  const alternate = f.hive.workerTemplates.create(f.human, f.project.id, { slug: "alternate", spec: spec(1) });
  assert.equal((await f.signed("POST", `/api/launcher/requests/${second.id}/approve`, { templateId: alternate.id })).status, 200);
  assert.equal(f.hive.identity.getAgent(second.agent.id).templateId, alternate.id);
  const third = f.hive.identity.reserve(f.human, alternate, "third", true);
  const thirdId = randomUUID();
  f.hive.launcherQueue.create({ requestId: thirdId, brain: f.brain, template: alternate, agent: third.agent, ticket: third.ticket, approval: true });
  assert.equal((await f.signed("POST", `/api/launcher/requests/${thirdId}/reject`, {})).status, 200);
  assert.equal(f.hive.identity.getAgent(third.agent.id).removedAt !== undefined, true);
  assert.equal(readValue(f.hive, "launcher_commands", "payload", { request_id: thirdId }), "");
});

test("an expired reservation cannot be approved or discounted from the template cap", async t => {
  const f = fixture(t, 1), stale = f.request();
  updateRows(f.hive, "agents", { pending_until: 0 }, { id: stale.agent.id });
  const expired = await f.signed("POST", `/api/launcher/requests/${stale.id}/approve`, {});
  assert.equal(expired.status, 409);
  assert.equal(f.hive.launcherQueue.get(stale.id).state, "expired");
  assert.equal(f.hive.identity.getAgent(stale.agent.id).removedAt !== undefined, true);
  const running = f.request(false);
  const waiting = f.request();
  assert.equal(f.hive.launcherQueue.get(waiting.id).capBlocked, true);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${waiting.id}/approve`, {})).status, 409);
  assert.equal(f.hive.launcherQueue.get(running.id).state, "approved");
});

test("reservation sweep removes stale approvals from the signed notification feed", async t => {
  const f = fixture(t), pending = f.request();
  updateRows(f.hive, "agents", { pending_until: 0 }, { id: pending.agent.id });
  f.hive.identity.expireReservations();
  f.hive.launcherQueue.sweepExpired();
  assert.equal(f.hive.launcherQueue.get(pending.id).state, "expired");
  assert.deepEqual(await (await f.signed("GET", "/api/launcher/approvals")).json(), { requests: [] });
});

test("historical request retains template snapshot after delete; project deletion purges its queue before identities", async t => {
  const f = fixture(t), retired = f.request();
  assert.equal((await f.signed("POST", `/api/launcher/requests/${retired.id}/reject`, {})).status, 200);
  f.hive.workerTemplates.delete(f.human, f.template.id, f.template.revision);
  const historical = f.hive.launcherQueue.get(retired.id);
  assert.equal(historical.templateId, f.template.id);
  assert.equal(historical.templateLabel, f.template.spec.label);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  f.hive.projects.deleteProject(f.human, f.project.slug);
  assert.equal(findRow(f.hive, "launch_requests", { id: retired.id }), undefined);
  assert.equal(findRow(f.hive, "launcher_commands", { request_id: retired.id }), undefined);
});

test("real HTTP launcher channel bypasses Human cookie, and client disconnect releases long-poll waiter", async t => {
  const f = fixture(t);
  process.env.HIVEMIND_INSTANCE_SECRET = SECRET.toString("hex");
  const server = startServer({ port: 0, hive: f.hive, telegram: false });
  try {
    const port = await server.ready, base = `http://127.0.0.1:${port}`;
    const target = "/api/launcher/next?timeoutMs=30000";
    const at = String(Math.floor(Date.now() / 1000)), nonce = "d".repeat(64);
    const controller = new AbortController();
    const pending = fetch(base + target, { signal: controller.signal, headers: {
      "x-hivemind-timestamp": at, "x-hivemind-nonce": nonce,
      "x-hivemind-signature": launcherSignature(SECRET, "GET", target, at, nonce, Buffer.alloc(0)) } });
    for (let n = 0; n < 30 && f.hive.bus.listenerCount("launcher-queue") === 0; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.hive.bus.listenerCount("launcher-queue"), 1);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    for (let n = 0; n < 30 && f.hive.bus.listenerCount("launcher-queue") !== 0; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.hive.bus.listenerCount("launcher-queue"), 0);
    assert.equal(f.hive.bus.listenerCount("launch-requests"), 1, "only serve's realtime forwarder remains");
    const valid = "/api/launcher/next?timeoutMs=0", secondNonce = "c".repeat(64);
    const response = await fetch(base + valid, { headers: { "x-hivemind-timestamp": at,
      "x-hivemind-nonce": secondNonce,
      "x-hivemind-signature": launcherSignature(SECRET, "GET", valid, at, secondNonce, Buffer.alloc(0)) } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { command: null });
  } finally { await server.shutdown(); }
  const noSecret = startServer({ port: 0, hive: f.hive, telegram: false });
  try {
    const port = await noSecret.ready;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/launcher/next?timeoutMs=0`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/launcher/approvals`)).status, 404);
  } finally { await noSecret.shutdown(); }
});

test("project deletion waits for a dispatched launch and its compensating kill", async t => {
  const f = fixture(t), launched = f.request(false);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(launch.kind, "launch");
  f.hive.launcherQueue.kill(launched.id);
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  if (launch.kind !== "launch") throw new Error("Expected launch");
  const next = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(next.kind, "kill", "a cancelled dispatch is never redelivered as a fresh launch");
  f.hive.launcherQueue.result(launch.id, { status: "launched", session: launch.session });
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(kill.kind, "kill");
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  f.hive.launcherQueue.result(kill.id, { status: "killed" });
  assert.equal(f.hive.identity.getAgent(launched.agent.id).removedAt !== undefined, true);
  f.hive.projects.deleteProject(f.human, f.project.slug);
});

test("failed kill keeps project and command history until session closure is resolved", async t => {
  const f = fixture(t), launched = f.request(false);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  if (launch.kind !== "launch") throw new Error("Expected launch");
  f.hive.launcherQueue.result(launch.id, { status: "launched", session: launch.session });
  f.hive.launcherQueue.kill(launched.id);
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  f.hive.launcherQueue.result(kill.id, { status: "failed" });
  assert.match(f.hive.launcherQueue.get(launched.id).error ?? "", /Session close failed/);
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  assert.ok(findRow(f.hive, "launcher_commands", { id: kill.id }));
  f.hive.launcherQueue.kill(launched.id);
  const retry = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(retry.kind, "kill");
  assert.notEqual(retry.id, kill.id);
  f.hive.launcherQueue.kill(launched.id);
  assert.equal(f.hive.launcherQueue.next("http://127.0.0.1:7520")!.id, retry.id);
  f.hive.launcherQueue.result(retry.id, { status: "killed" });
  assert.equal(f.hive.launcherQueue.get(launched.id).error, null);
  f.hive.projects.deleteProject(f.human, f.project.slug);
});

/** A brain request for `template` that needs no approval, as the launcher channel sees it. */
function queueLaunch(f: ReturnType<typeof fixture>, template: WorkerTemplate): string {
  const { agent, ticket } = f.hive.identity.reserve(f.human, template, "task", false);
  const requestId = randomUUID();
  f.hive.launcherQueue.create({ requestId, brain: f.brain, template, agent, ticket, approval: false });
  return requestId;
}

/** The next launch command, settled as launched so that the following call moves on to the next request. */
function takeLaunch(f: ReturnType<typeof fixture>) {
  const command = f.hive.launcherQueue.next("http://127.0.0.1:7520");
  if (command?.kind !== "launch") throw new Error("Expected launch");
  f.hive.launcherQueue.result(command.id, { status: "launched", session: command.session });
  return command;
}

/** Phase 5 supplies usage; until then a test stands in for it through the account store's usage provider. */
function supplyUsage(f: ReturnType<typeof fixture>, usage: Map<string, AccountUsage>) {
  (f.hive.accounts as unknown as { usage: () => ReadonlyMap<string, AccountUsage> }).usage = () => usage;
}

const limited = (accountId: string, limitResetAt: number): AccountUsage => ({ accountId, snapshot: null, lastAttemptAt: null,
  lastError: null, limitResetAt, limitErrorAt: null });

/** A fresh snapshot whose only window is used up and gives no reset time. */
const full = (accountId: string): AccountUsage => ({ accountId, snapshot: { accountId, capturedAt: Date.now(), source: "codex",
  plan: "subscription", windows: [{ key: "five_hour", label: "5 h", usedPercent: 100, resetsAt: null }], error: null,
  limitErrorAt: null }, lastAttemptAt: null, lastError: null, limitResetAt: null, limitErrorAt: null });

test("a Codex template launch runs under the policy's account or its pin, and carries it on the command", async t => {
  const f = fixture(t);
  const worker = f.hive.workerTemplates.create(f.human, f.project.id, { slug: "codex-worker", spec: { ...spec(8), software: "codex" } });
  queueLaunch(f, worker);
  assert.equal("account" in takeLaunch(f), false, "no accounts, no field");

  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const personal = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" });
  queueLaunch(f, worker);
  assert.deepEqual(takeLaunch(f).account, toLaunchAccount(work), "sequential takes the first account");
  assert.notEqual(f.hive.accounts.get(work.id).lastSelectedAt, null, "the pick is recorded");

  const pinned = f.hive.workerTemplates.create(f.human, f.project.id,
    { slug: "codex-pinned", spec: { ...spec(8), software: "codex", accountId: personal.id } });
  queueLaunch(f, pinned);
  assert.deepEqual(takeLaunch(f).account, toLaunchAccount(personal), "the pin wins over the policy");
});

test("an exhausted pool keeps the launch queued until a reset passes, with the first reset in the message", async t => {
  const f = fixture(t);
  const soon = Date.now() + 3_600_000;
  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const personal = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" });
  const usage = new Map([[work.id, limited(work.id, soon)], [personal.id, limited(personal.id, soon + 3_600_000)]]);
  supplyUsage(f, usage);
  const worker = f.hive.workerTemplates.create(f.human, f.project.id, { slug: "codex-worker", spec: { ...spec(8), software: "codex" } });
  const waiting = queueLaunch(f, worker);
  assert.throws(() => takeLaunch(f), { message: `Every Codex account is used up until ${new Date(soon).toLocaleString()}` });
  assert.equal(f.hive.launcherQueue.get(waiting).state, "approved", "the request stays queued");
  usage.set(work.id, full(work.id)).set(personal.id, full(personal.id));
  assert.throws(() => takeLaunch(f), { message: "Every Codex account is used up" }, "no known reset, no time");

  usage.set(work.id, limited(work.id, Date.now() - 1));
  const launch = takeLaunch(f);
  assert.equal(launch.requestId, waiting);
  assert.deepEqual(launch.account, toLaunchAccount(work));
});

test("a launch variable the chosen account manages fails the queued launch and names the variable", async t => {
  const f = fixture(t);
  // Created before any account exists, which the template store allows; the policy then picks an account for it.
  const worker = f.hive.workerTemplates.create(f.human, f.project.id,
    { slug: "codex-worker", spec: { ...spec(8), software: "codex", environment: { CODEX_HOME: "/elsewhere" } } });
  f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  queueLaunch(f, worker);
  assert.throws(() => takeLaunch(f), { message: "CODEX_HOME is managed by the account Codex work; remove it." });
});

test("a pin to an account that was removed fails the queued launch", async t => {
  const f = fixture(t);
  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const pinned = f.hive.workerTemplates.create(f.human, f.project.id,
    { slug: "codex-pinned", spec: { ...spec(8), software: "codex", accountId: work.id } });
  deleteRows(f.hive, "agent_accounts", { id: work.id });
  queueLaunch(f, pinned);
  assert.throws(() => takeLaunch(f), { message: "The pinned account no longer exists" });
});

/** A usage snapshot as Server.app posts it; `overrides` replaces any field. */
const usageSnapshot = (accountId: string, overrides: Record<string, unknown> = {}) => ({ accountId, capturedAt: Date.now(),
  source: "codex", plan: "subscription", windows: [{ key: "codex.primary", label: "5 h", usedPercent: 40, resetsAt: Date.now() + 3_600_000 }],
  error: null, limitErrorAt: null, ...overrides });

test("launcher accounts and usage refuse an unsigned request exactly as /next does", async t => {
  const f = fixture(t);
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });
  const next = await answer(await f.app.request("/api/launcher/next?timeoutMs=0"));
  const accounts = await answer(await f.app.request("/api/launcher/accounts"));
  const usage = await answer(await f.app.request("/api/launcher/usage", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshots: [] }) }));
  assert.equal(next.status, 401);
  assert.deepEqual(accounts, next);
  assert.deepEqual(usage, next);
  const unavailable = createApp(f.hive);
  assert.equal((await unavailable.request("/api/launcher/accounts")).status, 404);
  assert.equal((await unavailable.request("/api/launcher/usage", { method: "POST", body: "{}" })).status, 404);
});

test("signed accounts list answers each catalog entry as a LaunchAccount and nothing more", async t => {
  const f = fixture(t);
  assert.deepEqual(await (await f.signed("GET", "/api/launcher/accounts")).json(), { accounts: [] });
  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const personal = f.hive.accounts.create(f.human, { driver: "claude", label: "Claude personal", homePath: "", shadowPath: "~/.claude-personal" });
  const response = await f.signed("GET", "/api/launcher/accounts");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accounts: [toLaunchAccount(personal), toLaunchAccount(work)] });
});

test("signed usage post stores snapshots, refuses unknown keys, sizes and accounts, and an error keeps the windows", async t => {
  const f = fixture(t);
  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "" });
  const post = (body: unknown) => f.signed("POST", "/api/launcher/usage", body);
  assert.equal((await post({ snapshots: [], extra: true })).status, 400);
  assert.equal((await post({ snapshots: [usageSnapshot(work.id, { extra: true })] })).status, 400);
  assert.equal((await post({ snapshots: Array.from({ length: 17 }, () => usageSnapshot(work.id)) })).status, 400);
  assert.equal((await post({ snapshots: [usageSnapshot(work.id), usageSnapshot("missing-account")] })).status, 404);
  assert.deepEqual(f.hive.accountUsage.list(), [], "a refused batch stores nothing");

  const good = usageSnapshot(work.id);
  assert.equal((await post({ snapshots: [good] })).status, 200);
  assert.deepEqual(f.hive.accountUsage.map().get(work.id)?.snapshot?.windows, good.windows);

  const failed = usageSnapshot(work.id, { capturedAt: good.capturedAt + 60_000, windows: [], error: "Usage read failed" });
  assert.equal((await post({ snapshots: [failed] })).status, 200);
  const usage = f.hive.accountUsage.map().get(work.id)!;
  assert.deepEqual(usage.snapshot?.windows, good.windows, "an error keeps the previous windows");
  assert.equal(usage.snapshot?.capturedAt, good.capturedAt);
  assert.equal(usage.lastError, "Usage read failed");
  assert.equal(usage.lastAttemptAt, failed.capturedAt);

  const windows = Array.from({ length: 8 }, (_, n) => ({ key: `codex.window${n}`, label: `Window ${n} label`, usedPercent: n * 10, resetsAt: null }));
  const sixteen = { snapshots: Array.from({ length: 16 }, () => usageSnapshot(work.id, { windows })) };
  assert.ok(JSON.stringify(sixteen).length > 4096, "the usage post carries more than the 4 KiB launcher limit");
  assert.equal((await post(sixteen)).status, 200);
  assert.equal((await post({ snapshots: [], padding: "x".repeat(64 * 1024) })).status, 413);
  assert.equal((await f.signed("POST", "/api/launcher/requests/none/reject", { padding: "x".repeat(5000) })).status, 413,
    "the 4 KiB limit still applies to the other launcher routes");
});
