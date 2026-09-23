import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';
import { App } from './App.tsx';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  location: window.location, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

// The actual network WS contract is exercised by the server tests. Here a
// controlled browser socket forwards real Hive events into the mounted App.
class BrowserSocket {
  static current: BrowserSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor() {
    BrowserSocket.current = this;
    queueMicrotask(() => { if (!this.closed) { this.onopen?.(); this.event('hello', {}); } });
  }
  event(type: string, payload: unknown) { if (!this.closed) this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
  close() { this.closed = true; this.onclose?.(); }
}

test('mounted Human App follows task review and contract history without offering generic task status edits', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coordination-app-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human'), brain = hive.join({ role: 'brain' }).agent;
  const worker = hive.join({ role: 'worker', seniority: 'mid' }).agent;
  const channel = hive.createChannel(brain, { name: 'mounted-coordination', type: 'private', memberNames: [worker.name] });
  hive.rooms.event(human, channel.id, { requestId: 'app-room', expectedRevision: 0, action: { type: 'configure', reason: 'Human fixture',
    contract: { mode: 'ongoing', purpose: 'A visible shared contract', rules: ['Fixture only'], limits: ['No external writes'],
      coordinator: brain.name, participants: [{ name: worker.name, boundary: 'Read the fixture' }],
      completion: ['Human archives'], originTaskId: null } } });
  const initial = hive.tasks.assign(brain, { requestId: 'app-task', worker: worker.name, channel: channel.id,
    room: { contractVersion: 1, actionKey: 'visible-task' }, contract: { objective: 'Review the mounted fixture', scope: ['Fixture'],
      nonGoals: [], acceptanceCriteria: ['Reviewed result'], dependencies: [], evidenceSeqs: [] } }).task;
  hive.rooms.event(worker, channel.id, { requestId: 'app-ack', expectedRevision: 1, action: { type: 'acknowledge', contractVersion: 1 } });
  window.happyDOM.setURL(`http://localhost/#/c/${channel.id}/t/${initial.id}`);
  const app = createApp(hive), requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === '/api/ui/session') return Response.json({ ok: true });
    return app.request(url, init);
  });
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const events = ['message', 'task', 'room', 'agent', 'queued', 'thread', 'channel'] as const;
  const listeners = events.map(type => {
    const listener = (payload: unknown) => BrowserSocket.current?.event(type, payload);
    hive.bus.on(type, listener); return listener;
  });
  t.after(async () => {
    await act(async () => root.unmount());
    events.forEach((type, i) => hive.bus.off(type, listeners[i]!));
    globalThis.WebSocket = originalSocket; host.remove(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  await act(async () => root.render(<App />));
  const thread = () => host.querySelector('aside.thread');
  assert.ok(thread(), 'the URL opens the persisted task thread');
  assert.match(thread()!.textContent!, /Review the mounted fixture/);
  assert.match(host.textContent!, /A visible shared contract/);
  assert.equal(thread()!.querySelector('.thread-tools select'), null, 'Human cannot use generic status to accept-complete a task');
  const event = async (requestId: string, action: unknown, actor = worker) => {
    await act(async () => { hive.tasks.event(actor, initial.id, { requestId,
      expectedRevision: hive.tasks.get(actor, initial.id).revision, action }); });
  };
  await event('app-accept', { type: 'accept' });
  assert.match(thread()!.querySelector('.st')!.textContent!, /^accepted$/);
  await event('app-result', { type: 'result', result: { summary: 'Fixture inspected', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
  assert.match(thread()!.querySelector('.st')!.textContent!, /result submitted/);
  await event('app-review', { type: 'review', decision: 'accepted', summary: 'Independent brain review', evidenceSeqs: [] }, brain);
  assert.match(thread()!.querySelector('.st')!.textContent!, /accepted complete/);
  assert.match(thread()!.textContent!, /Independent brain review/);
  const history = [...host.querySelectorAll('button')].find(button => button.textContent === 'Show recent contract history');
  assert.ok(history);
  await act(async () => history.click());
  assert.match(host.textContent!, /Revision 1, contract 1/);
  assert.ok(requests.some(url => new URL(url, 'http://localhost').pathname.endsWith('/room/history')));
  // A hello/reconnect must reconcile from current HTTP state, not reset review.
  await act(async () => BrowserSocket.current.event('hello', {}));
  assert.match(thread()!.querySelector('.st')!.textContent!, /accepted complete/);
  assert.equal(hive.rooms.peek(channel.id)!.state, 'active');

  // Completing a structured task must not break normal Human replies/reactions,
  // nor may those operations silently create another task transition.
  const type = async (selector: string, value: string) => {
    const element = host.querySelector(selector);
    assert.ok(element);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    });
    await act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event));
  };
  await type('aside.thread textarea', 'A plain reply after review.');
  assert.ok(hive.listMessages(human, channel.id, { threadId: initial.id }).messages.some(message =>
    message.body === 'A plain reply after review.' && message.authorId === 'human'));
  assert.equal(hive.tasks.get(brain, initial.id).revision, 4);
  const reaction = thread()!.querySelector<HTMLButtonElement>('.react-pick button[title="👍"]');
  assert.ok(reaction);
  await act(async () => reaction.click());
  assert.ok(hive.getMessageById(initial.id).reactions!.some(value => value.emoji === '👍' && value.count === 1));
  const close = thread()!.querySelector<HTMLButtonElement>('.thread-tools button');
  assert.ok(close);
  await act(async () => close.click());
  assert.equal(thread(), null);
  await type('main.desk textarea', 'Ordinary channel chat still works.');
  const ordinary = hive.listMessages(human, channel.id).messages.find(message => message.body === 'Ordinary channel chat still works.');
  assert.ok(ordinary); assert.equal(hive.tasks.has(ordinary.id), false);
  const rootMessage = [...host.querySelectorAll('main.desk article.msg')].find(element => element.textContent?.includes('Review the mounted fixture'));
  const reopen = rootMessage?.querySelector<HTMLButtonElement>('button.replies');
  assert.ok(reopen);
  await act(async () => reopen.click());
  assert.match(thread()!.querySelector('.st')!.textContent!, /accepted complete/);
  assert.equal(thread()!.querySelector('.thread-tools select'), null);
});
