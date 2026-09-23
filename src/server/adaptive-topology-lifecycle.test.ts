import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import { countRows, setAgentPresence } from './test-fixtures.ts';

const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-lifecycle-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' });
  const workers = [0, 1, 2].map(() => hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const dm = hive.channels.openDm(human, brain.agent.name), workerDm = hive.channels.openDm(brain.agent, workers[0]!.agent.name);
  const app = createApp(hive);
  let target: AdaptiveTopology | 'capacity_blocked' = 'single';
  let beforeReply: (() => void | Promise<void>) | null = null;
  let offline = false, calls = 0, serial = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    calls++;
    if (offline) throw new Error('offline');
    const payload = jevTopologyResponse(String(init?.body), target);
    const hook = beforeReply; beforeReply = null; await hook?.();
    return Response.json(payload);
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (route: string, body: unknown, token?: string) => app.request(route, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  const start = async (mode = 'auto', scope = 'none') => {
    const value = await hive.adaptiveTopology.routeHumanRequest(human,
      { channel: dm.id, body: 'Execute the Human request.', requestId: `human-${++serial}` }, mode, scope);
    assert.ok(value); return value;
  };
  const recheck = () => hive.adaptiveTopology.revalidateForActor(brain.agent, {
    actorId: brain.agent.id, actorRole: 'brain', kind: 'brain_message', channelId: dm.id, eventId: `check-${++serial}`,
  });
  const view = () => hive.adaptiveTopology.view(human, dm.id);
  const settings = async (enabled: boolean) => {
    const response = await app.request('/api/ui/adaptive-routing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  return { hive, human, brain, workers, dm, workerDm, dir, app, start, recheck, view, post, settings,
    choose: (mode: typeof target) => { target = mode; }, calls: () => calls,
    fail: (value: boolean) => { offline = value; }, beforeReply: (hook: () => void | Promise<void>) => { beforeReply = hook; } };
}

test('monitoring state distinguishes disabled, pending, unavailable, recovered and completed without agent mail', async t => {
  const f = fixture(t); const started = await f.start();
  const count = () => countRows(f.hive, 'messages');
  const before = count();
  assert.equal(f.view().state?.monitoring, 'active');
  f.fail(true); await f.recheck(); assert.equal(f.view().state?.monitoring, 'unavailable');
  await f.settings(false); assert.equal(f.view().state?.monitoring, 'disabled'); assert.equal(f.view().state?.warning, null);
  const calls = f.calls(); await f.recheck(); assert.equal(f.calls(), calls);
  await f.settings(true); assert.equal(f.view().state?.monitoring, 'pending');
  f.fail(false); await f.recheck(); assert.equal(f.view().state?.monitoring, 'active');
  f.hive.messages.setThreadStatus(f.brain.agent, started.message.id, 'done');
  assert.equal(f.view().state?.monitoring, 'completed');
  const completedCalls = f.calls(); await f.recheck(); assert.equal(f.calls(), completedCalls);
  assert.equal(f.hive.adaptiveTopology.forAgent(f.brain.agent), null);
  assert.equal(count(), before, 'status/evaluation audit never adds messages');
  assert.throws(() => f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'task', topology: 'single' }), /completed/);
  f.hive.messages.setThreadStatus(f.human, started.message.id, 'open'); await f.recheck();
  assert.equal(f.view().state?.monitoring, 'active');
});

test('new Human root after disabling routing ends the previous execution instead of reviving its Single lock', async t => {
  const f = fixture(t); const original = await f.start('single'); await f.settings(false);
  const response = await f.post(`/api/ui/channels/${f.dm.id}/messages`, { body: 'New legacy request.', requestId: 'legacy-new-root' });
  assert.equal(response.status, 200);
  assert.ok(f.view().state?.completedAt);
  assert.equal(f.view().state?.executionId, original.state.executionId);
  await f.settings(true); const calls = f.calls(); await f.recheck(); assert.equal(f.calls(), calls);
  const next = await f.start(); assert.notEqual(next.state.executionId, original.state.executionId);
  assert.ok(next.state.updatedAt > original.state.updatedAt);
  assert.equal(next.state.lockedTopology, null);
});

