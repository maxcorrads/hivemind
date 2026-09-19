import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';
import { RoomPanel } from './RoomPanel.tsx';

// Import the DOM renderer after the DOM exists so its event system is real.
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  location: window.location, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'room-ui-retry-'));
  const hive = new Hive(path.join(dir, 'hive.db')), human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain' }).agent;
  const channel = hive.createChannel(brain, { name: 'synthetic-room', type: 'private' });
  const contract = { mode: 'ongoing', purpose: 'Synthetic observations', rules: ['Inspect only'], limits: [],
    coordinator: brain.name, participants: [], completion: ['Human ends the fixture'], originTaskId: null };
  hive.rooms.event(human, channel.id, { requestId: 'initial', expectedRevision: 0,
    action: { type: 'configure', contract, reason: 'Fixture setup' } });
  const app = createApp(hive), posts: string[] = [];
  let fault: 'disconnect' | 'before' | 'server' | 'invalid-json' | 'validation' | 'read' | 'read-after-save' | null = null;
  let gate: Promise<void> | null = null;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/session') return Response.json({ ok: true });
    if (init?.method === 'POST') {
      posts.push(String(init.body));
      if (gate) await gate;
      if (fault === 'before') { fault = null; throw new TypeError('Fixture disconnected before commit'); }
      if (fault === 'validation') { fault = null; return Response.json({ error: 'Fixture validation rejected' }, { status: 400 }); }
      const response = await app.request(url, init);
      if (response.ok && fault) {
        const next = fault; fault = null;
        if (next === 'disconnect') throw new TypeError('Fixture response lost after commit');
        if (next === 'server') return Response.json({ error: 'Fixture gateway failure' }, { status: 502 });
        if (next === 'invalid-json') return new Response('{', { status: 200 });
        if (next === 'read-after-save') fault = 'read';
      }
      return response;
    }
    if (fault === 'read') { fault = null; throw new TypeError('Fixture read unavailable'); }
    return app.request(url, init);
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let tick = 0;
  const render = async () => { await act(async () => root.render(<RoomPanel channel={channel} agents={[brain]} tick={tick++} />)); };
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
  const click = async (label: string) => { const b = button(label); assert.ok(b, `Missing button: ${label}`); await act(async () => b.click()); };
  const input = async (label: string, value: string) => {
    const el = Array.from(host.querySelectorAll('label')).find(l => l.textContent?.startsWith(label))?.querySelector('input,textarea');
    assert.ok(el, `Missing input: ${label}`);
    const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); });
  };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  await render();
  return { hive, human, channel, contract, posts, host, button, click, input, render,
    fail: (kind: typeof fault) => { fault = kind; },
    hold: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
    edit: async () => { await click('Edit contract'); await input('Purpose', 'Changed synthetic rules'); await input('Reason for this change', 'Fixture edit'); },
    count: () => hive.db.prepare('SELECT COUNT(*) AS n FROM room_events').get()!.n };
}

for (const fault of ['disconnect', 'server', 'invalid-json'] as const) {
  test(`mounted room editor retries the exact committed request after ${fault}, including a live refresh`, async t => {
    const f = await fixture(t); await f.edit(); f.fail(fault); await f.click('Save contract');
    assert.equal(f.count(), 2);
    assert.equal(f.hive.rooms.peek(f.channel.id)!.contract.purpose, 'Changed synthetic rules');
    await f.render(); // Live data changes, but the pending operation must not.
    await f.click(f.button('Retry exact request') ? 'Retry exact request' : 'Save contract');
    assert.equal(f.posts.length, 2);
    assert.equal(f.posts[1], f.posts[0], 'Retry must keep ID, revision and payload');
    assert.equal(f.count(), 2, 'No second committed event');
    assert.equal(f.button('Save contract'), undefined);
    assert.equal(f.host.querySelector('[role="alert"]'), null);
  });
}

