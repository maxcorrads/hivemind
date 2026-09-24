import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';
import type { TaskAction } from '../src/shared/tasks.ts';
import type { Agent } from '../src/shared/types.ts';
import { App } from './App.tsx';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, HTMLSelectElement: window.HTMLSelectElement, KeyboardEvent: window.KeyboardEvent,
  location: window.location, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

// Forwards real Hive bus events into the mounted App, like the server's WebSocket.
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

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navigation-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const home = hive.projects.listProjects()[0]!;
  const other = hive.projects.createProject(human, { name: 'Other Place', slug: 'other-place' });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { hive, human, home, other };
}

async function mount(t: TestContext, hive: Hive, hash: string) {
  const app = createApp(hive);
  window.happyDOM.setURL(`http://localhost/${hash}`);
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/session') return Response.json({ ok: true });
    return app.request(url, init);
  });
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  const events = ['message', 'agent', 'channel', 'task', 'decision', 'queued', 'room'] as const;
  const listeners = events.map(type => {
    const listener = (payload: unknown) => BrowserSocket.current?.event(type, payload);
    hive.bus.on(type, listener); return listener;
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    events.forEach((type, i) => hive.bus.off(type, listeners[i]!));
    globalThis.WebSocket = originalSocket; host.remove();
  });
  await act(async () => root.render(<App />));
  await settle();
  const sidebar = () => host.querySelector('aside.rail')!;
  const railButton = (name: RegExp) => [...host.querySelectorAll<HTMLButtonElement>('nav.project-rail button')]
    .find(button => name.test(button.getAttribute('aria-label') ?? ''));
  const navButton = (text: RegExp) => [...sidebar().querySelectorAll<HTMLButtonElement>('button')].find(button => text.test(button.textContent ?? ''));
  return { host, sidebar, railButton, navButton };
}

// happy-dom's event classes are not the DOM lib's; dispatch them untyped.
const fire = (target: EventTarget, event: unknown) => target.dispatchEvent(event as Event);
const keydown = (init: Record<string, unknown>) => new window.KeyboardEvent('keydown', { bubbles: true, ...init });
const key = (init: Record<string, unknown>) => act(async () => { fire(window as unknown as EventTarget, keydown(init)); });
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  fire(input, new window.Event('input', { bubbles: true }));
};

