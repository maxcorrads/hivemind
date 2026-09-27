import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ACTIVITY_ACTION_GRACE_MS, ACTIVITY_STALL_MS, ACTIVITY_WAIT_GRACE_MS } from "../../shared/agent-activity.ts";
import type { RecordAgentLifecycleEvent } from './agent-lifecycle-log.ts';
import type { Agent } from "../../shared/types.ts";
import { AgentActivityService } from "./agent-activity.ts";
import { Hive } from "../hive.ts";

const START = 1_800_000_000_000;

function fixture() {
  const agent: Agent = { id: "worker-1", name: "Forge", role: "worker", seniority: "mid", focus: null,
    online: true, lastSeenAt: START, createdAt: START, projectId: "project-1", project: "acme" };
  let queued = 0;
  let launch: { state: string; since: number } | null = null;
  const published: Agent[] = [];
  const logged: RecordAgentLifecycleEvent[] = [];
  const make = () => new AgentActivityService({
    identity: { getAgent: () => agent, listAgents: () => [agent] },
    delivery: { queuedCount: () => queued },
    launcherQueue: { launchPresence: () => launch },
    bus: { emit: (_type, value) => { published.push(value); } },
    lifecycleLog: { record: input => { logged.push(input); return { ...input, at: input.at ?? START, seq: logged.length }; } },
  });
  const activity = make();
  return { agent, activity, published, logged, make,
    queue(value: number, at: number) { queued = value; activity.queueChanged(agent.id, value, at); },
    launch(value: { state: string; since: number } | null) { launch = value; },
    heartbeat(at: number) { agent.lastSeenAt = at; },
  };
}

test('lifecycle activity logs only real stalled, offline and superseded transitions', () => {
  const f = fixture();
  assert.equal(f.activity.forAgent(f.agent, 0, START).state, 'offline');
  assert.equal(f.logged.length, 0, 'initial conservative projection is not a lifecycle transition');
  const wait = f.activity.waitStarted(f.agent.id, 'session-1', START);
  f.activity.sessionSuperseded(f.agent.id, START + 1);
  f.activity.waitEnded(f.agent.id, wait, 'superseded', START + 1);
  f.activity.sessionSuperseded(f.agent.id, START + 1);
  assert.deepEqual(f.logged.map(event => event.kind), ['superseded']);
  f.activity.action(f.agent.id, START + 2);
  f.queue(1, START + 3);
  const stalledAt = START + 3 + ACTIVITY_STALL_MS;
  f.heartbeat(stalledAt);
  f.activity.sweep(stalledAt);
  f.activity.sweep(stalledAt);
  assert.deepEqual(f.logged.map(event => event.kind), ['superseded', 'stalled']);
  f.activity.action(f.agent.id, stalledAt + 1);
  f.queue(0, stalledAt + 1);
  const offlineAt = stalledAt + 1 + ACTIVITY_ACTION_GRACE_MS + 1;
  f.heartbeat(offlineAt);
  f.activity.sweep(offlineAt);
  assert.deepEqual(f.logged.map(event => event.kind), ['superseded', 'stalled', 'offline']);
  assert.ok(f.logged.every(event => event.source === 'server' && event.agentId === f.agent.id &&
    event.actorId === null && event.projectId === f.agent.projectId));
  assert.ok(f.logged.every(event => event.summary.length <= 400));
});

test("#258: continuing heartbeats cannot mask a stopped wait with queued mail", () => {
  const f = fixture();
  assert.equal(f.activity.forAgent(f.agent, 0, START).state, "offline", "heartbeat alone is not readiness");
  const token = f.activity.waitStarted(f.agent.id, "session-1", START);
  assert.equal(f.activity.forAgent(f.agent, 0, START).state, "ready");
  f.activity.waitEnded(f.agent.id, token, "idle", START + 20_000);
  const queuedAt = START + 20_001;
  f.queue(1, queuedAt);
  f.heartbeat(queuedAt + ACTIVITY_STALL_MS - 1);
  f.activity.sweep(queuedAt + ACTIVITY_STALL_MS - 1);
  assert.notEqual(f.activity.forAgent(f.agent, 1, queuedAt + ACTIVITY_STALL_MS - 1).state, "stalled");
  f.heartbeat(queuedAt + ACTIVITY_STALL_MS);
  f.activity.sweep(queuedAt + ACTIVITY_STALL_MS);
  const stalled = f.activity.forAgent(f.agent, 1, queuedAt + ACTIVITY_STALL_MS);
  assert.equal(stalled.state, "stalled");
  assert.equal(stalled.since, queuedAt + ACTIVITY_STALL_MS);
  assert.match(stalled.hint ?? "", /Mail is queued/);
  f.heartbeat(queuedAt + ACTIVITY_STALL_MS + 60_000);
  f.activity.sweep(queuedAt + ACTIVITY_STALL_MS + 60_000);
  assert.deepEqual(f.activity.forAgent(f.agent, 1, queuedAt + ACTIVITY_STALL_MS + 60_000), stalled,
    "heartbeats do not clear the delivery stall or reset since");
  assert.ok(f.published.length >= 3, "transitions are published as agent events");
  f.activity.waitStarted(f.agent.id, "session-1", queuedAt + ACTIVITY_STALL_MS + 60_001);
  assert.equal(f.activity.forAgent(f.agent, 1, queuedAt + ACTIVITY_STALL_MS + 60_001).state, "ready");
});