test('mounted editor freezes an uncertain draft, then explicitly reconciles without losing it', async t => {
  const f = await fixture(t); await f.edit(); f.fail('disconnect'); await f.click('Save contract');
  assert.match(f.host.textContent!, /outcome is unknown/i);
  assert.ok(f.host.querySelector('fieldset[disabled]'));
  f.fail('read'); await f.click('Reconcile with latest state');
  assert.ok(f.button('Retry exact request'), 'A failed read cannot discard the pending ID');
  await f.click('Reconcile with latest state');
  assert.equal(f.button('Retry exact request'), undefined);
  assert.equal(f.host.querySelector('textarea')!.value, 'Changed synthetic rules');
  await f.input('Purpose', 'Explicitly revised draft'); await f.click('Save contract');
  const first = JSON.parse(f.posts[0]!), next = JSON.parse(f.posts[1]!);
  assert.notEqual(next.requestId, first.requestId); assert.equal(next.expectedRevision, 2);
  assert.equal(f.count(), 3);
});

test('a definitive rejection allows correction; a stale edit is not silently rebased', async t => {
  const f = await fixture(t); await f.edit(); f.fail('validation'); await f.click('Save contract');
  assert.equal(f.count(), 1); assert.equal(f.button('Retry exact request'), undefined);
  await f.input('Purpose', 'Corrected draft');
  f.hive.rooms.event(f.human, f.channel.id, { requestId: 'other-edit', expectedRevision: 1,
    action: { type: 'configure', contract: { ...f.contract, purpose: 'Concurrent edit' }, reason: 'Other edit' } });
  await f.render(); await f.click('Save contract');
  assert.match(f.host.textContent!, /Room changed/); assert.equal(f.count(), 2);
  assert.equal(JSON.parse(f.posts[1]!).expectedRevision, 1);
  assert.notEqual(JSON.parse(f.posts[1]!).requestId, JSON.parse(f.posts[0]!).requestId);
  await f.click('Reconcile with latest state'); await f.click('Save contract');
  assert.equal(JSON.parse(f.posts[2]!).expectedRevision, 2); assert.equal(f.count(), 3);
});

test('archive and reopen can retry after live updates hide their original forms', async t => {
  const f = await fixture(t);
  await f.click('Archive channel…'); await f.input('Reason', 'End fixture');
  f.fail('disconnect'); await f.click('Confirm archive'); await f.render();
  await f.click('Retry exact request');
  assert.equal(f.posts[1], f.posts[0]); assert.equal(f.count(), 2);
  await f.input('Reason to reopen', 'Resume fixture');
  f.fail('disconnect'); await f.click('Reopen channel'); await f.render();
  await f.click('Retry exact request');
  assert.equal(f.posts[3], f.posts[2]); assert.equal(f.count(), 3);
  assert.equal(f.hive.rooms.peek(f.channel.id)!.state, 'active');
});

test('an uncommitted transport failure retries the same operation exactly once', async t => {
  const f = await fixture(t); await f.edit(); f.fail('before'); await f.click('Save contract');
  assert.equal(f.count(), 1); await f.click('Retry exact request');
  assert.equal(f.posts[1], f.posts[0]); assert.equal(f.count(), 2);
});

test('confirmed save plus failed GET does not retain a pending write', async t => {
  const f = await fixture(t); await f.edit(); f.fail('read-after-save'); await f.click('Save contract');
  assert.equal(f.count(), 2); assert.equal(f.button('Retry exact request'), undefined);
  assert.match(f.host.textContent!, /read unavailable/);
  await f.click('Reconcile with latest state'); await f.edit(); await f.click('Save contract');
  assert.notEqual(JSON.parse(f.posts[1]!).requestId, JSON.parse(f.posts[0]!).requestId);
  assert.equal(f.count(), 3);
});

test('in-flight duplicate submits cannot create two operation IDs', async t => {
  const f = await fixture(t); await f.edit(); const release = f.hold();
  try {
    await act(async () => {
      const form = f.host.querySelector('form')!;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    });
    assert.equal(f.posts.length, 1);
  } finally { await act(async () => release()); }
  assert.equal(f.count(), 2);
});
