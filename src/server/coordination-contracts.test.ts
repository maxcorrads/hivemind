import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import type { TaskSnapshot } from '../shared/tasks.ts';
import type { RoomView } from '../shared/rooms.ts';
import type { Message } from '../shared/types.ts';
import { Hive } from './hive.ts';
import { startServer } from './serve.ts';
import { countRows } from './test-fixtures.ts';

type TaskReply = { task: TaskSnapshot; message: Message; duplicate: boolean };

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-coordination-wire-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const server = startServer({ port: 0, hive, telegram: false });
  const sockets: WebSocket[] = [], frames: Array<{ type: string; payload: unknown }> = [];
  const events = new EventEmitter();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.shutdown();
    events.removeAllListeners(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const port = await server.ready, base = `http://127.0.0.1:${port}`;
  const brain = hive.identity.join({ role: 'brain' }), worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const channel = hive.channels.createChannel(brain.agent, { name: 'coordination-contract', type: 'private', memberNames: [worker.agent.name] });
  const session = await fetch(`${base}/api/ui/session`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
  const humanHeaders = { origin: base, cookie, 'x-hivemind-ui': '1' };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: base, cookie, 'sec-fetch-site': 'same-origin' },
  }); sockets.push(socket);
  socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())); events.emit('frame'); });
  await once(socket, 'open');
  const frame = async <T>(type: string, matches: (payload: T) => boolean): Promise<T> => {
    for (;;) {
      const found = frames.find(value => value.type === type && matches(value.payload as T));
      if (found) return found.payload as T;
      await once(events, 'frame', { signal: t.signal });
    }
  };
  const request = async <T = Record<string, unknown>>(url: string, token?: string, body?: unknown) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(url.startsWith('/api/ui/') ? humanHeaders : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const contract = { mode: 'ongoing', purpose: 'Review a shared fixture', rules: ['Only fixture work'], limits: ['No external writes'],
    coordinator: brain.agent.name, participants: [{ name: worker.agent.name, boundary: 'Inspect the fixture' }],
    completion: ['Human archives'], originTaskId: null };
  const taskContract = { objective: 'Inspect the shared fixture', scope: ['Fixture only'], nonGoals: [],
    acceptanceCriteria: ['Return a reviewed result'], dependencies: [], evidenceSeqs: [] };
  return { hive, brain, worker, channel, contract, taskContract, frame, request };
}

