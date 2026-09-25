import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { EXECUTION_IDLE_MS } from './adaptive-topology.ts';
import { contradictoryJevAnswer, jevTopologyResponse } from './fixtures/jev-topology.ts';
import { countRows } from './test-fixtures.ts';
import { JEV_ADVICE_NOTE, type AdaptiveTopology, type JevAdvice } from '../shared/adaptive-topology.ts';
import type { Message } from '../shared/types.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import type { RoomContract } from '../shared/rooms.ts';

// #211: Jev is a non-binding advisor; nothing is blocked, reshaped or enforced, and workers never trigger Jev.
// #214: a Human send never waits on Jev (advice arrives in the background), advice follows the thread or channel only,
// a wait never calls Jev, and a disabled Jev makes no call and adds nothing to any response.
const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };
type Advised = { jevAdvice?: JevAdvice | null };

function fixture(t: TestContext, options: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-advisory-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'acme' });
  const workers = [0, 1].map(() => hive.identity.join({ role: 'worker', seniority: 'senior', project: 'acme' }));
  const app = createApp(hive);
  let target: AdaptiveTopology = 'single', workersAdvised = 0, calls = 0;
  let failure: 'none' | 'http' | 'network' = 'none';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (failure === 'http') return new Response('down', { status: 503 });
    if (failure === 'network') throw new TypeError('fetch failed');
    return Response.json(jevTopologyResponse(String(init?.body), target, workersAdvised || undefined, 0.72));
  });
  saveAdaptiveRouting(dir, { enabled: options.enabled ?? true, apiKey: 'fixture-key' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const humanSend = async (channelId: string, body: Record<string, unknown>) => {
    const response = await app.request(`/api/ui/channels/${channelId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> & { message: Message } };
  };
  /** A Human send followed by the background advice it starts. */
  const humanRequest = async (channelId: string, body: Record<string, unknown>) => {
    const sent = await humanSend(channelId, body);
    await hive.adaptiveTopology.settled();
    return sent;
  };
  const agent = async <T = Record<string, unknown>>(token: string, method: string, url: string, body?: unknown) => {
    const response = await app.request(`/api/agent${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as T & Advised;
  };
  const view = (channelId: string) => hive.adaptiveTopology.view(human, channelId);
  /** A channel where the brain can assign work to the first worker. */
  const team = () => hive.channels.createChannel(human, { name: `team-${randomUUID().slice(0, 8)}`, type: 'private', project: 'acme',
    memberNames: [brain.agent.name, workers[0]!.agent.name] });
  return { dir, hive, human, brain, workers, app, humanSend, humanRequest, agent, view, team, calls: () => calls,
    advise: (topology: AdaptiveTopology, n = 0) => { target = topology; workersAdvised = n; },
    fail: (mode: typeof failure) => { failure = mode; } };
}

function assertAdvice(advice: JevAdvice | null | undefined, expected: Partial<JevAdvice>) {
  assert.ok(advice, 'the response carries jevAdvice');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(advice[key as keyof JevAdvice], value, key);
  assert.equal(advice.note, JEV_ADVICE_NOTE);
  assert.equal(typeof advice.at, 'number');
}
const noAdvice = (result: object, label: string) => assert.equal('jevAdvice' in result, false, label);
/** A provider that answers only when released (or aborts with the hive). */
function hangingProvider(t: TestContext) {
  const pending: Array<() => void> = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls++;
    pending.push(() => resolve(Response.json(jevTopologyResponse(String(init?.body), 'single'))));
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  return { calls: () => calls, release: () => { for (const answer of pending.splice(0)) answer(); } };
}
const within = <T>(work: Promise<T>, ms: number, label: string) => Promise.race([work,
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} took longer than ${ms}ms`)), ms).unref())]);

test('a Human send is committed and broadcast without waiting for Jev; the advice reaches the brain afterwards', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const sessionId = randomUUID();
  await f.agent(f.brain.token, 'POST', '/inbox/session', { sessionId });
  const provider = hangingProvider(t);
  const broadcast: string[] = [];
  f.hive.bus.on('message', (message: Message) => broadcast.push(message.body));
  const sent = await within(f.humanSend(dm.id, { body: 'Fix the typo in README.', requestId: 'typo' }), 1000, 'the Human send');
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.json), ['message'], 'the send response carries no routing state');
  assert.deepEqual(broadcast, ['Fix the typo in README.'], 'broadcast before Jev answered');
  assert.equal(provider.calls(), 1, 'Jev is asked in the background');
  assert.equal(f.view(dm.id).events.length, 0, 'no advice yet');

  provider.release();
  await f.hive.adaptiveTopology.settled();
  const [event] = f.view(dm.id).events;
  assert.equal(event?.kind, 'advice'); assert.equal(event?.trigger, 'human_request');
  // The wait that delivers the Human message carries the background advice, without calling Jev again.
  const mail = await f.agent<{ messages?: unknown[]; mail?: unknown[] }>(f.brain.token, 'POST', '/wait', { sessionId, timeoutMs: 1000 });
  assert.ok((mail.messages?.length ?? 0) + (mail.mail?.length ?? 0) > 0);
  assertAdvice(mail.jevAdvice, { plan: 'single', state: 'ok' });
  assert.equal(provider.calls(), 1, 'a wait never calls Jev');
});

test('concurrent Human sends commit in arrival order whatever Jev latency is', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  let call = 0;
  // Before #214 the first send waited longest for Jev and was committed last.
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const delay = [80, 40, 0][call++] ?? 0;
    await new Promise(resolve => setTimeout(resolve, delay));
    return Response.json(jevTopologyResponse(String(init?.body), 'single'));
  });
  const bodies = ['first', 'second', 'third'];
  const sent = await Promise.all(bodies.map(body => f.humanSend(dm.id, { body, requestId: body })));
  assert.deepEqual(sent.map(item => item.status), [200, 200, 200]);
  const seqs = sent.map(item => item.json.message.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'sequence numbers follow the send order');
  assert.deepEqual(f.hive.messageQueries.listMessages(f.human, dm.id).messages.map(message => message.body), bodies);
  await f.hive.adaptiveTopology.settled();
  assert.equal(call, 3);
});

test('delegation that contradicts Jev advice succeeds, and the advice is still returned', async t => {
  const f = fixture(t);
  const dm = f.team();
  const request = await f.humanRequest(dm.id, { body: 'Fix the typo in README.', requestId: 'typo' });
  assert.equal(request.status, 200);
  assert.equal(f.calls(), 1, 'the Human request is classified once, after it is posted');
  assertAdvice(f.view(dm.id).state?.advice, { plan: 'single', topology: 'single', workers: 0, state: 'ok' });

  // Jev says Single, yet the brain delegates from the request's channel: nothing is blocked.
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'assign-1', worker: f.workers[0]!.agent.name, contract, channel: dm.id });
  assertAdvice(assigned.jevAdvice, { plan: 'single', state: 'ok', confidence: 0.72 });
  const delegated = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`,
    { body: 'Assigning a worker anyway.', eventType: 'assignment', requestId: 'dm-assign' });
  assertAdvice(delegated.jevAdvice, { plan: 'single' });
  assert.equal(f.calls(), 3, 'one Jev call per brain action');
  const log = f.hive.adaptiveTopology.observations.jevCalls.view(dm.projectId);
  assert.deepEqual(log.requests.map(group => group.callCount), [3], 'every call is grouped under the Human request');
  assert.deepEqual(log.requests[0]!.calls.map(call => call.trigger.kind), ['human_request', 'delegation_attempt', 'delegation_attempt']);
  assert.ok(log.requests[0]!.calls.every(call => call.outcome === null), 'advice is never "applied"');
});

test('every brain action on a request returns one call\'s advice; waits, workers and other channels trigger none', async t => {
  const f = fixture(t);
  f.advise('brain_multi_dm', 2);
  const room = f.team(), migration = f.team();
  const request = await f.humanRequest(migration.id, { body: 'Split the migration across workers.', requestId: 'split' });
  const instruction = await f.humanRequest(room.id, { body: 'Coordinate the migration here.', requestId: 'coordinate' });
  const root = request.json.message.id;
  const step = async <T>(label: string, run: () => Promise<T & Advised>, advised = true): Promise<T & Advised> => {
    const before = f.calls();
    const result = await run();
    assert.equal(f.calls() - before, advised ? 1 : 0, `${label}: ${advised ? 'one' : 'no'} Jev call`);
    if (advised) assertAdvice(result.jevAdvice, { plan: 'brain_multi_dm_2', topology: 'brain_multi_dm', workers: 2, state: 'ok' });
    return result;
  };
  const [worker] = f.workers;

  const sent = await step('send', () => f.agent<{ id: string }>(f.brain.token, 'POST', `/channels/${migration.id}/messages`, { body: 'On it.', requestId: 's1' }));
  // attach (MCP) uploads the file, then sends it with attachmentIds.
  const upload = await f.app.request('/api/agent/files', { method: 'POST', headers: { authorization: `Bearer ${f.brain.token}`,
    'x-file-name': 'plan.txt', 'x-file-mime': 'text/plain', 'content-length': '4' }, body: 'plan' });
  const uploaded = await upload.json() as { file: { id: string } };
  await step('attach', () => f.agent(f.brain.token, 'POST', `/channels/${migration.id}/messages`, { body: '', attachmentIds: [uploaded.file.id], requestId: 'a1' }));
  const roomContract: RoomContract = { mode: 'ongoing', purpose: 'Coordinate the migration', rules: ['Report blockers.'], limits: ['Fixture only'],
    coordinator: f.brain.agent.name, participants: [{ name: worker!.agent.name, boundary: 'Schema' }], completion: ['Human ends it'], originTaskId: null };
  await step('room_event', () => f.agent(f.brain.token, 'POST', `/channels/${room.id}/room`, { requestId: 'r1', expectedRevision: 0,
    humanInstructionSeq: instruction.json.message.seq, action: { type: 'configure', contract: roomContract, reason: 'Human request' } }));
  const assigned = await step('assign_task', () => f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 't1', worker: worker!.agent.name, contract, channel: migration.id }));
  const task = assigned.task;
  const accepted = await step('worker task_event', () => f.agent<{ task: TaskSnapshot }>(worker!.token, 'POST', `/tasks/${task.id}/events`,
    { requestId: 'w1', expectedRevision: task.revision, action: { type: 'accept' } }), false);
  noAdvice(accepted, 'a worker receives no advice');
  await step('worker send', () => f.agent(worker!.token, 'POST', `/channels/${task.channelId}/messages`,
    { body: 'Working on it.', threadId: task.id, requestId: 'w2' }), false);
  await step('task_event', () => f.agent(f.brain.token, 'POST', `/tasks/${task.id}/events`,
    { requestId: 't2', expectedRevision: accepted.task.revision, action: { type: 'revise', reason: 'Narrow it.', worker: worker!.agent.name, contract } }));
  await step('thread status', () => f.agent(f.brain.token, 'POST', `/threads/${sent.id}/status`, { status: 'in_progress' }));

  const sessionId = randomUUID();
  await f.agent(f.brain.token, 'POST', '/inbox/session', { sessionId });
  f.hive.messages.postMessage(worker!.agent, { channel: migration.id, body: 'Question for you.', threadId: root });
  const mail = await step('wait with mail', () => f.agent<{ messages?: unknown[]; mail?: unknown[] }>(f.brain.token, 'POST', '/wait', { sessionId, timeoutMs: 1000 }), false);
  assert.ok((mail.messages?.length ?? 0) + (mail.mail?.length ?? 0) > 0);
  assertAdvice(mail.jevAdvice, { plan: 'brain_multi_dm_2' });
  const workerSession = randomUUID();
  await f.agent(worker!.token, 'POST', '/inbox/session', { sessionId: workerSession });
  noAdvice(await step('worker wait', () => f.agent(worker!.token, 'POST', '/wait', { sessionId: workerSession, timeoutMs: 20 }), false), 'worker wait');

  // An action in another channel (the default task DM) is not attributed to the room's request.
  const elsewhere = await step('task in its own DM', () => f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 't3', worker: f.workers[1]!.agent.name, contract }), false);
  noAdvice(elsewhere, 'no request in the task DM');

  // A retried request returns the latest advice without asking Jev again.
  const before = f.calls();
  const retried = await f.agent(f.brain.token, 'POST', `/channels/${migration.id}/messages`, { body: 'On it.', requestId: 's1' });
  assert.equal(f.calls(), before);
  assertAdvice(retried.jevAdvice, { plan: 'brain_multi_dm_2' });
});

