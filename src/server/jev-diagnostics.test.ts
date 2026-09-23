import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JevConnectionDiagnostics, probeJevConnection, type JevDiagnosticTransport } from './jev-diagnostics.ts';

const key = 'synthetic-test-key-not-a-credential';
const settings = { apiKey: key, model: 'jev-latest', configuration: { enabled: false, fallback: 'orchestrated' } };
const valid = () => ({ model: 'jev-fixture', answers: { connection_check: { type: 'noul', noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 3 } });
const never: JevDiagnosticTransport = async () => { throw new Error('Unexpected provider call'); };

test('diagnostics are inert until explicitly tested, even while routing is disabled', async () => {
  let calls = 0;
  const diagnostics = new JevConnectionDiagnostics(() => settings, async (apiKey, body, signal) => {
    calls++;
    assert.equal(apiKey, key);
    assert.equal(signal.aborted, false);
    assert.equal(body.includes(key), false);
    assert.deepEqual(JSON.parse(body), {
      model: 'jev-latest', state: 'Hivemind synthetic connection check. No project data.',
      questions: { connection_check: { type: 'noul', instructions: 'Does this state describe a synthetic connection check?' } },
    });
    assert.ok(body.length < 512);
    return Response.json(valid());
  });
  const before = diagnostics.state();
  assert.deepEqual(diagnostics.state(), before);
  assert.equal(calls, 0);
  assert.deepEqual(await diagnostics.test(before.revision), { revision: before.revision, code: 'success' });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(diagnostics.state()).includes(key), false);
});

test('missing key and an already cancelled request do not contact the provider', async () => {
  assert.equal(await probeJevConnection({ ...settings, apiKey: '' }, never), 'missing_key');
  assert.equal(await probeJevConnection(settings, never, { signal: AbortSignal.abort() }), 'cancelled');
});

for (const [status, code] of [[401, 'authorization_failed'], [403, 'authorization_failed'], [429, 'rate_limited'],
  [500, 'provider_error'], [529, 'provider_error'], [422, 'provider_error'], [302, 'provider_error']] as const) {
  test(`HTTP ${status} is sanitized without consuming the error body or retrying`, async () => {
    let calls = 0, cancelled = false;
    const result = await probeJevConnection(settings, async () => {
      calls++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(key)); },
        cancel() { cancelled = true; } }), { status });
    });
    assert.equal(result, code);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });
}

test('network errors never expose messages, keys or credential-bearing URLs', async () => {
  assert.equal(await probeJevConnection(settings, async () => {
    throw new Error(`Authorization: Bearer ${key} https://user:password@example.test`);
  }), 'network_error');
});

for (const [name, response] of [
  ['invalid JSON', () => new Response(key)],
  ['missing body', () => new Response(null, { status: 204 })],
  ['missing usage', () => Response.json({ ...valid(), usage: undefined })],
  ['negative usage', () => Response.json({ ...valid(), usage: { input_tokens: -1, output_tokens: 0 } })],
  ['wrong answer', () => Response.json({ ...valid(), answers: { connection_check: { type: 'noul', noul: 2 } } })],
  ['wrong type', () => Response.json({ ...valid(), answers: { connection_check: { type: 'choice', noul: 1 } } })],
  ['missing model', () => Response.json({ ...valid(), model: '' })],
  ['unsafe model', () => Response.json({ ...valid(), model: 'https://user:password@example.test' })],
  ['oversized body', () => new Response('x'.repeat(16 * 1024 + 1))],
] as const) {
  test(`${name} is an invalid contract, not a successful connection`, async () => {
    assert.equal(await probeJevConnection(settings, async () => response()), 'invalid_contract');
  });
}

test('a non-cooperative transport still has a hard deadline and receives cancellation', async () => {
  let signal: AbortSignal | undefined;
  assert.equal(await probeJevConnection(settings, async (_key, _body, s) => {
    signal = s;
    return new Promise<Response>(() => undefined);
  }, { timeoutMs: 10 }), 'timeout');
  assert.equal(signal?.aborted, true);
});

test('a stalled response body is bounded and cancelled', async () => {
  let cancelled = false;
  assert.equal(await probeJevConnection(settings, async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })), { timeoutMs: 10 }), 'timeout');
  assert.equal(cancelled, true);
});

test('explicit cancellation bounds the test and discards a late response', async () => {
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  const result = probeJevConnection(settings, async () => new Promise<Response>(r => { resolve = r; }), { signal: controller.signal });
  controller.abort();
  assert.equal(await result, 'cancelled');
  let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, true);
});

test('revision drift, rotation and ABA invalidate results without leaking a fingerprint', async () => {
  let current = settings;
  const diagnostics = new JevConnectionDiagnostics(() => current, async () => Response.json(valid()));
  const first = diagnostics.state();
  current = { ...settings, apiKey: `${key}-rotated` };
  const rotated = diagnostics.state();
  assert.notEqual(rotated.revision, first.revision);
  assert.deepEqual(await diagnostics.test(first.revision), { revision: rotated.revision, code: 'settings_changed' });
  current = settings;
  diagnostics.settingsChanged(); // Every saved change invalidates, including change-and-restore.
  assert.notEqual(diagnostics.state().revision, first.revision);
  assert.match(diagnostics.state().revision, /^[\da-f-]{36}$/);
});

test('late success is fenced when settings are saved; concurrent tests do not double bill', async () => {
  let calls = 0;
  const diagnostics = new JevConnectionDiagnostics(() => settings, async () => {
    calls++;
    return new Promise<Response>(() => undefined);
  });
  const state = diagnostics.state();
  const pending = diagnostics.test(state.revision);
  assert.deepEqual(await diagnostics.test(state.revision), { revision: state.revision, code: 'busy' });
  diagnostics.settingsChanged();
  assert.deepEqual(await pending, { revision: state.revision, code: 'settings_changed' });
  assert.equal(calls, 1);
});

test('an external settings change during the call cannot bless the new configuration', async () => {
  let current = settings;
  const diagnostics = new JevConnectionDiagnostics(() => current, async () => {
    current = { ...settings, configuration: { enabled: true, fallback: 'single' } };
    return Response.json(valid());
  });
  const state = diagnostics.state();
  assert.deepEqual(await diagnostics.test(state.revision), { revision: state.revision, code: 'settings_changed' });
});
