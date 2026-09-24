import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { countRows, deleteRows, findRow, readValue, setAgentPresence, snapshotTables } from './test-fixtures.ts';
import { createApp } from './app.ts';
import { startServer } from './serve.ts';
import { readLimitedJson } from './ingress.ts';
import { requestJson } from './api-input.ts';
import { API_JSON_BYTES, MAX_WAIT_MS, REQUEST_BODY_MS, REQUEST_HEADER_MS } from '../shared/api-contract.ts';
import { filesDir } from './files.ts';
import { type UploadLimits } from './upload-budget.ts';

function fixture(t: TestContext, limits: Partial<UploadLimits> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-api-boundary-'));
  const hive = new Hive(path.join(dir, 'hive.db'), { uploadLimits: limits });
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, hive, app: createApp(hive), human: hive.identity.getAgent('human') };
}
function body(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(value)); controller.close(); } });
}
function paused() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return { stream: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    finish: (value = 'x') => { controller.enqueue(Buffer.from(value)); controller.close(); } };
}

test('invalid HTTP values fail before presence, session, membership or message mutation', async t => {
  const f = fixture(t), agent = f.hive.identity.join({ role: 'brain' });
  setAgentPresence(f.hive, agent.agent.id, { lastSeenAt: 1 });
  const state = () => snapshotTables(f.hive, ['agents', 'messages', 'channel_members', 'inbox_sessions']);
  const before = state();
  for (const [route, input] of [
    ['/join', { role: 'brain', seniority: 'superhuman' }],
    ['/join', { role: ['brain'] }],
    ['/channels', { name: {}, type: 'public' }],
    ['/channels', { name: 'valid', memberNames: 'Atlas', type: 'private' }],
    ['/channels/general/messages', { body: {} }],
    ['/channels/general/messages', { body: 'no coercion', attachmentIds: [7] }],
    ['/channels/general/messages', { body: 'no coercion', recipients: ['Atlas', 1] }],
    ['/channels/general/messages', { body: 'no secret in error', unknown: 'never-echo-this-token' }],
    ['/wait', { sessionId: randomUUID(), timeoutMs: 2 ** 40 }],
    ['/wait', { sessionId: randomUUID(), timeoutMs: 1.5 }],
    ['/wait', { sessionId: randomUUID(), compact: 'false' }],
    ['/wait', null],
  ] as const) {
    const response = await f.app.request('/api/agent' + route, { method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400, route);
    assert.ok(!(await response.text()).includes('never-echo-this-token'));
    assert.deepEqual(state(), before, route);
  }
  for (const query of ['limit=NaN', 'limit=0', 'beforeSeq=-1', 'afterSeq=1.5', 'limit=1&limit=2', 'unread=false', 'limit=9007199254740992']) {
    const response = await f.app.request('/api/agent/channels/general/messages?' + query,
      { headers: { authorization: `Bearer ${agent.token}` } });
    assert.equal(response.status, 400, query); assert.deepEqual(state(), before);
  }
});

test('huge/nonfinite direct wait durations do not create timers, sessions or presence changes', async t => {
  const f = fixture(t), agent = f.hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const before = findRow(f.hive, 'agents', { id: agent.id });
  for (const invalid of [NaN, Infinity, -1, 0, 0.2, MAX_WAIT_MS + 1, 2 ** 40]) {
    await assert.rejects(f.hive.delivery.wait(agent, invalid), /Invalid request field/);
    assert.equal(f.hive.inbox.currentSession(agent.id), undefined);
    assert.deepEqual(findRow(f.hive, 'agents', { id: agent.id }), before);
  }
});

test('ordinary JSON is byte bounded, rejects null/malformed UTF-8, and slow reads cancel without waiting for producer cleanup', async t => {
  for (const input of ['null', '[]', '{"body":', JSON.stringify({ body: 'x'.repeat(API_JSON_BYTES) })]) {
    const request = new Request('http://127.0.0.1/api/agent/channels/general/messages', { method: 'POST', body: input });
    await assert.rejects(requestJson(request));
  }
  await assert.rejects(readLimitedJson(new Request('http://localhost', { method: 'POST', body: new Uint8Array([0xff]) }), 100), /UTF-8/);
  let cancelled = false;
  const request = new Request('http://localhost', { method: 'POST', duplex: 'half', body: new ReadableStream({
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }) } as RequestInit);
  const original = globalThis.setTimeout;
  let timeout!: () => void;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    if (ms === 731) timeout = callback;
    return original(callback, ms);
  });
  const pending = readLimitedJson(request, 100, 731);
  timeout();
  await assert.rejects(pending, /deadline/);
  assert.equal(cancelled, true);
});