test('a provider failure never blocks anything and is only recorded in the Routing log', async t => {
  const f = fixture(t);
  const dm = f.team();
  f.fail('http');
  const request = await f.humanRequest(dm.id, { body: 'Ship the patch.', requestId: 'ship' });
  assert.equal(request.status, 200, 'the Human request is still posted');
  assert.equal(f.view(dm.id).events.at(-1)?.error, 'http_503');
  f.fail('network');
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'assign', worker: f.workers[0]!.agent.name, contract, channel: dm.id });
  assert.ok(assigned.task.id, 'the delegation is committed');
  noAdvice(assigned, 'a failed call gives the brain nothing to act on');
  assert.equal(f.calls(), 2);
  const view = f.view(dm.id);
  assert.equal(view.events.at(-1)?.kind, 'advice');
  assert.equal(view.events.at(-1)?.error, 'network');
  assert.deepEqual(f.hive.messageQueries.listMessages(f.human, dm.id).messages.filter(message => message.authorId === f.human.id && message.kind === 'chat')
    .map(message => message.body), ['Ship the patch.'], 'no routing message is ever posted');
});

test('the Human composer has no topology mode or lock, and no directive is posted', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  for (const extra of [{ routing: 'single' }, { routing: 'auto' }, { lockScope: 'task' }]) {
    const rejected = await f.humanSend(dm.id, { body: 'Do it.', requestId: `r-${Object.values(extra)[0]}`, ...extra });
    assert.equal(rejected.status, 400, JSON.stringify(extra));
  }
  assert.equal(f.calls(), 0);
  const sent = await f.humanRequest(dm.id, { body: 'Do it.', requestId: 'plain' });
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.json), ['message']);
  const messages = f.hive.messageQueries.listMessages(f.human, dm.id).messages;
  assert.deepEqual(messages.map(message => message.body), ['Do it.'], 'no "[Hivemind adaptive topology" directive');
  const lock = await f.app.request(`/api/ui/channels/${dm.id}/adaptive-routing/lock`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'task', topology: 'single' }) });
  assert.equal(lock.status, 404, 'the lock endpoint is gone');
  const me = await f.agent(f.brain.token, 'GET', '/me');
  assert.equal('adaptiveRouting' in me || 'adaptiveExecutions' in me, false);
});

