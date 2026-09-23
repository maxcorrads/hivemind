import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { contradictoryJevAnswer, jevTopologyResponse } from './fixtures/jev-topology.ts';
import { countRows } from './test-fixtures.ts';
import { JEV_ADVICE_NOTE, type AdaptiveTopology, type JevAdvice } from '../shared/adaptive-topology.ts';
import type { Message } from '../shared/types.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import type { RoomContract } from '../shared/rooms.ts';

// #211: Jev is a non-binding advisor. Every brain action runs, then waits for exactly one Jev call, and returns its
// advice; nothing is blocked, reshaped or enforced, and workers never trigger Jev.
const contract = { objective: 'Complete bounded work.', scope: [], nonGoals: [], acceptanceCriteria: ['Return evidence.'], dependencies: [], evidenceSeqs: [] };
type Advised = { jevAdvice?: JevAdvice | null };

function fixture(t: TestContext, options: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-advisory-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' });
  const workers = [0, 1].map(() => hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
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
  const agent = async <T = Record<string, unknown>>(token: string, method: string, url: string, body?: unknown) => {
    const response = await app.request(`/api/agent${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as T & Advised;
  };
  return { dir, hive, human, brain, workers, app, humanSend, agent, calls: () => calls,
    advise: (topology: AdaptiveTopology, n = 0) => { target = topology; workersAdvised = n; },
    fail: (mode: typeof failure) => { failure = mode; } };
}

function assertAdvice(advice: JevAdvice | null | undefined, expected: Partial<JevAdvice>) {
  assert.ok(advice, 'the response carries jevAdvice');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(advice[key as keyof JevAdvice], value, key);
  assert.equal(advice.note, JEV_ADVICE_NOTE);
  assert.equal(typeof advice.at, 'number');
}

test('delegation that contradicts Jev advice succeeds, and the advice is still returned', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const request = await f.humanSend(dm.id, { body: 'Fix the typo in README.', requestId: 'typo' });
  assert.equal(request.status, 200);
  assert.equal(f.calls(), 1, 'the Human request is classified once, before it is posted');
  const [state] = request.json.adaptiveStates as Array<{ advice: JevAdvice }>;
  assertAdvice(state!.advice, { plan: 'single', topology: 'single', workers: 0, state: 'ok' });

  // Jev says Single, yet the brain delegates three times (two tasks and a free-form DM): nothing is blocked.
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'assign-1', worker: f.workers[0]!.agent.name, contract });
  assertAdvice(assigned.jevAdvice, { plan: 'single', state: 'ok', confidence: 0.72 });
  const second = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'assign-2', worker: f.workers[1]!.agent.name, contract });
  assert.equal(second.task.workerId, f.workers[1]!.agent.id);
  const workerDm = f.hive.channels.openDm(f.brain.agent, f.workers[0]!.agent.name);
  const delegated = await f.agent(f.brain.token, 'POST', `/channels/${workerDm.id}/messages`,
    { body: 'Please also check the changelog.', eventType: 'assignment', requestId: 'dm-assign' });
  assertAdvice(delegated.jevAdvice, { plan: 'single' });
  assert.equal(f.calls(), 4, 'one Jev call per brain action');
  const log = f.hive.adaptiveTopology.observations.jevCalls.view(dm.projectId);
  assert.deepEqual(log.requests.map(group => group.callCount), [4], 'every call is grouped under the Human request');
  assert.deepEqual(log.requests[0]!.calls.map(call => call.trigger.kind),
    ['human_request', 'delegation_attempt', 'delegation_attempt', 'delegation_attempt']);
  assert.ok(log.requests[0]!.calls.every(call => call.outcome === null), 'advice is never "applied"');
});

test('every brain action waits for exactly one Jev call and returns its advice; workers trigger none', async t => {
  const f = fixture(t);
  f.advise('brain_multi_dm', 2);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanSend(dm.id, { body: 'Split the migration across workers.', requestId: 'split' });
  const step = async <T>(label: string, run: () => Promise<T & Advised>, advised = true): Promise<T & Advised> => {
    const before = f.calls();
    const result = await run();
    assert.equal(f.calls() - before, advised ? 1 : 0, `${label}: ${advised ? 'one' : 'no'} Jev call`);
    if (advised) assertAdvice(result.jevAdvice, { plan: 'brain_multi_dm_2', topology: 'brain_multi_dm', workers: 2, state: 'ok' });
    else assert.equal('jevAdvice' in result, false, `${label}: a worker receives no advice`);
    return result;
  };
  const [worker] = f.workers;
  const room = f.hive.channels.createChannel(f.human, { name: 'migration', type: 'private', project: 'chapter',
    memberNames: [f.brain.agent.name, worker!.agent.name] });

  const sent = await step('send', () => f.agent<{ id: string }>(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'On it.', requestId: 's1' }));
  // attach (MCP) uploads the file, then sends it with attachmentIds.
  const upload = await f.app.request('/api/agent/files', { method: 'POST', headers: { authorization: `Bearer ${f.brain.token}`,
    'x-file-name': 'plan.txt', 'x-file-mime': 'text/plain', 'content-length': '4' }, body: 'plan' });
  const uploaded = await upload.json() as { file: { id: string } };
  await step('attach', () => f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: '', attachmentIds: [uploaded.file.id], requestId: 'a1' }));
  const assigned = await step('assign_task', () => f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 't1', worker: worker!.agent.name, contract }));
  const task = assigned.task;
  const accepted = await step('worker task_event', () => f.agent<{ task: TaskSnapshot }>(worker!.token, 'POST', `/tasks/${task.id}/events`,
    { requestId: 'w1', expectedRevision: task.revision, action: { type: 'accept' } }), false);
  await step('worker send', () => f.agent(worker!.token, 'POST', `/channels/${task.channelId}/messages`,
    { body: 'Working on it.', threadId: task.id, requestId: 'w2' }), false);
  await step('task_event', () => f.agent(f.brain.token, 'POST', `/tasks/${task.id}/events`,
    { requestId: 't2', expectedRevision: accepted.task.revision, action: { type: 'revise', reason: 'Narrow it.', worker: worker!.agent.name, contract } }));
  const instruction = f.hive.messages.postMessage(f.human, { channel: room.id, body: 'Coordinate the migration here.' });
  const roomContract: RoomContract = { mode: 'ongoing', purpose: 'Coordinate the migration', rules: ['Report blockers.'], limits: ['Fixture only'],
    coordinator: f.brain.agent.name, participants: [{ name: worker!.agent.name, boundary: 'Schema' }], completion: ['Human ends it'], originTaskId: null };
  await step('room_event', () => f.agent(f.brain.token, 'POST', `/channels/${room.id}/room`, { requestId: 'r1', expectedRevision: 0,
    humanInstructionSeq: instruction.seq, action: { type: 'configure', contract: roomContract, reason: 'Human request' } }));
  await step('thread status', () => f.agent(f.brain.token, 'POST', `/threads/${sent.id}/status`, { status: 'in_progress' }));

  const sessionId = randomUUID();
  await f.agent(f.brain.token, 'POST', '/inbox/session', { sessionId });
  f.hive.messages.postMessage(worker!.agent, { channel: task.channelId, body: 'Question for you.', threadId: task.id });
  const mail = await step('wait with mail', () => f.agent<{ messages?: unknown[]; mail?: unknown[] }>(f.brain.token, 'POST', '/wait', { sessionId, timeoutMs: 1000 }));
  assert.ok((mail.messages?.length ?? 0) + (mail.mail?.length ?? 0) > 0);
  const workerSession = randomUUID();
  await f.agent(worker!.token, 'POST', '/inbox/session', { sessionId: workerSession });
  await step('worker wait', () => f.agent(worker!.token, 'POST', '/wait', { sessionId: workerSession, timeoutMs: 20 }), false);

  // A retried request returns the latest advice without asking Jev again.
  const before = f.calls();
  const retried = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'On it.', requestId: 's1' });
  assert.equal(f.calls(), before);
  assertAdvice(retried.jevAdvice, { plan: 'brain_multi_dm_2' });
});

test('a provider failure never blocks the action: advice comes back as unavailable', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  f.fail('http');
  const request = await f.humanSend(dm.id, { body: 'Ship the patch.', requestId: 'ship' });
  assert.equal(request.status, 200, 'the Human request is still posted');
  const [state] = request.json.adaptiveStates as Array<{ advice: JevAdvice }>;
  assertAdvice(state!.advice, { plan: null, topology: null, workers: null, state: 'unavailable', reason: 'http_503' });
  f.fail('network');
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'assign', worker: f.workers[0]!.agent.name, contract });
  assert.ok(assigned.task.id, 'the delegation is committed');
  assertAdvice(assigned.jevAdvice, { state: 'unavailable', reason: 'network', plan: null });
  const view = f.hive.adaptiveTopology.view(f.human, dm.id);
  assert.equal(view.events.at(-1)?.kind, 'advice');
  assert.equal(view.events.at(-1)?.error, 'network');
  assert.equal(f.hive.messageQueries.listMessages(f.human, dm.id).messages.length, 1, 'no routing message is ever posted');
});

test('the Human composer has no topology mode or lock, and no directive is posted', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  for (const extra of [{ routing: 'single' }, { routing: 'auto' }, { lockScope: 'task' }]) {
    const rejected = await f.humanSend(dm.id, { body: 'Do it.', requestId: `r-${Object.values(extra)[0]}`, ...extra });
    assert.equal(rejected.status, 400, JSON.stringify(extra));
  }
  assert.equal(f.calls(), 0);
  const sent = await f.humanSend(dm.id, { body: 'Do it.', requestId: 'plain' });
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.json).sort(), ['adaptiveStates', 'message']);
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
  await f.humanSend(dm.id, { body: 'Plan it.', requestId: 'plan' });
  const sent = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'x', requestId: 'x', executionId: 'execution-unknown' });
  assertAdvice(sent.jevAdvice, { state: 'ok' });
  const assigned = await f.agent<{ task: TaskSnapshot }>(f.brain.token, 'POST', '/tasks',
    { requestId: 'a', worker: f.workers[0]!.agent.name, contract, executionId: 'whatever' });
  assert.ok(assigned.task.id);
  const worker = await f.agent(f.workers[0]!.token, 'POST', `/channels/${assigned.task.channelId}/messages`,
    { body: 'ok', requestId: 'w', executionId: 'execution-unknown' });
  assert.equal('jevAdvice' in worker, false);
});

test('without Jev, or without a Human request, brains get null advice and no call is made', async t => {
  const off = fixture(t, { enabled: false });
  const dm = off.hive.channels.openDm(off.human, off.brain.agent.name);
  const sent = await off.humanSend(dm.id, { body: 'Hi.', requestId: 'hi' });
  assert.deepEqual(Object.keys(sent.json), ['message']);
  const reply = await off.agent(off.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Hello.', requestId: 'hello' });
  assert.equal(reply.jevAdvice, null);
  assert.equal(off.calls(), 0);

  const on = fixture(t);
  const idle = on.hive.channels.openDm(on.brain.agent, on.workers[0]!.agent.name);
  const unrequested = await on.agent(on.brain.token, 'POST', `/channels/${idle.id}/messages`, { body: 'Ping.', requestId: 'ping' });
  assert.equal(unrequested.jevAdvice, null, 'no Human request to advise on');
  assert.equal(on.calls(), 0);
  const sessionId = randomUUID();
  await on.agent(on.brain.token, 'POST', '/inbox/session', { sessionId });
  const quiet = await on.agent(on.brain.token, 'POST', '/wait', { sessionId, timeoutMs: 10 });
  assert.equal(quiet.jevAdvice, null, 'an idle wait makes no call');
  assert.equal(on.calls(), 0);
});

test('closing the request thread stops advice until the Human replies in it', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const request = await f.humanSend(dm.id, { body: 'Write the report.', requestId: 'report' });
  const root = request.json.message.id;
  const before = f.calls();
  const closed = await f.agent(f.brain.token, 'POST', `/threads/${root}/status`, { status: 'done' });
  assert.equal(closed.jevAdvice, null, 'the request is finished: nothing left to advise on');
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.monitoring, 'completed');
  const after = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Done.', requestId: 'done' });
  assert.equal(after.jevAdvice, null);
  assert.equal(f.calls(), before);
  await f.humanSend(dm.id, { body: 'One more section.', threadId: root, requestId: 'more' });
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).state?.monitoring, 'active');
  const resumed = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Adding it.', requestId: 'adding', threadId: root });
  assertAdvice(resumed.jevAdvice, { state: 'ok' });
  assert.deepEqual(f.hive.adaptiveTopology.view(f.human, dm.id).events.filter(event => event.kind === 'status').map(event => event.reason),
    ['execution_completed']);
});

test('advice follows the request an action belongs to when a brain serves several requests', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  const group = f.hive.channels.createChannel(f.human, { name: 'release', type: 'private', project: 'chapter', memberNames: [f.brain.agent.name] });
  const first = await f.humanSend(dm.id, { body: 'Write the report.', requestId: 'report' });
  f.advise('brain_one_worker', 1);
  const second = await f.humanSend(group.id, { body: 'Plan the release.', requestId: 'release' });
  const [dmExecution] = first.json.adaptiveStates as Array<{ executionId: string }>;
  const [groupExecution] = second.json.adaptiveStates as Array<{ executionId: string }>;
  const callsOf = (executionId: string) => f.hive.adaptiveTopology.observations.jevCalls.view(dm.projectId).requests
    .find(group => group.executionId === executionId)?.callCount ?? 0;
  await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Report draft.', requestId: 'draft' });
  assert.deepEqual([callsOf(dmExecution!.executionId), callsOf(groupExecution!.executionId)], [2, 1],
    'an action in a channel belongs to that channel\'s request');
  const before = f.calls();
  const closed = await f.agent(f.brain.token, 'POST', `/threads/${first.json.message.id}/status`, { status: 'done' });
  assert.equal(closed.jevAdvice, null, 'closing one request never borrows another request\'s advice');
  assert.equal(f.calls(), before);
  const elsewhere = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Back to the release.', requestId: 'back' });
  assertAdvice(elsewhere.jevAdvice, { plan: 'brain_one_worker' });
  assert.deepEqual([callsOf(dmExecution!.executionId), callsOf(groupExecution!.executionId)], [2, 2],
    'otherwise the brain\'s latest open request');
});

test('incoherent and uncertain answers reach the brain as such, never as unavailable', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    Response.json(contradictoryJevAnswer(jevTopologyResponse(String(init?.body), 'brain_one_worker'))));
  const request = await f.humanSend(dm.id, { body: 'Refactor the parser.', requestId: 'parser' });
  const [state] = request.json.adaptiveStates as Array<{ advice: JevAdvice }>;
  assertAdvice(state!.advice, { state: 'incoherent', plan: 'single', reason: 'incoherent_plan_vs_sufficiency' });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    Response.json(jevTopologyResponse(String(init?.body), 'brain_one_worker', 1, 0.41)));
  const sent = await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Thinking.', requestId: 'thinking' });
  assertAdvice(sent.jevAdvice, { state: 'uncertain', plan: 'brain_one_worker', confidence: 0.41 });
});

test('deleting a project prunes its advice state and audit; the call log follows its channels', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanSend(dm.id, { body: 'Plan it.', requestId: 'plan' });
  await f.agent(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Planning.', requestId: 'planning' });
  for (const a of [f.brain, ...f.workers]) f.hive.identity.setOffline(a.agent.id);
  await f.hive.adaptiveTopology.stop();
  f.hive.projects.createProject(f.human, { slug: 'other', name: 'Other' });
  f.hive.projects.deleteProject(f.human, 'chapter');
  for (const table of ['adaptive_topology_executions', 'adaptive_topology_events', 'jev_calls'])
    assert.equal(countRows(f.hive, table), 0, table);
});

test('stopping the hive cancels a pending call: the action still answers, and nothing is recorded afterwards', async t => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  await f.humanSend(dm.id, { body: 'Plan it.', requestId: 'plan' });
  const events = f.hive.adaptiveTopology.view(f.human, dm.id).events.length;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    reached();
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = f.agent<{ id: string }>(f.brain.token, 'POST', `/channels/${dm.id}/messages`, { body: 'Working.', requestId: 'working' });
  await started;
  await f.hive.adaptiveTopology.stop();
  const answered = await pending;
  assert.ok(answered.id, 'the message was committed before Jev was asked');
  assertAdvice(answered.jevAdvice, { state: 'unavailable', reason: 'cancelled' });
  assert.equal(f.hive.adaptiveTopology.view(f.human, dm.id).events.length, events);
});