test('late provider output cannot overwrite a newer Human lock or disabled setting', async t => {
  const f = fixture(t); await f.start(); f.choose('brain_multi_room');
  f.beforeReply(() => { f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'task', topology: 'single' }); });
  await f.recheck(); assert.equal(f.view().state?.currentTopology, 'single'); assert.equal(f.view().state?.lockedTopology, 'single');
  f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'none' });
  f.beforeReply(() => f.settings(false)); await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'single'); assert.equal(f.view().state?.monitoring, 'disabled');
});

test('lock compare-and-set rejects stale revision and stale execution while conversation lock survives the next request', async t => {
  const f = fixture(t); const original = await f.start();
  await f.recheck();
  assert.throws(() => f.hive.adaptiveTopology.setLock(f.human, f.dm.id,
    { scope: 'task', topology: 'single', expectedExecutionId: original.state.executionId, expectedRevision: original.state.revision }), /Routing changed/);
  const state = f.view().state!;
  const locked = f.hive.adaptiveTopology.setLock(f.human, f.dm.id,
    { scope: 'conversation', topology: 'brain_multi_room', expectedExecutionId: state.executionId, expectedRevision: state.revision });
  assert.equal(locked.state?.currentTopology, 'brain_multi_room');
  const unchanged = f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'conversation', topology: 'brain_multi_room' });
  assert.equal(unchanged.events.length, locked.events.length, 'unchanged lock is a no-op');
  f.hive.messages.setThreadStatus(f.human, original.message.id, 'done');
  const next = await f.start(); assert.equal(next.state.lockScope, 'conversation'); assert.equal(next.state.currentTopology, 'brain_multi_room');
  assert.throws(() => f.hive.adaptiveTopology.setLock(f.human, f.dm.id,
    { scope: 'task', topology: 'single', expectedExecutionId: original.state.executionId }), /Execution changed/);
  f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'none' });
  const last = await f.start(); assert.equal(last.state.lockedTopology, null);
});

test('invalid lock requests and non-Human readers cannot change authority', async t => {
  const f = fixture(t); await f.start();
  for (const raw of [null, [], {}, { scope: 1 }, { scope: 'bad' }, { scope: 'task' }, { scope: 'task', topology: 'fake' }, { scope: 'none', extra: true }])
    assert.throws(() => f.hive.adaptiveTopology.setLock(f.human, f.dm.id, raw));
  assert.throws(() => f.hive.adaptiveTopology.setLock(f.brain.agent, f.dm.id, { scope: 'none' }), /Human/);
  assert.throws(() => f.hive.adaptiveTopology.view(f.workers[0]!.agent, f.dm.id), /Human-only/);
  await assert.rejects(f.hive.adaptiveTopology.revalidateForActor(f.brain.agent, { kind: 'brain_message', actorId: 'impostor', actorRole: 'brain' }), /identity/);
  await assert.rejects(f.hive.adaptiveTopology.routeHumanRequest(f.brain.agent, { channel: f.dm.id, body: 'test' }, 'single', 'none'), /Human/);
  await assert.rejects(f.start('invalid'), /mode/);
  await assert.rejects(f.start('auto', 'task'), /Locks require/);
});

test('a completed delegation cannot be reused or reopened to bypass Single; workers cannot release their own commitment', async t => {
  const f = fixture(t); f.choose('brain_one_worker'); const executionId = (await f.start()).state.executionId;
  const sent = await f.post(`/api/agent/channels/${f.workerDm.id}/messages`, { body: 'Implement this.', eventType: 'assignment', requestId: 'delegated', executionId }, f.brain.token);
  assert.equal(sent.status, 200); const root = (await sent.json() as { id: string }).id;
  assert.throws(() => f.hive.messages.setThreadStatus(f.workers[0]!.agent, root, 'done'), /delegating brain/);
  const continued = await f.post(`/api/agent/channels/${f.workerDm.id}/messages`, { body: 'Include this case.', threadId: root, requestId: 'same-thread' }, f.brain.token);
  assert.equal(continued.status, 200, await continued.clone().text());
  assert.equal(countRows(f.hive, 'adaptive_topology_messages'), 1);
  f.choose('single'); await f.recheck(); await f.recheck();
  const closed = await f.post(`/api/agent/threads/${root}/status`, { status: 'done' }, f.brain.token);
  assert.equal(closed.status, 200); assert.equal(f.view().state?.currentTopology, 'single');
  assert.throws(() => f.hive.messages.setThreadStatus(f.brain.agent, root, 'open'), /guarded assignment/);
  const escaped = await f.post(`/api/agent/channels/${f.workerDm.id}/messages`, { body: 'Start more work.', threadId: root, requestId: 'closed-work', executionId }, f.brain.token);
  assert.equal(escaped.status, 409);
  f.choose('brain_one_worker');
  const alsoClosed = await f.post(`/api/agent/channels/${f.workerDm.id}/messages`, { body: 'Start more work.', threadId: root, requestId: 'closed-work-2', executionId }, f.brain.token);
  assert.equal(alsoClosed.status, 409);
});