test('a legacy executionId is accepted and ignored everywhere', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanRequest(dm.id, { body: 'Plan it.', requestId: 'plan' });
  const sent = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'x', requestId: 'x', executionId: 'execution-unknown' });
  assertAdvice(sent.jevAdvice, { state: 'ok' });
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'a', worker: f.workers[0]!.agent.name, contract, executionId: 'whatever' });
  assert.ok(assigned.task.id);
  const worker = await f.agent(f.workers[0]!.token, 'POST', `/channels/${assigned.task.channelId}/messages`,
    { body: 'ok', requestId: 'w', executionId: 'execution-unknown' });
  noAdvice(worker, 'workers get no advice');
  // Dropped before validation (#218): even a malformed legacy value cannot fail an event.
  const accepted = await f.agent<{ task: TaskSnapshot }>(f.workers[0]!.token, 'POST', `/tasks/${assigned.task.id}/events`,
    { requestId: 'acc', expectedRevision: assigned.task.revision, action: { type: 'accept' }, executionId: 'bad id' });
  assert.equal(accepted.task.state, 'accepted');
});

test('with Jev disabled nothing calls the provider and no response mentions Jev', async t => {
  const f = fixture(t, { enabled: false });
  const dm = f.team();
  const sessionId = randomUUID();
  await f.agent(f.brain.token, 'POST', '/inbox/session', { sessionId });
  const sent = await f.humanRequest(dm.id, { body: 'Hi.', requestId: 'hi' });
  assert.deepEqual(Object.keys(sent.json), ['message']);
  const results: object[] = [
    await f.agent(f.brain.token, 'POST', '/wait', { sessionId, timeoutMs: 1000 }),
    await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Hello.', requestId: 'hello' }),
    await f.agent(f.brain.token, 'POST', '/tasks', { requestId: 'a', worker: f.workers[0]!.agent.name, contract, channel: dm.id }),
    await f.agent(f.brain.token, 'POST', `/threads/${sent.json.message.id}/status`, { status: 'in_progress' }),
    await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Hello.', requestId: 'hello' }),
  ];
  for (const [index, result] of results.entries()) assert.doesNotMatch(JSON.stringify(result), /jevAdvice|advice/i, `response ${index}`);
  await f.hive.adaptiveTopology.settled();
  assert.equal(f.calls(), 0);
  const view = f.view(dm.id);
  assert.deepEqual([view.state, view.events], [null, []], 'nothing is recorded for the Routing log');
});

