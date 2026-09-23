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
import { TelegramBridge, telegramConfigKey } from './telegram.ts';
import type { AdaptiveExecutionState, AdaptiveTopology } from '../shared/adaptive-topology.ts';

type Stored = { completedAt?: number | null; supersededBy?: string | null; revision?: number };
/** Reads the stored snapshot, including executions already dropped from the Human panel view. */
function stored(hive: Hive, executionId: string): Stored | undefined {
  const row = hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE execution_id=?').get(executionId);
  return row ? JSON.parse(String(row.snapshot)) as Stored : undefined;
}

// Execution lifecycle: a new Human request never waits for, nor strands, the previous request's delegated work.
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-drain-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' });
  const workers = [0, 1].map(() => hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const dm = hive.openDm(human, brain.agent.name), workerDm = hive.openDm(brain.agent, workers[0]!.agent.name);
  const app = createApp(hive);
  let target: AdaptiveTopology = 'brain_one_worker', serial = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    return Response.json(jevTopologyResponse(String(init?.body), target));
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (route: string, body: unknown, token?: string) => app.request(route, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  const start = async (body = 'Execute the Human request.', source?: 'telegram') => {
    const value = await hive.adaptiveTopology.routeHumanRequest(human,
      { channel: dm.id, body, requestId: `human-${++serial}`, source }, 'auto', 'none');
    assert.ok(value); return value;
  };
  /** Free-form brain→worker delegation tracked in adaptive_topology_messages. */
  const delegate = async (executionId: string, key = `delegate-${++serial}`) => {
    const sent = await post(`/api/agent/channels/${workerDm.id}/messages`,
      { body: 'Investigate this and report back.', requestId: key, executionId }, brain.token);
    assert.equal(sent.status, 200, await sent.clone().text());
    return (await sent.json() as { id: string }).id;
  };
  const reply = (root: string, body: unknown) => post(`/api/agent/channels/${workerDm.id}/messages`,
    { body: 'Done.', threadId: root, requestId: `reply-${++serial}`, ...body as object }, workers[0]!.token);
  const execution = (executionId: string) => stored(hive, executionId);
  const commitments = () => Number(hive.db.prepare('SELECT COUNT(*) AS n FROM adaptive_topology_messages').get()!.n);
  const settings = async (enabled: boolean) => {
    const response = await app.request('/api/ui/adaptive-routing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  return { hive, human, brain, workers, dm, workerDm, app, post, start, delegate, reply, execution, commitments, settings,
    choose: (mode: AdaptiveTopology) => { target = mode; } };
}

test('capacity ignores free-form commitments of completed or deleted executions', async t => {
  const f = fixture(t); const started = await f.start();
  await f.delegate(started.state.executionId);
  const other = { projectId: f.dm.projectId, executionId: 'execution-other' };
  assert.equal(readAdaptiveCapacity(f.hive, other).workers.busyOther, 1, 'a live execution keeps its worker');
  const completed = { ...JSON.parse(String(f.hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE execution_id=?')
    .get(started.state.executionId)!.snapshot)), completedAt: Date.now() };
  f.hive.db.prepare('UPDATE adaptive_topology_executions SET snapshot=? WHERE execution_id=?').run(JSON.stringify(completed), started.state.executionId);
  assert.equal(readAdaptiveCapacity(f.hive, other).workers.busyOther, 0, 'a completed execution releases its worker');
  f.hive.db.prepare('DELETE FROM adaptive_topology_executions WHERE execution_id=?').run(started.state.executionId);
  assert.equal(readAdaptiveCapacity(f.hive, other).workers.busyOther, 0, 'a missing execution releases its worker');
});

test('an unrouted Human request drains, not strands, the previous execution with delegated work', async t => {
  const f = fixture(t); const original = await f.start();
  const root = await f.delegate(original.state.executionId);
  await f.settings(false);
  const legacy = await f.post(`/api/ui/channels/${f.dm.id}/messages`, { body: 'Unrouted request.', requestId: 'legacy' });
  assert.equal(legacy.status, 200);
  assert.equal(f.execution(original.state.executionId)?.completedAt, null, 'delegated work keeps the old execution alive');
  await f.settings(true);
  const next = await f.start();
  const capacity = () => readAdaptiveCapacity(f.hive, next.state);
  assert.equal(capacity().workers.busyOther, 1, 'the worker is still committed to the draining execution');
  assert.equal((await f.reply(root, { eventType: 'decision' })).status, 200);
  assert.ok(f.execution(original.state.executionId)?.completedAt, 'the drained execution completes by itself');
  assert.equal(capacity().workers.busyOther, 0);
  assert.equal(capacity().workers.free, 2);
});

test('a new Human request with open free-form delegation starts a new execution beside the draining one', async t => {
  const f = fixture(t); const original = await f.start();
  const root = await f.delegate(original.state.executionId);
  const published: Array<{ state: AdaptiveExecutionState | null; event: { reason: string } }> = [];
  const listener = (payload: typeof published[number]) => published.push(payload);
  f.hive.bus.on('adaptive-routing', listener); t.after(() => f.hive.bus.off('adaptive-routing', listener));
  const next = await f.start('A different follow-up request.');
  assert.notEqual(next.state.executionId, original.state.executionId);
  assert.equal(next.routing.providerStatus, 'ok', 'the new request gets its own initial Jev classification');
  assert.match(next.routingMessage!.body, new RegExp(next.state.executionId));
  const old = f.execution(original.state.executionId);
  assert.equal(old?.completedAt, null); assert.equal(old?.supersededBy, next.state.executionId);
  const panel = f.hive.adaptiveTopology.view(f.human, f.dm.id);
  assert.equal(panel.state?.executionId, next.state.executionId, 'the panel leads with the current request');
  assert.equal(panel.state?.current, true);
  const draining = panel.executions?.find(item => item.executionId === original.state.executionId);
  assert.deepEqual(panel.executions?.map(item => [item.executionId, item.current]),
    [[original.state.executionId, false], [next.state.executionId, true]], 'the draining execution is listed beside the current one');
  assert.equal(draining?.requestExcerpt, 'Execute the Human request.');
  assert.deepEqual(draining?.openWork, { tasks: 0, delegations: 1 });
  assert.equal(panel.executions?.find(item => item.current)?.openWork, undefined, 'open work is reported for draining executions only');
  const retired = published.find(item => item.event.reason === 'superseded_draining_delegated_work');
  assert.equal(retired?.state?.executionId, original.state.executionId, 'the draining execution publishes its own state');
  assert.equal(retired?.state?.current, false);
  assert.deepEqual(retired?.state?.openWork, { tasks: 0, delegations: 1 });
  assert.ok(panel.events.some(event => event.executionId === original.state.executionId && event.reason === 'superseded_draining_delegated_work'));
  // Both executions bind the brain; the old executionId stays valid for its own work.
  assert.deepEqual(f.hive.adaptiveTopology.policiesFor(f.brain.agent).map(policy => policy.executionId).sort(),
    [original.state.executionId, next.state.executionId].sort());
  assert.equal(f.hive.adaptiveTopology.forAgent(f.brain.agent, original.state.executionId)?.executionId, original.state.executionId);
  const followUp = await f.post(`/api/agent/channels/${f.workerDm.id}/messages`, { body: 'One more detail.', threadId: root, requestId: 'follow' }, f.brain.token);
  assert.equal(followUp.status, 200, await followUp.clone().text());
  assert.equal(readAdaptiveCapacity(f.hive, next.state).workers.busyOther, 1);
  // A bare acknowledgement only confirms receipt; the report of the outcome ends the delegation.
  assert.equal((await f.reply(root, { eventType: 'acknowledgement' })).status, 200);
  assert.equal(f.commitments(), 1); assert.equal(f.execution(original.state.executionId)?.completedAt, null);
  assert.equal((await f.reply(root, { eventType: 'decision' })).status, 200);
  assert.equal(f.commitments(), 0);
  assert.ok(f.execution(original.state.executionId)?.completedAt);
  const drained = published.find(item => item.event.reason === 'delegated_work_drained');
  assert.equal(drained?.state?.current, false); assert.ok(drained?.state?.completedAt);
  assert.equal(drained?.state?.openWork, undefined);
  assert.equal(f.hive.adaptiveTopology.view(f.human, f.dm.id).state?.executionId, next.state.executionId);
  assert.equal(f.hive.adaptiveTopology.forAgent(f.brain.agent)?.executionId, next.state.executionId);
  assert.equal(f.execution(next.state.executionId)?.completedAt, null, 'the current execution is untouched');
  // The finished predecessor is dropped on the brain's next request, as replaced executions always were.
  await f.start('Third request.');
  assert.equal(f.execution(original.state.executionId), undefined);
});

test('an acknowledgement with evidence ends the delegation; a closed thread does too', async t => {
  const f = fixture(t); const original = await f.start();
  const first = await f.delegate(original.state.executionId);
  await f.start('Next request.');
  const file = await f.hive.createFile(f.workers[0]!.agent, { name: 'report.txt', mime: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('fixture evidence')); controller.close(); } }) });
  assert.equal((await f.reply(first, { eventType: 'acknowledgement', attachmentIds: [file.id] })).status, 200);
  assert.equal(f.commitments(), 0);
  assert.ok(f.execution(original.state.executionId)?.completedAt);

  const again = await f.start('Delegate once more.');
  const second = await f.delegate(again.state.executionId);
  const latest = await f.start('And another request.');
  assert.equal(f.execution(again.state.executionId)?.completedAt, null);
  const closed = await f.post(`/api/agent/threads/${second}/status`, { status: 'done' }, f.brain.token);
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.ok(f.execution(again.state.executionId)?.completedAt);
  assert.equal(readAdaptiveCapacity(f.hive, latest.state).workers.free, 2);
});

