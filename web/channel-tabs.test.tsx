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
  HTMLInputElement: window.HTMLInputElement, location: window.location, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

// Real Hive events reach the mounted App through this controlled socket (see coordination-shell.test.tsx).
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

async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 50 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check(), message);
}

test('channel tabs, member stack, one-click decisions and a mismatched thread link redirecting to its channel', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'channel-tabs-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain' }).agent;
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const room = hive.channels.createChannel(brain, { name: 'engineering', type: 'private', memberNames: [worker.name] });
  const task = hive.tasks.assign(brain, { requestId: 'tab-task', worker: worker.name, channel: room.id,
    contract: { objective: 'Pick the parser boundary', scope: ['src/parser'], nonGoals: [], acceptanceCriteria: ['Decision recorded'],
      dependencies: [], evidenceSeqs: [] } }).task;
  const decision = hive.decisions.create(brain, { requestId: 'tab-decision', taskId: task.id, expectedTaskRevision: task.revision,
    question: 'Which compatibility boundary?', options: [{ id: 'strict', label: 'Strict', impact: 'Reject old payloads' },
      { id: 'compat', label: 'Compatible', impact: 'Keep old payloads' }],
    recommendation: { optionId: 'compat', rationale: 'Lower migration risk', uncertainty: 'Medium' },
    evidenceSeqs: [], artifacts: [], affectedWorkers: [worker.name], relatedDecisionIds: [] }).decision;
  const dm = hive.channels.openDm(human, brain.name);
  // #224: a task thread of #engineering opened next to an unrelated DM.
  window.happyDOM.setURL(`http://localhost/#/c/${dm.id}/t/${task.id}`);
  const app = createApp(hive);
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) =>
    url === '/api/ui/session' ? Response.json({ ok: true }) : app.request(url, init));
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const events = ['message', 'task', 'decision', 'room', 'thread', 'channel'] as const;
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
  await until(() => window.location.hash === `#/c/${room.id}/t/${task.id}`, 'the link moves to the channel that owns the thread');
  await until(() => Boolean(thread()?.textContent?.includes('Pick the parser boundary')), 'the task thread opens in its own channel');
  assert.equal(thread()!.querySelector('h1')!.textContent, 'Thread · #engineering');
  assert.equal(host.querySelector('main h1')!.textContent, '#engineering');

  const summary = host.querySelector('.member-stack summary')!;
  assert.match(summary.getAttribute('aria-label')!, /^3 members: /);
  assert.equal(summary.querySelectorAll('.avatar').length, 3);
  const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const tab = (name: string) => tabs().find(item => item.textContent?.startsWith(name))!;
  await until(() => tab('Tasks').textContent === 'Tasks1' && tab('Decisions').textContent === 'Decisions1', 'tabs count open work');
  assert.deepEqual(tabs().map(item => item.textContent?.replace(/\d+$/, '')), ['Messages', 'Tasks', 'Contract', 'Decisions']);
  assert.equal(tab('Messages').getAttribute('aria-selected'), 'true');
  assert.ok(host.querySelector('main .composer'), 'Messages shows the stream and composer');
  assert.equal(host.querySelector<HTMLElement>('main .channel-messages')!.hidden, false);

  await act(async () => tab('Tasks').click());
  assert.equal(tab('Tasks').getAttribute('aria-selected'), 'true');
  const row = host.querySelector<HTMLButtonElement>('.task-list button')!;
  assert.match(row.textContent!, /sent/); assert.match(row.textContent!, /Pick the parser boundary/);
  assert.equal(host.querySelector<HTMLElement>('main .channel-messages')!.hidden, true, 'Messages hides but keeps the composer draft');

  await act(async () => tab('Decisions').click());
  const option = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('main .decision-options button')]
    .find(button => button.textContent?.includes(label))!;
  assert.match(option('Compatible').textContent!, /Recommended/);
  await act(async () => option('Compatible').click());
  const confirm = [...host.querySelectorAll<HTMLButtonElement>('main button')].find(button => button.textContent === 'Confirm')!;
  await act(async () => confirm.click());
  await until(() => hive.decisions.get(human, decision.id).state === 'answered', 'confirm answers the decision');
  assert.equal(hive.decisions.get(human, decision.id).answer!.body, 'compat: Compatible');
  await until(() => tab('Decisions').textContent === 'Decisions', 'the answered decision leaves the awaiting count');

  await act(async () => tab('Contract').click());
  assert.ok(host.querySelector('main .room-panel'), 'the room contract lives in its own tab');

  // Another channel opens on Messages; a DM has no Contract tab.
  await act(async () => { window.location.hash = `/c/${dm.id}`; });
  await until(() => host.querySelector('main h1')?.textContent === dm.name, 'the DM opens');
  assert.equal(tab('Messages').getAttribute('aria-selected'), 'true');
  assert.equal(tab('Contract'), undefined);
});