test('HTTP and Human WebSocket expose the same typed task/room contract through review and exact retry', { timeout: 15000 }, async t => {
  const f = await fixture(t), roomUrl = `/api/ui/channels/${f.channel.id}/room`;
  const configured = await f.request(roomUrl, undefined, { requestId: 'wire-config', expectedRevision: 0,
    action: { type: 'configure', reason: 'Human fixture', contract: f.contract } });
  assert.equal(configured.status, 200);
  assert.deepEqual(await f.frame<{ channelId: string; archived: boolean }>('room', room => room.channelId === f.channel.id),
    { channelId: f.channel.id, archived: false });
  const input = { requestId: 'wire-assign', channel: f.channel.id, worker: f.worker.agent.name,
    room: { contractVersion: 1, actionKey: 'wire-work' }, contract: f.taskContract };
  const assigned = await f.request<TaskReply>('/api/agent/tasks', f.brain.token, input);
  assert.equal(assigned.status, 200);
  const initial = assigned.body.task as TaskSnapshot;
  assert.deepEqual(await f.frame<TaskSnapshot>('task', task => task.id === initial.id && task.revision === 1), initial);
  const message = await f.frame<Message>('message', value => value.id === assigned.body.message.id);
  assert.deepEqual(message, assigned.body.message);
  assert.equal(message.taskEvent!.action.type, 'assign');
  assert.equal(message.taskEvent!.actorRole, 'brain');
  assert.equal(message.threadId, null);
  const ack = await f.request(`/api/agent/channels/${f.channel.id}/room`, f.worker.token,
    { requestId: 'wire-rules-ack', expectedRevision: 1, action: { type: 'acknowledge', contractVersion: 1 } });
  assert.equal(ack.status, 200);
  const post = async (requestId: string, expectedRevision: number, action: unknown, token = f.worker.token) => {
    const response = await f.request<TaskReply>(`/api/agent/tasks/${initial.id}/events`, token, { requestId, expectedRevision, action });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const task = response.body.task as TaskSnapshot;
    assert.deepEqual(await f.frame<TaskSnapshot>('task', value => value.id === task.id && value.revision === task.revision), task);
    assert.deepEqual((await f.request<{ task: TaskSnapshot }>(`/api/agent/tasks/${task.id}`, f.worker.token)).body.task, task);
    return task;
  };
  assert.equal((await post('wire-accept', 1, { type: 'accept' })).state, 'accepted');
  assert.equal((await post('wire-result', 2, { type: 'result', result: { summary: 'Checked the fixture', artifacts: ['report.txt'],
    checks: [{ name: 'fixture', outcome: 'passed', evidenceSeqs: [] }], gaps: [], evidenceSeqs: [] } })).state, 'result_submitted');
  const completed = await post('wire-review', 3, { type: 'review', decision: 'accepted', summary: 'Independently reviewed', evidenceSeqs: [] }, f.brain.token);
  assert.equal(completed.state, 'accepted_complete');
  const room = (await f.request(roomUrl)).body as RoomView;
  assert.equal(room.activeTaskCount, 0); assert.equal(room.tasks[0]!.state, 'accepted_complete');
  assert.equal(room.room!.state, 'active', 'finishing a task must not independently archive its room');
  let published = 0;
  const listener = () => { published++; }; f.hive.bus.on('task', listener); t.after(() => f.hive.bus.off('task', listener));
  const retry = await f.request<TaskReply>('/api/agent/tasks', f.brain.token, input);
  assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
  assert.deepEqual(retry.body.task, completed); assert.deepEqual(retry.body.message, assigned.body.message);
  assert.equal(published, 0, 'an exact retry must not republish a completed operation');
});

test('HTTP rejects missing credentials, cross-project reads and forged coordination authority without partial state', { timeout: 15000 }, async t => {
  const f = await fixture(t), human = f.hive.identity.getAgent('human');
  const project = f.hive.projects.createProject(human, { name: 'Other fixture', slug: 'other-wire-fixture' });
  const outsider = f.hive.identity.join({ role: 'brain', project: project.slug });
  const assigned = f.hive.tasks.assign(f.brain.agent, { requestId: 'private-task', worker: f.worker.agent.name,
    channel: f.channel.id, contract: f.taskContract });
  const url = `/api/agent/tasks/${assigned.task.id}`;
  assert.equal((await f.request(url)).status, 401);
  for (const target of [url, `/api/agent/channels/${f.channel.id}/room`]) {
    const rejected = await f.request(target, outsider.token);
    assert.ok([403, 404].includes(rejected.status));
    assert.equal(Object.hasOwn(rejected.body, 'task'), false);
    assert.equal(Object.hasOwn(rejected.body, 'room'), false);
    assert.ok(!JSON.stringify(rejected.body).includes(f.taskContract.objective));
  }
  const wrongRole = await f.request(`${url}/events`, f.worker.token,
    { requestId: 'forged-review', expectedRevision: 1, action: { type: 'review', decision: 'accepted', summary: 'Pretend', evidenceSeqs: [] } });
  assert.equal(wrongRole.status, 403);
  const forgedActor = await f.request(`${url}/events`, f.worker.token,
    { requestId: 'forged-actor', actorId: f.brain.agent.id, expectedRevision: 1, action: { type: 'accept' } });
  assert.equal(forgedActor.status, 400);
  assert.deepEqual(f.hive.tasks.get(f.worker.agent, assigned.task.id), assigned.task);
  assert.equal(countRows(f.hive, 'task_events', { task_id: assigned.task.id }), 1);
  assert.equal(f.hive.rooms.peek(f.channel.id), null);
});