test('upload limits are shared by database instances, permit another actor, and release all reservations on completion', async t => {
  const f = fixture(t), other = new Hive(path.join(f.dir, 'hive.db'));
  t.after(() => other.db.close());
  const worker = other.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const one = paused(), two = paused(), three = paused();
  const a = f.hive.files.createFile(f.human, { name: 'one', mime: 'text/plain', body: one.stream, declaredBytes: 1 });
  const b = other.files.createFile(f.human, { name: 'two', mime: 'text/plain', body: two.stream, declaredBytes: 1 });
  await assert.rejects(other.files.createFile(f.human, { name: 'three', mime: 'text/plain', body: body('x'), declaredBytes: 1 }), /concurrency/);
  const c = other.files.createFile(worker, { name: 'three', mime: 'text/plain', body: three.stream, declaredBytes: 1 });
  // Distinct contents: the quota counts each stored blob once.
  one.finish('a'); two.finish('b'); three.finish('c');
  assert.equal((await Promise.all([a,b,c])).length, 3);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
  assert.equal(readValue(f.hive, 'upload_usage', 'bytes'), 3);
});

test('quota accounts for committed metadata and in-flight reservation; lying lengths never overcommit', async t => {
  const f = fixture(t, { totalBytes: 4 });
  await f.hive.files.createFile(f.human, { name: 'small', mime: 'text/plain', body: body('xx'), declaredBytes: 2 });
  const hold = paused();
  const uploading = f.hive.files.createFile(f.human, { name: 'held', mime: 'text/plain', body: hold.stream, declaredBytes: 2 });
  await assert.rejects(f.hive.files.createFile(f.human, { name: 'too-much', mime: 'text/plain', body: body('x'), declaredBytes: 1 }), /quota/);
  hold.finish('yy'); await uploading;
  assert.equal(readValue(f.hive, 'upload_usage', 'bytes'), 4);
  deleteRows(f.hive, 'attachments');
  await assert.rejects(f.hive.files.createFile(f.human, { name: 'lie', mime: 'text/plain', body: body('xxx'), declaredBytes: 2 }), /large|reservation/);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
  assert.equal(readValue(f.hive, 'upload_usage', 'bytes'), 0);
});

test('stalled uploads enforce deadlines and remove temporary files and quota reservations', { timeout: 5000 }, async t => {
  const f = fixture(t, { deadlineMs: 733 });
  let timeout!: () => void;
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    if (ms === 733) timeout = callback;
    return original(callback, ms);
  });
  const uploading = f.hive.files.createFile(f.human, { name: 'stalled', mime: 'text/plain', declaredBytes: 10,
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('x')); } }),
  });
  timeout();
  await assert.rejects(uploading, /deadline/);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
  assert.deepEqual(readdirSync(filesDir(f.dir)), []);
});

test('body/header deadlines do not shorten an already admitted long-poll response', async t => {
  const f = fixture(t), service = startServer({ hive: f.hive, port: 0, telegram: false });
  t.after(() => service.shutdown()); await service.ready;
  assert.equal(service.server.headersTimeout, REQUEST_HEADER_MS);
  assert.equal(service.server.requestTimeout, REQUEST_BODY_MS);
  assert.equal(service.server.timeout, 0, 'response inactivity is governed by explicit wait deadline');
  const worker = f.hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const abort = new AbortController();
  const wait = f.hive.delivery.wait(worker, MAX_WAIT_MS, abort.signal);
  abort.abort(); assert.equal((await wait).idle, true);
});

test('upload global concurrency stops a fifth actor without stranding its body', async t => {
  const f = fixture(t), streams = Array.from({ length: 4 }, () => paused());
  const workers = Array.from({ length: 5 }, () => f.hive.identity.join({ role: 'worker', seniority: 'mid' }).agent);
  const pending = streams.map((stream, i) => f.hive.files.createFile(workers[i]!, { name: 'bounded', mime: 'text/plain', body: stream.stream, declaredBytes: 1 }));
  await assert.rejects(f.hive.files.createFile(workers[4]!, { name: 'fifth', mime: 'text/plain', body: body('x'), declaredBytes: 1 }), /concurrency/);
  for (const stream of streams) stream.finish(); await Promise.all(pending);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
});

test('upload deadline does not await an uncooperative producer cancel promise', { timeout: 5000 }, async t => {
  const f = fixture(t, { deadlineMs: 739 }); let timeout!: () => void;
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    if (ms === 739) timeout = callback; return original(callback, ms);
  });
  const pending = f.hive.files.createFile(f.human, { name: 'stalled', mime: 'text/plain', declaredBytes: 1,
    body: new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }),
  });
  timeout(); await assert.rejects(pending, /deadline/);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
  assert.deepEqual(readdirSync(filesDir(f.dir)), []);
});

test('a session replaced by a resume during upload cannot authorize its final commit', async t => {
  const f = fixture(t), joined = f.hive.identity.join({ role: 'brain' });
  const stream = paused();
  const upload = f.hive.files.createFile(joined.agent, { name: 'old-token', mime: 'text/plain', body: stream.stream,
    declaredBytes: 1, authorize: () => f.hive.identity.agentByToken(joined.token) });
  f.hive.identity.join({ role: 'brain', resumeName: joined.agent.name });
  stream.finish(); await assert.rejects(upload, /token/i);
  assert.equal(countRows(f.hive, 'attachments'), 0);
  assert.equal(countRows(f.hive, 'upload_reservations'), 0);
});
