import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { Message } from '../shared/types.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import { insertRow, markLegacyStorage, readValue } from './test-fixtures.ts';

const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };

function fixture(t: TestContext, enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-channels-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brains = [0, 1].map(() => hive.identity.join({ role: 'brain', project: 'chapter' }));
  const workers = [0, 1].map(() => hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const app = createApp(hive);
  let target: AdaptiveTopology = 'single', calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    return Response.json(jevTopologyResponse(String(init?.body), target));
  });
  saveAdaptiveRouting(dir, { enabled, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const channel = (name: string, members: string[]) => hive.channels.createChannel(human, { name, type: 'private', project: 'chapter', memberNames: members });
  const send = async (channelId: string, body: Record<string, unknown>) => {
    const response = await app.request(`/api/ui/channels/${channelId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { message: Message; adaptiveStates?: Array<{ executionId: string; brainId: string }> };
  };
  return { hive, human, brains, workers, app, channel, send, dir,
    calls: () => calls, choose: (mode: AdaptiveTopology) => { target = mode; } };
}

test('a Human request in a group channel is classified for its only brain; nothing is posted besides it', async t => {
  const f = fixture(t);
  const group = f.channel('planning', [f.brains[0]!.agent.name, f.workers[0]!.agent.name]);
  const routed = await f.send(group.id, { body: 'Plan the release.', requestId: 'group-request' });
  assert.equal(f.calls(), 1);
  assert.equal(routed.adaptiveStates?.length, 1);
  assert.equal(routed.adaptiveStates![0]!.brainId, f.brains[0]!.agent.id);
  const messages = f.hive.messageQueries.listMessages(f.human, group.id).messages.filter(message => message.kind === 'chat');
  assert.deepEqual(messages.map(message => message.body), ['Plan the release.'], 'no directive message (#211)');
});

test('several brains: no mention is observed only, mentioned brains each get their own execution', async t => {
  const f = fixture(t);
  const [a, b] = f.brains as [typeof f.brains[0], typeof f.brains[0]];
  const group = f.channel('council', [a.agent.name, b.agent.name]);
  const ambiguous = await f.send(group.id, { body: 'Who can look at this?', requestId: 'ambiguous' });
  assert.equal(ambiguous.adaptiveStates, undefined);
  assert.equal(f.calls(), 1, 'Jev still classifies the request');
  const observed = f.hive.adaptiveTopology.view(f.human, group.id);
  assert.equal(observed.state, null);
  assert.equal(observed.events.at(-1)?.kind, 'observation');
  assert.equal(f.hive.adaptiveTopology.observations.jevCalls.view(group.projectId).requests[0]!.calls[0]!.phase, 'observation');

  const both = await f.send(group.id, { body: `@${a.agent.name} @${b.agent.name} review both halves.`, requestId: 'both' });
  assert.equal(f.calls(), 3, 'One classification per mentioned brain');
  assert.deepEqual(new Set(both.adaptiveStates!.map(state => state.brainId)), new Set([a.agent.id, b.agent.id]));
  const view = f.hive.adaptiveTopology.view(f.human, group.id);
  assert.equal(view.executions?.length, 2);
  assert.ok(view.executions!.every(state => state.rootMessageId === both.message.id));

  // A request to one brain replaces only that brain's execution in this channel.
  const onlyA = await f.send(group.id, { body: `@${a.agent.name} follow up.`, requestId: 'only-a' });
  const after = f.hive.adaptiveTopology.view(f.human, group.id).executions!;
  assert.equal(after.length, 2);
  const stateA = after.find(state => state.brainId === a.agent.id)!, stateB = after.find(state => state.brainId === b.agent.id)!;
  assert.equal(stateA.executionId, onlyA.adaptiveStates![0]!.executionId);
  assert.equal(stateB.rootMessageId, both.message.id);
  assert.equal(stateB.completedAt ?? null, null);
});

test('Human replies continue, reopen or start the execution of their thread', async t => {
  const f = fixture(t);
  const brain = f.brains[0]!;
  const dm = f.hive.channels.openDm(f.human, brain.agent.name);
  const request = await f.send(dm.id, { body: 'Summarize the incident.', requestId: 'request' });
  const executionId = request.adaptiveStates![0]!.executionId;

  await f.send(dm.id, { body: 'Include the timeline.', threadId: request.message.id, requestId: 'reply-1' });
  assert.equal(f.calls(), 2);
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.executionId, executionId);
  const log = f.hive.adaptiveTopology.observations.jevCalls.view(dm.projectId).requests;
  assert.deepEqual(log.map(group => group.callCount), [2], 'a reply is grouped with its request');
  assert.deepEqual(log[0]!.calls.map(call => call.trigger.kind), ['human_request', 'human_message']);

  f.hive.messages.setThreadStatus(brain.agent, request.message.id, 'done');
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.monitoring, 'completed');
  await f.send(dm.id, { body: 'One more thing.', threadId: request.message.id, requestId: 'reply-2' });
  const reopened = f.hive.adaptiveTopology.view(f.human, dm.id);
  assert.equal(reopened.state?.executionId, executionId, 'A reply reopens the completed execution of its thread');
  assert.equal(reopened.state?.completedAt, null);
  assert.equal(f.calls(), 3);

  // A reply in a thread without its own execution starts a new request there.
  const brainNote = f.hive.messages.postMessage(brain.agent, { channel: dm.id, body: 'Background notes.' });
  const started = await f.send(dm.id, { body: 'Please act on these notes.', threadId: brainNote.id, requestId: 'reply-3' });
  assert.equal(started.adaptiveStates?.length, 1);
  const fresh = f.hive.adaptiveTopology.view(f.human, dm.id).state!;
  assert.equal(fresh.rootMessageId, brainNote.id);
  assert.equal(fresh.executionId, started.adaptiveStates![0]!.executionId);
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).executions!.length, 1, 'the newer request replaces the older one');
});

test('messages without a brain and worker activity never call Jev', async t => {
  const f = fixture(t);
  const workerDm = f.hive.channels.openDm(f.human, f.workers[0]!.agent.name);
  const direct = await f.send(workerDm.id, { body: 'Quick question for you.', requestId: 'to-worker' });
  assert.equal(direct.adaptiveStates, undefined);
  assert.equal(f.calls(), 0);

  f.choose('brain_one_worker');
  const brain = f.brains[0]!;
  const dm = f.hive.channels.openDm(f.human, brain.agent.name);
  await f.send(dm.id, { body: 'Delegate this.', requestId: 'delegate' });
  const assigned = await f.app.request('/api/agent/tasks', { method: 'POST', headers: { authorization: `Bearer ${brain.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'task', worker: f.workers[0]!.agent.name, contract }) });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const task = (await assigned.json() as { task: TaskSnapshot }).task;
  const before = f.calls();
  const accepted = await f.app.request(`/api/agent/tasks/${task.id}/events`, { method: 'POST', headers: { authorization: `Bearer ${f.workers[0]!.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'accept', expectedRevision: task.revision, action: { type: 'accept' } }) });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const reply = await f.app.request(`/api/agent/channels/${task.channelId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${f.workers[0]!.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ body: 'Working on it.', threadId: task.id, requestId: 'worker-reply' }) });
  assert.equal(reply.status, 200, await reply.clone().text());
  f.hive.identity.setOffline(f.workers[1]!.agent.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), before, 'Worker lifecycle, messages and presence are not classified');
});