test("wait completion distinguishes an idle poll from delivered work and fences older cleanup", () => {
  const f = fixture();
  const old = f.activity.waitStarted(f.agent.id, "session-1", START);
  const current = f.activity.waitStarted(f.agent.id, "session-1", START + 1);
  f.activity.waitEnded(f.agent.id, old, "superseded", START + 2);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 2).state, "ready", "same-session replacement is not a superseded inbox");
  f.activity.waitEnded(f.agent.id, current, "mail", START + 3);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 3).state, "working");
  const idle = f.activity.waitStarted(f.agent.id, "session-1", START + 4);
  f.activity.waitEnded(f.agent.id, idle, "idle", START + 5);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 5 + ACTIVITY_WAIT_GRACE_MS).state, "ready");
  assert.equal(f.activity.forAgent(f.agent, 0, START + 6 + ACTIVITY_WAIT_GRACE_MS).state, "working",
    "past action evidence may remain working after the between-polls grace");
});

test("real inbox replacement is superseded until a new wait or successful action", () => {
  const f = fixture();
  const old = f.activity.waitStarted(f.agent.id, "session-1", START);
  f.activity.sessionSuperseded(f.agent.id, START + 1);
  f.activity.waitEnded(f.agent.id, old, "superseded", START + 1);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 1).state, "superseded");
  f.activity.action(f.agent.id, START + 2);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 2).state, "working");
  f.activity.sessionSuperseded(f.agent.id, START + 3);
  f.activity.waitStarted(f.agent.id, "session-2", START + 4);
  assert.equal(f.activity.forAgent(f.agent, 0, START + 4).state, "ready");
});

test("a new server forgets wait/action evidence and does not infer ready from a fresh heartbeat", () => {
  const f = fixture();
  f.activity.waitStarted(f.agent.id, "session-1", START);
  f.heartbeat(START + 1000);
  const afterRestart = f.make();
  assert.equal(afterRestart.forAgent(f.agent, 0, START + 1000).state, "offline");
  assert.equal(afterRestart.forAgent(f.agent, 1, START + 1000).state, "offline");
  f.heartbeat(START + 1000 + ACTIVITY_STALL_MS);
  assert.equal(afterRestart.forAgent(f.agent, 1, START + 1000 + ACTIVITY_STALL_MS).state, "stalled");
});

test("approved-but-unclaimed and launched-but-unclaimed reservations are distinct", () => {
  const f = fixture();
  f.agent.pending = { until: START + 30 * 60_000 };
  f.agent.online = false;
  f.launch({ state: "awaiting_approval", since: START });
  assert.equal(f.activity.forAgent(f.agent, 0, START + ACTIVITY_STALL_MS).state, "offline");
  f.launch({ state: "launched", since: START });
  const unclaimed = f.activity.forAgent(f.agent, 0, START + ACTIVITY_STALL_MS);
  assert.equal(unclaimed.state, "stalled");
  assert.match(unclaimed.hint ?? "", /has not joined/);
  f.agent.pending = undefined;
  f.agent.online = true;
  f.heartbeat(START + ACTIVITY_STALL_MS + 1);
  f.activity.waitStarted(f.agent.id, "claimed-session", START + ACTIVITY_STALL_MS + 1);
  assert.equal(f.activity.forAgent(f.agent, 0, START + ACTIVITY_STALL_MS + 1).state, "ready");
});

test("#258 integration: an actual wait stops, mail queues, heartbeats continue, and the worker stalls", async t => {
  let at = START;
  t.mock.method(Date, "now", () => at);
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agent-activity-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.listProjects()[0] ?? hive.projects.createProject(human, { name: "Acme", slug: "acme" });
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const worker = hive.identity.join({ role: "worker", seniority: "mid", project: project.slug }).agent;
  const sessionId = hive.delivery.openInboxSession(worker, randomUUID());
  const idle = await hive.delivery.wait(worker, 1, undefined, { sessionId });
  assert.equal(idle.idle, true);
  at += 20_000;
  const dm = hive.channels.openDm(brain, worker.name);
  hive.messages.postMessage(brain, { channel: dm.id, body: "Please take this task.", eventType: "assignment" });
  assert.ok(hive.delivery.queuedCount(worker.id) > 0);
  assert.notEqual(hive.activity.forAgent(hive.identity.getAgent(worker.id), undefined, at).state, "stalled");
  at += ACTIVITY_STALL_MS;
  hive.identity.touch(worker.id); // The MCP heartbeat remains healthy even though wait stopped.
  hive.activity.sweep(at);
  assert.equal(hive.identity.getAgent(worker.id).online, true);
  assert.equal(hive.activity.forAgent(hive.identity.getAgent(worker.id), undefined, at).state, "stalled");
});

test("delivery reports a real inbox replacement, while a same-session wait replacement stays ready", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agent-session-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.delivery.cancelWaits(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.listProjects()[0] ?? hive.projects.createProject(human, { name: "Acme", slug: "acme" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid", project: project.slug }).agent;
  const firstSession = hive.delivery.openInboxSession(worker, randomUUID());
  const first = hive.delivery.wait(worker, 60_000, undefined, { sessionId: firstSession });
  const second = hive.delivery.wait(worker, 60_000, undefined, { sessionId: firstSession });
  await assert.rejects(first, /superseded/);
  assert.equal(hive.activity.forAgent(hive.identity.getAgent(worker.id)).state, "ready");
  const newSession = hive.delivery.openInboxSession(worker, randomUUID());
  await assert.rejects(second, /superseded/);
  assert.equal(hive.activity.forAgent(hive.identity.getAgent(worker.id)).state, "superseded");
  const current = hive.delivery.wait(worker, 1, undefined, { sessionId: newSession });
  assert.equal(hive.activity.forAgent(hive.identity.getAgent(worker.id)).state, "ready");
  assert.equal((await current).idle, true);
});