test('without a Human request in the thread or channel, brains get no advice and no call is made', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanRequest(dm.id, { body: 'Plan the release.', requestId: 'release' });
  const calls = f.calls();
  // The brain's only request is in its Human DM: work in a worker DM is never attributed to it.
  const workerDm = f.hive.channels.openDm(f.brain.agent, f.workers[0]!.agent.name);
  noAdvice(await f.agent(f.brain.token, 'POST', `/channels/${workerDm.id}/messages`, { body: 'Ping.', requestId: 'ping' }), 'other channel');
  noAdvice(await f.agent(f.brain.token, 'POST', '/tasks', { requestId: 't', worker: f.workers[0]!.agent.name, contract }), 'task DM');
  const sessionId = randomUUID();
  await f.agent(f.brain.token, 'POST', '/inbox/session', { sessionId });
  const wait = async (timeoutMs: number) => {
    const result = await f.agent<{ delivery?: { id: string }; idle?: boolean }>(f.brain.token, 'POST', '/wait', { sessionId, timeoutMs });
    if (result.delivery) await f.agent(f.brain.token, 'POST', '/inbox/ack', { sessionId, deliveryId: result.delivery.id });
    return result;
  };
  assertAdvice((await wait(1000)).jevAdvice, { plan: 'single' });
  const quiet = await wait(10);
  assert.equal(quiet.idle, true);
  noAdvice(quiet, 'an idle wait carries nothing');
  f.hive.messages.postMessage(f.workers[0]!.agent, { channel: workerDm.id, body: 'Done with the ping.' });
  const mail = await wait(1000);
  assert.equal(mail.idle, false);
  noAdvice(mail, 'mail from another channel carries no advice');
  assert.equal(f.calls(), calls);
});