test('the project rail shows one project at a time and remembers the selection in this browser', async t => {
  const { hive, home, other } = fixture(t);
  const brain = hive.identity.join({ role: 'brain', project: other.slug }).agent;
  hive.channels.createChannel(brain, { name: 'other-room', type: 'public' });
  localStorage.clear();
  const view = await mount(t, hive, `#/inbox/${home.slug}`);
  const rail = view.host.querySelector('nav.project-rail')!;
  assert.equal(rail.querySelectorAll('.rail-project').length, 2, 'one icon per project');
  assert.equal(view.railButton(new RegExp(home.name))?.getAttribute('aria-current'), 'page');
  assert.equal(view.sidebar().querySelector('.project-head h2')?.textContent, home.name, 'the sidebar shows only the selected project');
  assert.equal(view.navButton(/# other-room/), undefined);

  await act(async () => view.railButton(/Other Place/)!.click());
  assert.equal(window.location.hash, `#/inbox/${other.slug}`);
  assert.equal(view.sidebar().querySelector('.project-head h2')?.textContent, 'Other Place');
  assert.ok(view.navButton(/# other-room/));
  assert.equal(localStorage.getItem('hivemind-project'), other.slug);

  await act(async () => view.navButton(/# other-room/)!.click());
  await act(async () => view.railButton(new RegExp(home.name))!.click());
  await act(async () => view.railButton(/Other Place/)!.click());
  assert.match(window.location.hash, /^#\/c\//, 'switching back returns to the last view of that project');
  assert.equal(view.sidebar().querySelector('.nav.active')?.textContent, '# other-room');
});

test('a link without a project opens the project last selected in this browser', async t => {
  const { hive, other } = fixture(t);
  localStorage.setItem('hivemind-project', other.slug);
  const view = await mount(t, hive, '#/c/missing-channel');
  assert.equal(window.location.hash, `#/inbox/${other.slug}`);
  assert.equal(view.sidebar().querySelector('.project-head h2')?.textContent, 'Other Place');
});

test('search opens its own results view and never filters the sidebar or the roster', async t => {
  const { hive, home } = fixture(t);
  hive.identity.join({ role: 'brain', project: home.slug });
  hive.identity.join({ role: 'worker', project: home.slug, seniority: 'mid' });
  localStorage.clear();
  const view = await mount(t, hive, `#/inbox/${home.slug}`);
  const before = view.sidebar().querySelectorAll('button').length;
  const search = view.sidebar().querySelector<HTMLInputElement>('input.search')!;
  assert.equal(search.getAttribute('aria-label'), 'Search messages');
  await act(async () => typeInto(search, 'zzz-no-such-thing'));
  await settle();
  assert.equal(view.host.querySelector('main.desk h1')?.textContent, 'Search');
  assert.equal(view.sidebar().querySelectorAll('button').length, before, 'every sidebar item is still listed');
  assert.ok(view.navButton(/# general/));
  assert.equal(view.sidebar().querySelector('.roster-empty'), null, 'no false "no brains or workers" state');
  await act(async () => view.navButton(/^# general/)!.click());
  assert.equal(search.value, '', 'navigating closes the search view');
  assert.notEqual(view.host.querySelector('main.desk h1')?.textContent, 'Search');
});

test('Cmd/Ctrl+K opens a keyboard-driven switcher over channels, DMs, agents and projects', async t => {
  const { hive, home, other } = fixture(t);
  const brain = hive.identity.join({ role: 'brain', project: home.slug }).agent;
  hive.channels.createChannel(brain, { name: 'release-train', type: 'public' });
  hive.channels.createChannel(brain, { name: 'release-notes', type: 'public' });
  localStorage.clear();
  const view = await mount(t, hive, `#/inbox/${home.slug}`);
  await key({ key: 'k', ctrlKey: true });
  const dialog = () => view.host.querySelector('[role="dialog"][aria-label="Jump to"]');
  assert.ok(dialog(), 'Ctrl+K opens the switcher');
  const combobox = () => dialog()!.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const input = combobox();
  assert.equal(document.activeElement, input);
  const type = (value: string) => act(async () => typeInto(combobox(), value));
  const options = () => [...dialog()!.querySelectorAll('[role="option"]')].map(option => option.querySelector('.switcher-label')?.textContent);
  await type('release');
  assert.deepEqual(options(), ['# release-notes', '# release-train']);
  assert.equal(dialog()!.querySelector('[aria-selected="true"] .switcher-label')?.textContent, '# release-notes');
  await act(async () => fire(input, keydown({ key: 'ArrowDown' })));
  assert.equal(input.getAttribute('aria-activedescendant'), dialog()!.querySelector('[aria-selected="true"]')!.id);
  assert.equal(dialog()!.querySelector('[aria-selected="true"] .switcher-label')?.textContent, '# release-train');
  await act(async () => fire(input, keydown({ key: 'Enter' })));
  assert.ok(!dialog(), 'choosing closes the switcher');
  const train = hive.channels.listChannels(hive.identity.getAgent('human')).find(channel => channel.name === 'release-train')!;
  assert.equal(window.location.hash, `#/c/${train.id}`);

  await key({ key: 'K', metaKey: true });
  await type(brain.name.slice(0, 4));
  assert.ok(options().includes(brain.name), 'agents are listed');
  await type('other pl');
  assert.deepEqual(options(), ['Other Place']);
  await act(async () => (dialog()!.querySelector('[role="option"]') as HTMLElement).click());
  assert.equal(window.location.hash, `#/inbox/${other.slug}`);
  await key({ key: 'k', ctrlKey: true });
  assert.ok(dialog());
  await act(async () => fire(combobox(), keydown({ key: 'Escape' })));
  assert.ok(!dialog(), 'Escape closes it');
});

test('Decisions carries an awaiting count and the roster says what each agent is doing', async t => {
  const { hive, home } = fixture(t);
  const brain = hive.identity.join({ role: 'brain', project: home.slug }).agent;
  const worker = hive.identity.join({ role: 'worker', project: home.slug, seniority: 'mid' }).agent;
  localStorage.clear();
  const view = await mount(t, hive, `#/inbox/${home.slug}`);
  const decisions = () => view.navButton(/^Decisions/)!;
  assert.equal(decisions().querySelector('em'), null, 'no badge while nothing awaits');
  const status = (agent: Agent) => [...view.sidebar().querySelectorAll('.person')]
    .find(row => row.querySelector('.pn')?.textContent === agent.name)?.querySelector('.person-status')?.textContent;
  assert.equal(status(worker), 'idle');

  let n = 0;
  const task = hive.tasks.assign(brain, { requestId: 'task', worker: worker.name, contract: { objective: 'Draft the API',
    scope: [], nonGoals: [], acceptanceCriteria: ['Reviewed'], dependencies: [], evidenceSeqs: [] } }).task;
  const event = (actor: Agent, action: TaskAction) =>
    hive.tasks.event(actor, task.id, { requestId: `e-${++n}`, expectedRevision: hive.tasks.get(actor, task.id).revision, action });
  await act(async () => { event(worker, { type: 'accept' }); event(worker, { type: 'block', needed: 'API contract' }); });
  await settle();
  assert.equal(status(worker), 'blocked: API contract');
  assert.equal(status(brain), 'coordinating 1 task');

  await act(async () => {
    hive.decisions.create(brain, { requestId: 'd', taskId: task.id, expectedTaskRevision: hive.tasks.get(brain, task.id).revision,
      question: 'Which contract?', options: [{ id: 'a', label: 'A', impact: 'x' }, { id: 'b', label: 'B', impact: 'y' }],
      recommendation: { optionId: 'a', rationale: 'Simple', uncertainty: 'Low' },
      evidenceSeqs: [], artifacts: [], affectedWorkers: [worker.name], relatedDecisionIds: [] });
  });
  await settle();
  assert.equal(decisions().querySelector('em.nav-alert')?.textContent, '1');
  assert.match(view.railButton(new RegExp(home.name))!.getAttribute('aria-label')!, /1 decision awaiting/);
  assert.ok(view.host.querySelector('.rail-project .rail-decision'));
});

test('the page title counts what is waiting for the Human', async t => {
  const { hive, home } = fixture(t);
  const brain = hive.identity.join({ role: 'brain', project: home.slug }).agent;
  localStorage.clear();
  const view = await mount(t, hive, `#/inbox/${home.slug}`);
  assert.equal(document.title, 'hivemind');
  const general = hive.channels.listChannels(brain).find(channel => channel.name === 'general' && channel.project === home.slug)!;
  await act(async () => { hive.messages.postMessage(brain, { channel: general.id, body: '@Human please look' }); });
  await settle();
  assert.equal(document.title, '(1) hivemind');
  assert.match(view.railButton(new RegExp(home.name))!.getAttribute('aria-label')!, /1 unread for you/);
});
