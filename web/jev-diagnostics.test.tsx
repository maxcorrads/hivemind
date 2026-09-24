import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { JevConnectionTest } from './JevConnectionTest.tsx';
import { AdaptiveRoutingSettings } from './AdaptiveRoutingSettings.tsx';
import { api } from './api.ts';
import { jevDiagnosticsApi } from './jev-diagnostics-api.ts';
import { humanSession } from './human-session.ts';
import type { JevDiagnosticResult } from '../src/shared/jev-diagnostics.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());
const revision = '11111111-1111-4111-8111-111111111111';
const state = { revision, apiKeySet: true };
const saved = { enabled: false, apiKeySet: true, apiKeyHint: null, model: 'jev-latest', defaultModel: 'jev-latest', modelPinned: false };
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return { host, root, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

test('render and save do not test Jev; a click makes exactly one explicit test', async t => {
  let calls = 0;
  t.mock.method(api, 'adaptiveRouting', async () => saved);
  t.mock.method(api, 'saveAdaptiveRouting', async () => ({ ...saved }));
  t.mock.method(jevDiagnosticsApi, 'state', async () => state);
  t.mock.method(jevDiagnosticsApi, 'test', async () => { calls++; return { revision, code: 'success' }; });
  const view = mount();
  try {
    await act(async () => view.root.render(<AdaptiveRoutingSettings onClose={() => undefined} />));
    assert.equal(calls, 0);
    assert.match(view.host.textContent!, /can consume provider usage/);
    await act(async () => {
      const event = document.createEvent('Event');
      event.initEvent('submit', true, true);
      view.host.querySelector('form')!.dispatchEvent(event);
    });
    assert.equal(calls, 0);
    await act(async () => button(view.host, 'Test Jev connection').click());
    assert.equal(calls, 1);
    assert.match(view.host.textContent!, /returned a valid synthetic response/);
  } finally { await view.close(); }
});

test('unsaved settings disable testing', async t => {
  t.mock.method(jevDiagnosticsApi, 'test', async () => { throw new Error('Unexpected test'); });
  const view = mount();
  try {
    await act(async () => view.root.render(<JevConnectionTest savedSettings={saved} disabled />));
    assert.equal(button(view.host, 'Test Jev connection').disabled, true);
    assert.match(view.host.textContent!, /Save pending changes/);
  } finally { await view.close(); }
});

test('cancel discards late success, and double click does not issue another test', async t => {
  let resolve!: (result: JevDiagnosticResult) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  t.mock.method(jevDiagnosticsApi, 'state', async () => state);
  t.mock.method(jevDiagnosticsApi, 'test', async (_revision: string, s?: AbortSignal) => {
    calls++; signal = s;
    return new Promise<JevDiagnosticResult>(r => { resolve = r; });
  });
  const view = mount();
  try {
    await act(async () => view.root.render(<JevConnectionTest savedSettings={saved} disabled={false} />));
    await act(async () => { const test = button(view.host, 'Test Jev connection'); test.click(); test.click(); });
    assert.equal(calls, 1);
    await act(async () => button(view.host, 'Cancel test').click());
    assert.equal(signal?.aborted, true);
    await act(async () => resolve({ revision, code: 'success' }));
    assert.match(view.host.textContent!, /Connection test cancelled/);
    assert.doesNotMatch(view.host.textContent!, /returned a valid/);
  } finally { await view.close(); }
});

test('saving or closing during a test cancels it and discards late results', async t => {
  let resolve!: (result: JevDiagnosticResult) => void;
  let signal: AbortSignal | undefined;
  t.mock.method(jevDiagnosticsApi, 'state', async () => state);
  t.mock.method(jevDiagnosticsApi, 'test', async (_revision: string, s?: AbortSignal) => {
    signal = s; return new Promise<JevDiagnosticResult>(r => { resolve = r; });
  });
  const view = mount();
  try {
    await act(async () => view.root.render(<JevConnectionTest savedSettings={saved} disabled={false} />));
    await act(async () => button(view.host, 'Test Jev connection').click());
    await act(async () => view.root.render(<JevConnectionTest savedSettings={{ ...saved }} disabled={false} />));
    assert.equal(signal?.aborted, true);
    await act(async () => resolve({ revision, code: 'success' }));
    assert.doesNotMatch(view.host.textContent!, /returned a valid/);
    await act(async () => button(view.host, 'Test Jev connection').click());
    await act(async () => view.root.render(null));
    assert.equal(signal?.aborted, true);
    await act(async () => resolve({ revision, code: 'success' }));
  } finally { await view.close(); }
});

test('a changed server revision invalidates success before it is displayed', async t => {
  let reads = 0;
  t.mock.method(jevDiagnosticsApi, 'state', async () => ({ ...state, revision: ++reads === 1 ? revision : '22222222-2222-4222-8222-222222222222' }));
  t.mock.method(jevDiagnosticsApi, 'test', async () => ({ revision, code: 'success' }));
  const view = mount();
  try {
    await act(async () => view.root.render(<JevConnectionTest savedSettings={saved} disabled={false} />));
    await act(async () => button(view.host, 'Test Jev connection').click());
    assert.match(view.host.textContent!, /Saved settings changed/);
    assert.doesNotMatch(view.host.textContent!, /returned a valid/);
  } finally { await view.close(); }
});

test('arbitrary errors never reach the DOM and focus clears a prior result without retesting', async t => {
  let calls = 0;
  t.mock.method(jevDiagnosticsApi, 'state', async () => state);
  t.mock.method(jevDiagnosticsApi, 'test', async () => {
    calls++; throw new Error('Authorization: Bearer private-key https://user:password@provider.test');
  });
  const view = mount();
  try {
    await act(async () => view.root.render(<JevConnectionTest savedSettings={saved} disabled={false} />));
    await act(async () => button(view.host, 'Test Jev connection').click());
    assert.match(view.host.textContent!, /Could not complete the local connection test/);
    assert.doesNotMatch(view.host.textContent!, /private-key|password|Authorization/);
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
    assert.equal(calls, 1);
    assert.equal(view.host.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});

test('client sends only an opaque revision and rejects unrecognized provider text', async t => {
  t.mock.method(humanSession, 'request', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/ui/adaptive-routing/connection-test');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { revision });
    return Response.json({ revision, code: 'Bearer private-key' });
  });
  await assert.rejects(jevDiagnosticsApi.test(revision), /Invalid diagnostic result/);
});