test('closing the request thread stops advice until the Human replies in it', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const request = await f.humanRequest(dm.id, { body: 'Write the report.', requestId: 'report' });
  const root = request.json.message.id;
  const before = f.calls();
  const closed = await f.agent(f.brain.token, 'POST', `/threads/${root}/status`, { status: 'done' });
  noAdvice(closed, 'the request is finished: nothing left to advise on');
  assert.equal(f.view(dm.id).state?.monitoring, 'completed');
  const after = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Done.', requestId: 'done' });
  noAdvice(after, 'closed request');
  assert.equal(f.calls(), before);
  await f.humanRequest(dm.id, { body: 'One more section.', threadId: root, requestId: 'more' });
  assert.equal(f.view(dm.id).state?.monitoring, 'active');
  const resumed = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Adding it.', requestId: 'adding', threadId: root });
  assertAdvice(resumed.jevAdvice, { state: 'ok' });
  assert.deepEqual(f.view(dm.id).events.filter(event => event.kind === 'status').map(event => event.reason),
    ['execution_completed']);
});

test('a request idle for longer than the TTL is closed and no longer advised, until the Human replies', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const request = await f.humanRequest(dm.id, { body: 'Draft the plan.', requestId: 'draft' });
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + EXECUTION_IDLE_MS + 1_000);
  const before = f.calls();
  noAdvice(await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Back after a while.', requestId: 'late' }), 'idle request');
  assert.equal(f.calls(), before, 'an expired request makes no call');
  assert.equal(f.view(dm.id).state?.monitoring, 'completed');
  assert.equal(f.view(dm.id).events.at(-1)?.reason, 'execution_expired');
  await f.humanRequest(dm.id, { body: 'Please continue.', threadId: request.json.message.id, requestId: 'continue' });
  clock.mock.restore();
  assertAdvice((await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Continuing.', requestId: 'go' })).jevAdvice, { state: 'ok' });
});

test('advice follows the channel an action happens in when a brain serves several requests', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const group = f.hive.channels.createChannel(f.human, { name: 'release', type: 'private', project: 'acme', memberNames: [f.brain.agent.name] });
  const first = await f.humanRequest(dm.id, { body: 'Write the report.', requestId: 'report' });
  f.advise('brain_one_worker', 1);
  await f.humanRequest(group.id, { body: 'Plan the release.', requestId: 'release' });
  const dmExecution = f.view(dm.id).state!.executionId, groupExecution = f.view(group.id).state!.executionId;
  const callsOf = (executionId: string) => f.hive.adaptiveTopology.observations.jevCalls.view(dm.projectId).requests
    .find(item => item.executionId === executionId)?.callCount ?? 0;
  await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Report draft.', requestId: 'draft' });
  assert.deepEqual([callsOf(dmExecution), callsOf(groupExecution)], [2, 1], 'an action in a channel belongs to that channel\'s request');
  const before = f.calls();
  const closed = await f.agent(f.brain.token, 'POST', `/threads/${first.json.message.id}/status`, { status: 'done' });
  noAdvice(closed, 'closing one request never borrows another request\'s advice');
  const stale = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Back to the release.', requestId: 'back' });
  noAdvice(stale, 'the DM request is closed; the group request is in another channel');
  assert.equal(f.calls(), before);
  const inGroup = await f.agent(f.brain.token, 'POST', `/channels/${group.id}/messages`, { body: 'Release plan.', requestId: 'plan' });
  assertAdvice(inGroup.jevAdvice, { plan: 'brain_one_worker' });
  assert.deepEqual([callsOf(dmExecution), callsOf(groupExecution)], [2, 2]);
});