test('manual Single drain can complete while Jev is disabled; task completion cannot be faked with thread status', async t => {
  const f = fixture(t); f.choose('brain_one_worker'); const started = await f.start();
  const response = await f.post('/api/agent/tasks', { requestId: 'task', worker: f.workers[0]!.agent.name, contract, executionId: started.state.executionId }, f.brain.token);
  assert.equal(response.status, 200); const task = (await response.json() as { task: TaskSnapshot }).task;
  assert.throws(() => f.hive.messages.setThreadStatus(f.human, started.message.id, 'done'), /Finish delegated/);
  f.hive.adaptiveTopology.setLock(f.human, f.dm.id, { scope: 'task', topology: 'single' });
  assert.equal(f.view().state?.desiredTopology, 'single'); await f.settings(false);
  const calls = f.calls();
  const rejected = await f.post(`/api/agent/tasks/${task.id}/events`, { requestId: 'reject', expectedRevision: task.revision, action: { type: 'reject', reason: 'Not needed.' } }, f.workers[0]!.token);
  assert.equal(rejected.status, 200, await rejected.clone().text());
  assert.equal(f.view().state?.currentTopology, 'brain_one_worker', 'Worker events never drive routing, even a drain');
  const checkpoint = await f.post(`/api/agent/channels/${f.dm.id}/messages`, { body: 'The worker declined; continuing locally.', eventType: 'progress', requestId: 'drain-checkpoint' }, f.brain.token);
  assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
  assert.equal(f.view().state?.currentTopology, 'single'); assert.equal(f.calls(), calls);
  f.hive.messages.setThreadStatus(f.human, started.message.id, 'done'); assert.equal(f.view().state?.monitoring, 'completed');
});

test('deleting a project prunes its routing state, locks and audit without leaving stale presence handlers', async t => {
  const f = fixture(t); await f.start('single', 'conversation'); await f.recheck();
  for (const a of [f.brain, ...f.workers]) f.hive.identity.setOffline(a.agent.id);
  await f.hive.adaptiveTopology.stop();
  const other = f.hive.projects.createProject(f.human, { slug: 'other', name: 'Other' }); assert.ok(other);
  f.hive.projects.deleteProject(f.human, 'chapter');
  for (const table of ['adaptive_topology_executions', 'adaptive_topology_events', 'adaptive_topology_locks', 'adaptive_topology_evaluated'])
    assert.equal(countRows(f.hive, table), 0, table);
});

test('zero capacity is signalled without inventing a worker budget and recovers when capacity returns', async t => {
  const f = fixture(t);
  // Use database presence to avoid injecting unrelated background evaluations before initial selection.
  setAgentPresence(f.hive, { role: 'worker' }, { online: false }); f.choose('capacity_blocked');
  const started = await f.start(); assert.equal(started.state.workerBudget, 0); assert.match(started.state.warning ?? '', /no workers/);
  setAgentPresence(f.hive, { role: 'worker' }, { online: true }); f.choose('brain_multi_room'); await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room'); assert.equal(f.view().state?.warning, null);
  assert.equal(readAdaptiveCapacity(f.hive, f.view().state!).workers.free, 3);
});