test('Human completes a request with open free-form delegation, releasing it with an audit warning', async t => {
  const f = fixture(t); const started = await f.start();
  await f.delegate(started.state.executionId);
  assert.throws(() => f.hive.setThreadStatus(f.brain.agent, started.message.id, 'done'), /Finish delegated/, 'the brain still closes its own work first');
  f.hive.setThreadStatus(f.human, started.message.id, 'done');
  assert.ok(f.execution(started.state.executionId)?.completedAt);
  assert.equal(f.commitments(), 0);
  const events = f.hive.adaptiveTopology.view(f.human, f.dm.id).events;
  assert.match(events.at(-1)?.warning ?? '', /released 1 open delegation/);
  assert.equal(readAdaptiveCapacity(f.hive, { projectId: f.dm.projectId, executionId: 'execution-other' }).workers.free, 2);
});

test('several owning brains are classified in parallel, for a new request and for a thread reply', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-parallel-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brains = [0, 1].map(() => hive.join({ role: 'brain', project: 'chapter' }).agent);
  const channel = hive.createChannel(human, { name: 'pair', type: 'private', project: 'chapter', memberNames: brains.map(brain => brain.name) });
  let inFlight = 0, peak = 0, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++; peak = Math.max(peak, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 30));
    inFlight--;
    return Response.json(jevTopologyResponse(String(init?.body), 'single'));
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const started = await hive.adaptiveTopology.routeHumanRequest(human,
    { channel: channel.id, body: `@${brains[0]!.name} @${brains[1]!.name} split this.`, requestId: 'pair' }, 'auto', 'none');
  assert.equal(started?.states.length, 2);
  assert.equal(calls, 2); assert.equal(peak, 2, 'both initial classifications were in flight together');
  peak = 0; calls = 0;
  const replied = await hive.adaptiveTopology.routeHumanRequest(human,
    { channel: channel.id, body: 'More context.', threadId: started!.message.id, requestId: 'pair-reply' }, 'auto', 'none');
  assert.equal(replied, null, 'the reply revalidates in place');
  assert.equal(calls, 2); assert.equal(peak, 2, 'both revalidations were in flight together');
  for (const state of started!.states)
    assert.equal(stored(hive, state.executionId)?.revision, (state.revision ?? 0) + 1);
});