test('an older call answering late never replaces newer advice', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanRequest(dm.id, { body: 'Plan it.', requestId: 'plan' });
  const answers: Array<(topology: AdaptiveTopology) => void> = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => new Promise<Response>(resolve => {
    answers.push(topology => resolve(Response.json(jevTopologyResponse(String(init?.body), topology, topology === 'single' ? undefined : 1))));
  }));
  // The Human reply's background call starts first, then the brain's action call; they answer in reverse order.
  await f.humanSend(dm.id, { body: 'Also add tests.', threadId: f.view(dm.id).state!.rootMessageId, requestId: 'tests' });
  const acting = f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Planning.', requestId: 'planning' });
  while (answers.length < 2) await new Promise(resolve => setImmediate(resolve));
  answers[1]!('brain_one_worker');
  assertAdvice((await acting).jevAdvice, { plan: 'brain_one_worker' });
  answers[0]!('single');
  await f.hive.adaptiveTopology.settled();
  assert.equal(f.view(dm.id).state?.advice?.plan, 'brain_one_worker', 'the newer call\'s advice is kept');
  assert.equal(f.view(dm.id).events.filter(event => event.kind === 'advice').length, 3, 'both late calls stay in the log');
});

test('incoherent and uncertain answers reach the brain as such, never as unavailable', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    Response.json(contradictoryJevAnswer(jevTopologyResponse(String(init?.body), 'brain_one_worker'))));
  await f.humanRequest(dm.id, { body: 'Refactor the parser.', requestId: 'parser' });
  assertAdvice(f.view(dm.id).state?.advice, { state: 'incoherent', plan: 'single', reason: 'incoherent_plan_vs_sufficiency' });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    Response.json(jevTopologyResponse(String(init?.body), 'brain_one_worker', 1, 0.41)));
  const sent = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Thinking.', requestId: 'thinking' });
  assertAdvice(sent.jevAdvice, { state: 'uncertain', plan: 'brain_one_worker', confidence: 0.41 });
});

test('deleting a project prunes its advice state and audit; the call log follows its channels', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanRequest(dm.id, { body: 'Plan it.', requestId: 'plan' });
  await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Planning.', requestId: 'planning' });
  for (const a of [f.brain, ...f.workers]) f.hive.identity.setOffline(a.agent.id);
  await f.hive.adaptiveTopology.stop();
  f.hive.projects.createProject(f.human, { slug: 'other', name: 'Other' });
  f.hive.projects.deleteProject(f.human, 'acme');
  for (const table of ['adaptive_topology_executions', 'adaptive_topology_events', 'jev_calls'])
    assert.equal(countRows(f.hive, table), 0, table);
});

test('stopping the hive cancels pending calls: sends and actions still answer, and nothing is recorded afterwards', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanRequest(dm.id, { body: 'Plan it.', requestId: 'plan' });
  const events = f.view(dm.id).events.length;
  const provider = hangingProvider(t);
  await f.humanSend(dm.id, { body: 'More detail.', threadId: f.view(dm.id).state!.rootMessageId, requestId: 'more' });
  const pending = f.agent<{ id: string }>(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Working.', requestId: 'working' });
  while (provider.calls() < 2) await new Promise(resolve => setImmediate(resolve));
  await f.hive.adaptiveTopology.stop();
  const answered = await pending;
  assert.ok(answered.id, 'the message was committed before Jev was asked');
  noAdvice(answered, 'a cancelled call is no advice');
  assert.equal(f.view(dm.id).events.length, events);
});
