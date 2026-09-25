import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';
import { saveAdaptiveRouting } from '../src/server/adaptive-config.ts';
import { App } from './App.tsx';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  location: window.location, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

class IdleSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close() { this.onclose?.(); }
}

async function mount(t: import('node:test').TestContext, hash: string, { jev = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routing-log-nav-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  if (jev) saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  const app = createApp(hive);
  window.happyDOM.setURL(`http://localhost/${hash}`);
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/session') return Response.json({ ok: true });
    return app.request(url, init);
  });
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = IdleSocket as unknown as typeof WebSocket;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.WebSocket = originalSocket; host.remove();
    await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  await act(async () => root.render(<App />));
  const slug = hive.projects.listProjects()[0]!.slug;
  const button = (text: string | RegExp, scope: ParentNode = host) => [...scope.querySelectorAll('button')]
    .find(item => typeof text === 'string' ? item.textContent?.trim() === text : text.test(item.textContent ?? '')) as HTMLButtonElement | undefined;
  return { hive, host, slug, button };
}

test('a project without agents offers Launch agent in the sidebar and in the roster, without opening Settings', async t => {
  const { host, button } = await mount(t, '#/c/general');
  const sidebar = host.querySelector('aside.rail')!;
  const top = sidebar.querySelector<HTMLButtonElement>(':scope > .launch-cta');
  assert.ok(top, 'A visible Launch agent button sits in the sidebar');
  assert.match(top.textContent!, /Launch agent/);
  assert.equal(top.closest('details'), null, 'It is not hidden inside the Settings menu');
  const empty = sidebar.querySelector('.roster-empty');
  assert.ok(empty, 'An empty roster explains what to do');
  assert.match(empty.textContent!, /No brains or workers/);
  const cta = button('Launch an agent', empty);
  assert.ok(cta);
  await act(async () => cta.click());
  assert.ok(host.querySelector('[role="dialog"][aria-label="Launch agent"]'), 'The call to action opens the Launch sheet');
});

test('the Routing log replaces the Jev nav label and #/jev stays an alias', async t => {
  const { host, slug, button } = await mount(t, '#/jev/placeholder', { jev: true });
  // Alias: the legacy hash opens the Routing log (repaired to an existing project).
  assert.equal(host.querySelector('main.desk h1')?.textContent, 'Routing log');
  assert.match(host.querySelector('main.desk')!.textContent!, /Every request Hivemind sent to Jev \(TypeSafe\) and its answer/);
  assert.equal(button('Jev'), undefined, 'No sidebar item is labelled just "Jev"');
  await act(async () => { window.happyDOM.setURL(`http://localhost/#/c/general`); window.dispatchEvent(new window.HashChangeEvent('hashchange')); });
  const nav = button('Routing log');
  assert.ok(nav);
  await act(async () => nav.click());
  assert.equal(window.location.hash, `#/routing-log/${slug}`);
  assert.equal(host.querySelector('main.desk h1')?.textContent, 'Routing log');
});

test('without Jev the sidebar has no Routing log and its link opens For you', async t => {
  const { host, slug, button } = await mount(t, '#/routing-log/placeholder');
  assert.equal(window.location.hash, `#/inbox/${slug}`);
  assert.equal(host.querySelector('main.desk h1')?.textContent, 'For you');
  assert.equal(button('Routing log'), undefined);
});

test('Help leads with Launch agent and resume by name, and states who can start conversations', async t => {
  const { host, button } = await mount(t, '#/c/general');
  const help = host.querySelector<HTMLButtonElement>('[title="How to join"]');
  assert.ok(help);
  await act(async () => help.click());
  const sheet = [...host.querySelectorAll('.sheet')].find(item => item.querySelector('h2')?.textContent === 'How to join')!;
  assert.ok(sheet);
  const text = sheet.textContent!;
  assert.match(text, /Launch agent/);
  assert.match(text, /resume=NAME/);
  assert.match(text, /Workers only start conversations with brains; you can DM anyone\./);
  assert.doesNotMatch(text, /HIVEMIND_TOKEN|hm_…/);
  assert.doesNotMatch(text, /Workers talk to brains only/);
  const launch = button('Launch agent', sheet);
  assert.ok(launch);
  await act(async () => launch.click());
  assert.ok(host.querySelector('[role="dialog"][aria-label="Launch agent"]'));
});