test('a Telegram request to a brain with open delegation is delivered, not retried into quarantine', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-telegram-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' }), worker = hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.openDm(human, brain.agent.name), workerDm = hive.openDm(brain.agent, worker.agent.name);
  const cfg = { botToken: 'fixture', botId: 77, allowUserIds: [1], groups: { chapter: -1001 } };
  const bridge = new TelegramBridge(hive, cfg);
  hive.db.prepare('INSERT INTO telegram_topics(channel_id,telegram_thread_id,telegram_chat_id,bot_key) VALUES(?,?,?,?)').run(dm.id, 22, -1001, telegramConfigKey(cfg));
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === 'https://api.typesafe.ai/v1/systemone') return Response.json(jevTopologyResponse(String(init?.body), 'brain_one_worker'));
    if (String(url).endsWith('/getUpdates') && ++polls === 1) return Response.json({ ok: true, result: [{ update_id: 901,
      message: { message_id: 88, message_thread_id: 22, chat: { id: -1001 }, from: { id: 1, first_name: 'Matteo' }, text: 'New request from Telegram' } }] });
    if (String(url).endsWith('/getUpdates')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    return Response.json({ ok: true, result: { message_id: 999 } });
  });
  t.after(async () => { await bridge.stop(); await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const original = await hive.adaptiveTopology.routeHumanRequest(human, { channel: dm.id, body: 'First request.', requestId: 'first' }, 'auto', 'none');
  const sent = await createApp(hive).request(`/api/agent/channels/${workerDm.id}/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${brain.token}` },
    body: JSON.stringify({ body: 'Investigate.', requestId: 'delegate', executionId: original!.state.executionId }) });
  assert.equal(sent.status, 200, await sent.clone().text());
  bridge.start();
  const delivered = () => hive.listMessages(human, dm.id).messages.some(message => message.body.endsWith('New request from Telegram'));
  for (let i = 0; i < 5000 && !delivered(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(delivered());
  assert.equal(hive.telegramFailureCount(), 0);
  const view = hive.adaptiveTopology.view(human, dm.id);
  assert.notEqual(view.state?.executionId, original!.state.executionId);
  assert.equal(stored(hive, original!.state.executionId)?.completedAt, null);
});

test('structured task work still drains: the old execution stays alive while its task is open', async t => {
  const f = fixture(t); const original = await f.start();
  const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };
  const assigned = await f.post('/api/agent/tasks', { requestId: 'task', worker: f.workers[0]!.agent.name, contract, executionId: original.state.executionId }, f.brain.token);
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const next = await f.start('Unrelated follow-up.');
  assert.equal(f.execution(original.state.executionId)?.completedAt, null);
  assert.equal(f.execution(original.state.executionId)?.supersededBy, next.state.executionId);
  assert.throws(() => f.hive.setThreadStatus(f.human, original.message.id, 'done'), /Finish delegated/, 'structured tasks keep their own lifecycle');
});