test('legacy channel-keyed executions migrate through to the advisory schema; their locks are dropped', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hive.db');
  let hive = new Hive(file);
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain', project: 'chapter' });
  const dm = hive.channels.openDm(human, brain.agent.name);
  const root = hive.messages.postMessage(human, { channel: dm.id, body: 'Legacy request.' });
  const snapshot = JSON.stringify({ executionId: 'execution-legacy', channelId: dm.id, projectId: dm.projectId, brainId: brain.agent.id,
    rootMessageId: root.id, currentTopology: 'single', workerBudget: 0, desiredTopology: null, desiredWorkers: null, lockScope: 'conversation',
    lockedTopology: 'single', orchestratedOnly: false, providerAvailable: false, warning: null, recommendation: null, confirmations: 0,
    confirmationTopology: null, confirmationWorkers: null, eventsSinceChange: 0, updatedAt: 1, recentEvents: [], revision: 1, completedAt: null });
  // schema-level assertion: recreate the legacy per-channel tables before the migration runs.
  hive.db.exec(`DROP TRIGGER adaptive_channel_deleted; DROP TABLE adaptive_topology_executions; DROP TABLE IF EXISTS adaptive_topology_locks;
    CREATE TABLE adaptive_topology_executions (channel_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      brain_id TEXT NOT NULL, root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE adaptive_topology_locks (channel_id TEXT PRIMARY KEY, topology TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  insertRow(hive, 'adaptive_topology_executions', { channel_id: dm.id, execution_id: 'execution-legacy', project_id: dm.projectId,
    brain_id: brain.agent.id, root_message_id: root.id, snapshot });
  insertRow(hive, 'adaptive_topology_locks', { channel_id: dm.id, topology: 'single', updated_at: 1 });
  markLegacyStorage(hive); await hive.adaptiveTopology.stop(); hive.db.close();

  hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); });
  // schema-level assertion: primary keys and cleanup trigger after the baseline and the advisory migration (#211).
  const keys = (table: string) => hive.db.prepare(`PRAGMA table_info(${table})`).all().filter(c => Number(c.pk) > 0).map(c => String(c.name));
  assert.deepEqual(keys('adaptive_topology_executions'), ['execution_id']);
  assert.equal(readValue(hive, 'adaptive_topology_executions', 'brain_id', { execution_id: 'execution-legacy' }), brain.agent.id);
  assert.deepEqual(keys('adaptive_topology_locks'), [], 'conversation locks are dropped');
  const state = hive.adaptiveTopology.view(human, dm.id).state!;
  assert.equal(state.executionId, 'execution-legacy');
  assert.equal('lockedTopology' in state || 'currentTopology' in state, false, 'enforcement fields are stripped');
  assert.ok(hive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='adaptive_channel_deleted'").get(), 'Deletion cleanup survives the migration');
});

test('per-brain executions migrate to execution keys and keep their request', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-migrate-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hive.db');
  let hive = new Hive(file);
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain', project: 'chapter' });
  const dm = hive.channels.openDm(human, brain.agent.name);
  const root = hive.messages.postMessage(human, { channel: dm.id, body: 'Per-brain request.' });
  const snapshot = JSON.stringify({ executionId: 'execution-v2', channelId: dm.id, projectId: dm.projectId, brainId: brain.agent.id,
    rootMessageId: root.id, currentTopology: 'single', workerBudget: 0, desiredTopology: null, desiredWorkers: null, lockScope: 'task',
    lockedTopology: 'single', orchestratedOnly: false, providerAvailable: false, warning: null, recommendation: null, confirmations: 0,
    confirmationTopology: null, confirmationWorkers: null, eventsSinceChange: 0, updatedAt: 1, recentEvents: [], revision: 1, completedAt: null });
  // schema-level assertion: recreate the per-brain v2 table before the migration runs.
  hive.db.exec(`DROP TRIGGER adaptive_channel_deleted; DROP TABLE adaptive_topology_executions;
    CREATE TABLE adaptive_topology_executions (channel_id TEXT NOT NULL, brain_id TEXT NOT NULL, execution_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL, root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(channel_id,brain_id));`);
  insertRow(hive, 'adaptive_topology_executions', { channel_id: dm.id, brain_id: brain.agent.id, execution_id: 'execution-v2',
    project_id: dm.projectId, root_message_id: root.id, snapshot });
  markLegacyStorage(hive); await hive.adaptiveTopology.stop(); hive.db.close();

  hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); });
  // schema-level assertion: execution key and cleanup trigger after migration; the drain-era `current` index is gone.
  const keys = hive.db.prepare('PRAGMA table_info(adaptive_topology_executions)').all().filter(c => Number(c.pk) > 0).map(c => String(c.name));
  assert.deepEqual(keys, ['execution_id']);
  assert.equal(hive.adaptiveTopology.view(human, dm.id).state?.executionId, 'execution-v2');
  assert.equal(hive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_adaptive_topology_current'").get(), undefined);
  assert.ok(hive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='adaptive_channel_deleted'").get());
});
