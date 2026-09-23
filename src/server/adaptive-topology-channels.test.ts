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

const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };

function fixture(t: TestContext, enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-channels-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brains = [0, 1].map(() => hive.join({ role: 'brain', project: 'chapter' }));
  const workers = [0, 1].map(() => hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const app = createApp(hive);
  let target: AdaptiveTopology = 'single', calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    return Response.json(jevTopologyResponse(String(init?.body), target));
  });
  saveAdaptiveRouting(dir, { enabled, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const channel = (name: string, members: string[]) => hive.createChannel(human, { name, type: 'private', project: 'chapter', memberNames: members });
  const send = async (channelId: string, body: Record<string, unknown>) => {
    const response = await app.request(`/api/ui/channels/${channelId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { message: Message; routing: unknown; routingMessages?: Message[];
      adaptiveStates?: Array<{ executionId: string; brainId: string }> };
  };
  return { hive, human, brains, workers, app, channel, send, dir,
    calls: () => calls, choose: (mode: AdaptiveTopology) => { target = mode; } };
}

test('a Human request in a group channel routes to its only brain with a directive addressed to that brain', async t => {
  const f = fixture(t);
  const group = f.channel('planning', [f.brains[0]!.agent.name, f.workers[0]!.agent.name]);
  const routed = await f.send(group.id, { body: 'Plan the release.', requestId: 'group-request' });
  assert.equal(f.calls(), 1);
  assert.equal(routed.adaptiveStates?.length, 1);
  assert.equal(routed.adaptiveStates![0]!.brainId, f.brains[0]!.agent.id);
  const directive = routed.routingMessages![0]!;
  assert.match(directive.body, new RegExp(`Brain: @${f.brains[0]!.agent.name}`));
  assert.match(directive.body, new RegExp(`executionId "${routed.adaptiveStates![0]!.executionId}"`));
  assert.deepEqual(directive.recipientIds, [f.brains[0]!.agent.id], 'Workers in the channel are not addressed by the directive');
  assert.equal(f.hive.isFor(f.workers[0]!.agent, directive), false);
  assert.equal(f.hive.isFor(f.brains[0]!.agent, directive), true);
});

test('several brains: no mention is observed only, mentioned brains each get their own execution', async t => {
  const f = fixture(t);
  const [a, b] = f.brains as [typeof f.brains[0], typeof f.brains[0]];
  const group = f.channel('council', [a.agent.name, b.agent.name]);
  const ambiguous = await f.send(group.id, { body: 'Who can look at this?', requestId: 'ambiguous' });
  assert.equal(ambiguous.routing, null);
  assert.equal(f.calls(), 1, 'Jev still classifies the request');
  const observed = f.hive.adaptiveTopology.view(f.human, group.id);
  assert.equal(observed.state, null);
  assert.equal(observed.events.at(-1)?.kind, 'observation');
  const explicit = await f.app.request(`/api/ui/channels/${group.id}/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Do it alone.', routing: 'single', requestId: 'ambiguous-lock' }) });
  assert.equal(explicit.status, 400, 'An explicit mode needs a named owner');

  const both = await f.send(group.id, { body: `@${a.agent.name} @${b.agent.name} review both halves.`, requestId: 'both' });
  assert.equal(f.calls(), 3, 'One classification per mentioned brain');
  assert.deepEqual(new Set(both.adaptiveStates!.map(state => state.brainId)), new Set([a.agent.id, b.agent.id]));
  assert.equal(both.routingMessages?.length, 2);
  const view = f.hive.adaptiveTopology.view(f.human, group.id);
  assert.equal(view.executions?.length, 2);
  assert.ok(view.executions!.every(state => state.rootMessageId === both.message.id));

  // A request to one brain replaces only that brain's execution in this channel.
  const onlyA = await f.send(group.id, { body: `@${a.agent.name} follow up.`, requestId: 'only-a' });
  const after = f.hive.adaptiveTopology.view(f.human, group.id).executions!;
  const stateA = after.find(state => state.brainId === a.agent.id)!, stateB = after.find(state => state.brainId === b.agent.id)!;
  assert.equal(stateA.executionId, onlyA.adaptiveStates![0]!.executionId);
  assert.equal(stateB.rootMessageId, both.message.id);
  assert.equal(stateB.completedAt ?? null, null);
});

test('Human replies revalidate, reopen or start the execution of their thread', async t => {
  const f = fixture(t);
  const brain = f.brains[0]!;
  const dm = f.hive.openDm(f.human, brain.agent.name);
  const request = await f.send(dm.id, { body: 'Summarize the incident.', requestId: 'request' });
  const executionId = request.adaptiveStates![0]!.executionId;

  await f.send(dm.id, { body: 'Include the timeline.', threadId: request.message.id, requestId: 'reply-1' });
  assert.equal(f.calls(), 2);
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.executionId, executionId);

  f.hive.setThreadStatus(brain.agent, request.message.id, 'done');
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.monitoring, 'completed');
  await f.send(dm.id, { body: 'One more thing.', threadId: request.message.id, requestId: 'reply-2' });
  const reopened = f.hive.adaptiveTopology.view(f.human, dm.id);
  assert.equal(reopened.state?.executionId, executionId, 'A reply reopens the completed execution of its thread');
  assert.equal(reopened.state?.completedAt, null);
  assert.equal(f.hive.db.prepare('SELECT status FROM threads WHERE id=?').get(request.message.id)?.status, 'open');
  assert.equal(f.calls(), 3);

  // A thread without its own execution, after the brain's execution was superseded, starts a new one there.
  const brainNote = f.hive.postMessage(brain.agent, { channel: dm.id, body: 'Background notes.' });
  const second = await f.send(dm.id, { body: 'New topic.', requestId: 'second-root' });
  f.hive.setThreadStatus(f.human, second.message.id, 'done');
  const started = await f.send(dm.id, { body: 'Please act on these notes.', threadId: brainNote.id, requestId: 'reply-3' });
  assert.equal(started.adaptiveStates?.length, 1);
  assert.equal(started.routingMessages![0]!.threadId, brainNote.id, 'The directive precedes the reply in its thread');
  const fresh = f.hive.adaptiveTopology.view(f.human, dm.id).state!;
  assert.equal(fresh.rootMessageId, brainNote.id);
  assert.equal(fresh.executionId, started.adaptiveStates![0]!.executionId);
});