test('Room can be selected immediately, actual room tasks are admitted, and stopped work does not keep capacity busy', async t => {
  const f = fixture(t); f.choose('brain_multi_room'); const started = await f.start();
  const channel = f.hive.channels.createChannel(f.brain.agent, { name: 'adaptive-room', type: 'private', memberNames: f.workers.slice(0, 2).map(w => w.agent.name) });
  const roomContract = { mode: 'ongoing', purpose: 'Complete this Human request together.', rules: ['Coordinate peer findings here.'], limits: [],
    coordinator: f.brain.agent.name, participants: f.workers.slice(0, 2).map(w => ({ name: w.agent.name, boundary: 'One independent workstream.' })),
    completion: ['All subtasks accepted.'], originTaskId: null };
  const configured = await f.post(`/api/agent/channels/${channel.id}/room`, { requestId: 'configure', expectedRevision: 0,
    humanInstructionSeq: started.message.seq, action: { type: 'configure', contract: roomContract, reason: 'Human request.' }, executionId: started.state.executionId }, f.brain.token);
  assert.equal(configured.status, 200, await configured.clone().text());
  const version = f.hive.rooms.peek(channel.id)!.contractVersion;
  const response = await f.post('/api/agent/tasks', { requestId: 'room-task', worker: f.workers[0]!.agent.name, channel: channel.id,
    contract, room: { contractVersion: version, actionKey: 'work' }, executionId: started.state.executionId }, f.brain.token);
  assert.equal(response.status, 200, await response.clone().text());
  const task = (await response.json() as { task: TaskSnapshot }).task;
  assert.equal(task.room?.channelId, channel.id); assert.equal(readAdaptiveCapacity(f.hive, f.view().state!).activeWorkers, 1);
  f.choose('single');
  const instruction = f.hive.messages.postMessage(f.human, { channel: channel.id, body: 'Stop this distributed work.' });
  const archive = await f.post(`/api/agent/channels/${channel.id}/room`, { requestId: 'archive', expectedRevision: f.hive.rooms.peek(channel.id)!.revision,
    humanInstructionSeq: instruction.seq, action: { type: 'archive', running: 'stop', reason: 'No longer needed.' }, executionId: started.state.executionId }, f.brain.token);
  assert.equal(archive.status, 200, await archive.clone().text());
  const stopped = await f.post(`/api/agent/channels/${channel.id}/room`, { requestId: 'stopped', expectedRevision: f.hive.rooms.peek(channel.id)!.revision,
    action: { type: 'stopped', taskId: task.id, reason: 'Stopped safely.' } }, f.workers[0]!.token);
  assert.equal(stopped.status, 200, await stopped.clone().text());
  await f.recheck(); assert.equal(readAdaptiveCapacity(f.hive, f.view().state!).activeWorkers, 0);
  assert.equal(f.view().state?.currentTopology, 'single');
});

test('duplicate votes do not count twice, capacity races reevaluate, and a rotated key fences old provider results', async t => {
  const f = fixture(t); f.choose('brain_multi_room'); await f.start(); f.choose('single');
  const one = { actorId: f.brain.agent.id, actorRole: 'brain' as const, kind: 'brain_message' as const, channelId: f.dm.id, eventId: 'once' };
  await f.hive.adaptiveTopology.revalidateForActor(f.brain.agent, one); const calls = f.calls();
  await f.hive.adaptiveTopology.revalidateForActor(f.brain.agent, one);
  assert.equal(f.calls(), calls); assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  await f.recheck(); assert.equal(f.view().state?.currentTopology, 'single');
  // Mutate the roster while Jev is answering, without a second unrelated presence event.
  f.choose('brain_multi_room'); f.beforeReply(() => { setAgentPresence(f.hive, f.workers[2]!.agent.id, { online: false }); });
  const raceCalls = f.calls(); await f.recheck(); assert.equal(f.calls(), raceCalls + 2);
  await f.recheck(); assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  const before = f.view().state!.revision;
  f.choose('single'); f.beforeReply(() => { saveAdaptiveRouting(f.dir, { apiKey: 'rotated-fixture-key' }); });
  await f.recheck(); assert.equal(f.view().state?.revision, before); assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
});

test('pending classification drains on stop and cannot publish new audit or topology afterwards', async t => {
  const f = fixture(t); await f.start(); const count = f.view().events.length;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  f.beforeReply(async () => { reached(); await gate; }); f.choose('brain_multi_room');
  const changing = f.recheck(); await started;
  const stop = f.hive.adaptiveTopology.stop(); release(); await changing; await stop;
  assert.equal(f.view().events.length, count); assert.equal(f.view().state?.currentTopology, 'single');
});


test('initial classifier output cannot outlive a settings change or leave a Human message half-committed', async t => {
  const f = fixture(t);
  const before = countRows(f.hive, 'messages');
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { apiKey: 'new-private-key' }); });
  await assert.rejects(f.start(), /settings changed/);
  assert.equal(f.view().state, null);
  assert.equal(countRows(f.hive, 'messages'), before);
  const started = await f.start();
  assert.equal(started.state.currentTopology, 'single');
});
