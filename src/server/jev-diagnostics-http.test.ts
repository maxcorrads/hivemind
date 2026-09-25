import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from './app.ts';
import { Hive } from './hive.ts';
import { TYPESAFE_ENDPOINT } from './adaptive-config.ts';
import type { JevDiagnosticResult, JevDiagnosticState } from '../shared/jev-diagnostics.ts';

const endpoint = '/api/ui/adaptive-routing/connection-test';
const key = 'synthetic-http-test-key-not-a-credential';
const valid = () => Response.json({ model: 'jev-fixture',
  answers: { connection_check: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 3 } });
function fixture(t: TestContext, fetchImpl: typeof fetch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-diagnostic-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createApp(hive, { jevDiagnosticFetch: fetchImpl });
  const state = async () => {
    const response = await app.request(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json() as Promise<JevDiagnosticState>;
  };
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const save = async (apiKey: string) => {
    const response = await app.request('/api/ui/adaptive-routing', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, apiKey }) });
    assert.equal(response.status, 200);
  };
  return { hive, app, state, post, save };
}

test('Human connection test is explicit, fixed-endpoint and inert with respect to active work', async t => {
  let calls = 0;
  const f = fixture(t, async (input, init) => {
    calls++;
    assert.equal(String(input), TYPESAFE_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.doesNotMatch(String(init?.body), /private-project-request|acme|synthetic-http-test-key/);
    return valid();
  });
  const missing = await f.state();
  assert.deepEqual(await (await f.post({ revision: missing.revision })).json(), { revision: missing.revision, code: 'missing_key' });
  assert.equal(calls, 0);
  await f.save(key);
  const saved = await f.state();
  assert.equal(calls, 0, 'Saving and reading must not make a diagnostic request');
  assert.notEqual(saved.revision, missing.revision);
  assert.deepEqual(Object.keys(saved).sort(), ['apiKeySet', 'revision']);

  const human = f.hive.identity.getAgent('human');
  const brain = f.hive.identity.join({ role: 'brain', project: 'acme' });
  const dm = f.hive.channels.openDm(human, brain.agent.name);
  const send = await f.app.request(`/api/ui/channels/${dm.id}/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      body: 'private-project-request', requestId: 'diagnostic-work-fixture',
    }) });
  assert.equal(send.status, 200);
  const before = f.hive.adaptiveTopology.view(human, dm.id);
  const seq = f.hive.messageQueries.latestSeq(dm.id);
  const response = await f.post({ revision: saved.revision });
  assert.deepEqual(await response.json(), { revision: saved.revision, code: 'success' });
  assert.equal(calls, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.hive.adaptiveTopology.view(human, dm.id), before);
  assert.equal(f.hive.messageQueries.latestSeq(dm.id), seq);
});

test('Human boundary rejects agent/bot credentials, cross-site requests and arbitrary probe inputs', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return valid(); });
  await f.save(key);
  const saved = await f.state();
  const forbiddenHeaders: Record<string, string>[] = [{ authorization: 'Bearer synthetic-agent-token' }, { authorization: 'Bearer synthetic-bot-token' },
    { origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of forbiddenHeaders) {
    assert.equal((await f.post({ revision: saved.revision }, headers)).status, 403);
  }
  assert.equal((await f.app.request('https://remote.example/api/ui/adaptive-routing/connection-test')).status, 403);
  for (const body of [null, [], {}, { revision: 'bad' }, { revision: saved.revision, apiKey: key },
    { revision: saved.revision, endpoint: 'https://untrusted.example' }, { revision: saved.revision, request: 'private' }])
    assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.post({ revision: 'x'.repeat(5000) })).status, 413);
  assert.equal((await f.app.request('/api/agent/adaptive-routing/connection-test', { method: 'POST' })).status, 401);
  assert.equal((await f.app.request('/api/bot/adaptive-routing/connection-test', { method: 'POST' })).status, 401);
  assert.equal(calls, 0);
});

test('saved-key rotation aborts an in-flight HTTP diagnostic and fences stale revisions', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const f = fixture(t, async (_input, init) => {
    calls++; signal = init?.signal; entered();
    return new Promise<Response>(() => undefined);
  });
  await f.save(key);
  const saved = await f.state();
  const pending = f.post({ revision: saved.revision });
  await started;
  await f.save(`${key}-rotated`);
  const result = await (await pending).json() as JevDiagnosticResult;
  assert.deepEqual(result, { revision: saved.revision, code: 'settings_changed' });
  assert.equal(signal?.aborted, true);
  const stale = await (await f.post({ revision: saved.revision })).json() as JevDiagnosticResult;
  assert.equal(stale.code, 'settings_changed');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify([result, stale, await f.state()]), /synthetic-http-test-key|Bearer/);
});

test('HTTP cancellation aborts the provider request and exposes only a static result', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | null | undefined;
  const f = fixture(t, async (_input, init) => {
    signal = init?.signal; entered(); return new Promise<Response>(() => undefined);
  });
  await f.save(key);
  const saved = await f.state();
  const controller = new AbortController();
  const pending = f.app.request(new Request(`http://localhost${endpoint}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: saved.revision }), signal: controller.signal }));
  await started;
  controller.abort();
  assert.deepEqual(await (await pending).json(), { revision: saved.revision, code: 'cancelled' });
  assert.equal(signal?.aborted, true);
});