test('messages without a brain and worker activity never call Jev', async t => {
  const f = fixture(t);
  const workerDm = f.hive.openDm(f.human, f.workers[0]!.agent.name);
  const direct = await f.send(workerDm.id, { body: 'Quick question for you.', requestId: 'to-worker' });
  assert.equal(direct.routing, null);
  assert.equal(f.calls(), 0);

  f.choose('brain_one_worker');
  const brain = f.brains[0]!;
  const dm = f.hive.openDm(f.human, brain.agent.name);
  const request = await f.send(dm.id, { body: 'Delegate this.', requestId: 'delegate' });
  const assigned = await f.app.request('/api/agent/tasks', { method: 'POST', headers: { authorization: `Bearer ${brain.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'task', worker: f.workers[0]!.agent.name, contract,
    executionId: request.adaptiveStates![0]!.executionId }) });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const task = (await assigned.json() as { task: TaskSnapshot }).task;
  const before = f.calls();
  const accepted = await f.app.request(`/api/agent/tasks/${task.id}/events`, { method: 'POST', headers: { authorization: `Bearer ${f.workers[0]!.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'accept', expectedRevision: task.revision, action: { type: 'accept' } }) });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const reply = await f.app.request(`/api/agent/channels/${task.channelId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${f.workers[0]!.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ body: 'Working on it.', threadId: task.id, requestId: 'worker-reply' }) });
  assert.equal(reply.status, 200, await reply.clone().text());
  f.hive.setOffline(f.workers[1]!.agent.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), before, 'Worker lifecycle, messages and presence are not classified');
  const declared = await f.app.request(`/api/agent/channels/${task.channelId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${f.workers[0]!.token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ body: 'x', requestId: 'worker-exec', executionId: request.adaptiveStates![0]!.executionId }) });
  assert.equal(declared.status, 400);
});

test('legacy channel-keyed executions and locks migrate to per-brain keys', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hive.db');
  let hive = new Hive(file);
  const human = hive.getAgent('human'), brain = hive.join({ role: 'brain', project: 'chapter' });
  const dm = hive.openDm(human, brain.agent.name);
  const root = hive.postMessage(human, { channel: dm.id, body: 'Legacy request.' });
  const snapshot = JSON.stringify({ executionId: 'execution-legacy', channelId: dm.id, projectId: dm.projectId, brainId: brain.agent.id,
    rootMessageId: root.id, currentTopology: 'single', workerBudget: 0, desiredTopology: null, desiredWorkers: null, lockScope: 'conversation',
    lockedTopology: 'single', orchestratedOnly: false, providerAvailable: false, warning: null, recommendation: null, confirmations: 0,
    confirmationTopology: null, confirmationWorkers: null, eventsSinceChange: 0, updatedAt: 1, recentEvents: [], revision: 1, completedAt: null });
  hive.db.exec(`DROP TRIGGER adaptive_channel_deleted; DROP TABLE adaptive_topology_executions; DROP TABLE adaptive_topology_locks;
    CREATE TABLE adaptive_topology_executions (channel_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      brain_id TEXT NOT NULL, root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE adaptive_topology_locks (channel_id TEXT PRIMARY KEY, topology TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  hive.db.prepare('INSERT INTO adaptive_topology_executions VALUES(?,?,?,?,?,?)').run(dm.id, 'execution-legacy', dm.projectId, brain.agent.id, root.id, snapshot);
  hive.db.prepare('INSERT INTO adaptive_topology_locks VALUES(?,?,?)').run(dm.id, 'single', 1);
  await hive.adaptiveTopology.stop(); hive.db.close();

  hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); });
  const keys = (table: string) => hive.db.prepare(`PRAGMA table_info(${table})`).all().filter(c => Number(c.pk) > 0).map(c => String(c.name));
  assert.deepEqual(keys('adaptive_topology_executions'), ['channel_id', 'brain_id']);
  assert.deepEqual(keys('adaptive_topology_locks'), ['channel_id', 'brain_id']);
  assert.equal(hive.db.prepare('SELECT brain_id FROM adaptive_topology_locks WHERE channel_id=?').get(dm.id)?.brain_id, brain.agent.id);
  assert.equal(hive.adaptiveTopology.view(human, dm.id).state?.executionId, 'execution-legacy');
  assert.equal(hive.adaptiveTopology.forAgent(hive.getAgent(brain.agent.id))?.executionId, 'execution-legacy');
  assert.ok(hive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='adaptive_channel_deleted'").get(), 'Deletion cleanup survives the migration');
});