test('plain message bodies retain embedded NUL through HTTP, WebSocket and history on Node 22.13', { timeout: 15000 }, async t => {
  const f = await fixture(t), body = 'before\0after – 界';
  const sent = await f.request<Message>(`/api/agent/channels/${f.channel.id}/messages`, f.brain.token, { body });
  assert.equal(sent.status, 200);
  const message = await f.frame<Message>('message', value => value.id === sent.body.id);
  assert.equal(message.body, body);
  const history = await f.request<{ messages: Message[] }>(`/api/agent/channels/${f.channel.id}/messages`, f.worker.token);
  assert.equal(history.status, 200);
  assert.equal(history.body.messages.find((value: Message) => value.id === sent.body.id)!.body, body);
  assert.equal(f.hive.tasks.has(message.id), false, 'ordinary messaging remains unstructured');
});

test('Human UI creation and explicit invitation remain separate from declaring room participants', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const created = await f.request<{ channel: { id: string; memberIds: string[] } }>('/api/ui/channels', undefined,
    { name: 'explicit-invitations', type: 'private', memberNames: [f.brain.agent.name], project: f.channel.project });
  assert.equal(created.status, 200);
  const channel = created.body.channel;
  assert.ok(channel.memberIds.includes('human'));
  assert.ok(!channel.memberIds.includes(f.worker.agent.id));
  const url = `/api/ui/channels/${channel.id}/room`;
  const configure = { requestId: 'invitation-contract', expectedRevision: 0,
    action: { type: 'configure', reason: 'Human invitation fixture', contract: f.contract } };
  const rejected = await f.request(url, undefined, configure);
  assert.equal(rejected.status, 400, 'a contract cannot grant a worker channel membership');
  assert.match(String(rejected.body.error), /invited worker/);
  assert.equal(f.hive.rooms.peek(channel.id), null);
  const invited = await f.request<{ channel: { memberIds: string[] } }>(`/api/ui/channels/${channel.id}/invite`, undefined,
    { names: [f.worker.agent.name] });
  assert.equal(invited.status, 200);
  assert.ok(invited.body.channel.memberIds.includes(f.worker.agent.id));
  const configured = await f.request<RoomView>(url, undefined, configure);
  assert.equal(configured.status, 200);
  assert.equal(configured.body.room!.revision, 1, 'a definitively rejected request has not consumed its ID');
  const workerView = await f.request<RoomView>(`/api/agent/channels/${channel.id}/room`, f.worker.token);
  assert.equal(workerView.status, 200);
  assert.deepEqual(workerView.body.room, configured.body.room);
  const humanHistory = await f.request<{ history: unknown[] }>(`${url}/history`);
  assert.equal(humanHistory.status, 200);
  assert.deepEqual(humanHistory.body.history, f.hive.rooms.history(f.hive.identity.getAgent('human'), channel.id));
  const outsider = f.hive.identity.join({ role: 'worker', seniority: 'mid' });
  assert.equal((await f.request(`/api/agent/channels/${channel.id}/room`, outsider.token)).status, 403);
});

test('Human thread snapshots expose structured state but generic thread edits cannot bypass brain review', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const task = f.hive.tasks.assign(f.brain.agent, { requestId: 'human-visible-task', worker: f.worker.agent.name,
    channel: f.channel.id, contract: f.taskContract }).task;
  const thread = await f.request<{ task: TaskSnapshot; threads: Array<{ id: string; channelId: string }> }>(
    `/api/ui/channels/${f.channel.id}/messages?threadId=${task.id}`);
  assert.equal(thread.status, 200);
  assert.deepEqual(thread.body.task, JSON.parse(JSON.stringify(task)));
  assert.equal(thread.body.threads.find(value => value.id === task.id)!.channelId, f.channel.id);
  const rejected = await f.request(`/api/ui/threads/${task.id}/status`, undefined, { status: 'done' });
  assert.equal(rejected.status, 409);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), task);
  const dm = await f.request<{ channel: { id: string } }>('/api/ui/dms', undefined, { name: f.worker.agent.name });
  assert.equal(dm.status, 200);
  const ordinary = await f.request<{ message: Message }>(`/api/ui/channels/${dm.body.channel.id}/messages`, undefined,
    { body: 'Human can still send ordinary messages.' });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.message.authorRole, 'human');
  assert.equal(ordinary.body.message.taskEvent, undefined);
  assert.equal(f.hive.tasks.has(ordinary.body.message.id), false);
});
