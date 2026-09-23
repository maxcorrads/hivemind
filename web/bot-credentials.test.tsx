import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';
import { BotCredentials, BotSetup } from './Bots.tsx';
import type { Agent } from '../src/shared/types.ts';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
after(() => window.happyDOM.close());

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-credential-ui-'));
  const hive = new Hive(path.join(dir, 'hive.db')), human = hive.getAgent('human');
  const project = hive.listProjects()[0]!, bot = hive.createBot(human, project.id, { name: 'FixtureFeed' });
  const app = createApp(hive); let lose = false, lostToken = '', posts = 0, refreshed = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    // Mounted component fixture uses the internal Hono router, not a network
    // adapter. Model only bootstrap here; real cookies/transport rejection and
    // exactly-once mutations are exercised in extensibility-session.test.ts.
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    const response = await app.request(url, init);
    if (init?.method === 'POST') {
      posts++;
      if (response.ok && lose) {
        lose = false; lostToken = (await response.json() as { token: string }).token;
        throw new TypeError('Fixture lost response after commit');
      }
    }
    return response;
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const onBusy = () => {};
  const manage = async (agent: Agent = bot.bot, key = agent.id) => {
    await act(async () => root.render(<BotCredentials key={key} bot={agent} onBusy={onBusy} />));
  };
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
  const click = async (label: string) => { const b = button(label); assert.ok(b, label); await act(async () => b.click()); };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { hive, human, project, bot, host, manage, click, button, lose: () => { lose = true; },
    secret: () => host.querySelector<HTMLInputElement>('input[aria-label="New bot token"]'),
    status: () => hive.botCredential(human, project.id, bot.bot.id).credential,
    posts: () => posts, lostToken: () => lostToken, refreshed: () => refreshed,
    create: async () => { await act(async () => root.render(<BotSetup project={project} onBusy={onBusy} onCreated={() => { refreshed++; }} />)); },
    name: async (value: string) => { await act(async () => {
      const el = host.querySelector('input')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    }); } };
}

test('mounted Human panel confirms rotate/revoke and never restores a hidden token', async t => {
  const f = await fixture(t); await f.manage(); await f.click('Rotate token');
  assert.equal(f.posts(), 0); await f.click('Cancel'); assert.equal(f.status().revision, 1);
  await f.click('Rotate token'); await f.click('Confirm rotation');
  const token = f.secret()!.value; assert.equal(f.secret()!.type, 'password');
  assert.equal(f.hive.agentByToken(token).id, f.bot.bot.id);
  assert.throws(() => f.hive.agentByToken(f.bot.token), /Invalid token/);
  await f.click('Rotate token'); await f.click('Cancel');
  assert.equal(f.secret()?.value, token, 'Cancelling must not discard the still-valid one-time token');
  await f.click('Hide token'); assert.equal(f.secret(), null);
  await f.manage(f.bot.bot, 'reopened-panel'); assert.equal(f.secret(), null);
  assert.match(f.host.textContent!, /revision 2/);
  await f.click('Revoke token'); await f.click('Confirm revocation');
  assert.equal(f.secret(), null); assert.equal(f.status().revoked, true);
  assert.throws(() => f.hive.agentByToken(token), /Invalid token/);
  assert.ok(f.button('Revoke token')!.disabled);
  assert.equal(window.localStorage.length, 0); assert.equal(window.sessionStorage.length, 0);
});

test('lost rotation response never automatically rotates again and requires reloading the revision', async t => {
  const f = await fixture(t); await f.manage(); await f.click('Rotate token'); f.lose(); await f.click('Confirm rotation');
  assert.equal(f.posts(), 1); assert.equal(f.status().revision, 2); assert.equal(f.secret(), null);
  assert.match(f.host.textContent!, /outcome may be unknown/); assert.ok(f.button('Rotate token')!.disabled);
  const lost = f.lostToken(); assert.equal(f.hive.agentByToken(lost).id, f.bot.bot.id);
  await f.click('Reload credential state'); assert.match(f.host.textContent!, /revision 2/);
  await f.click('Rotate token'); await f.click('Confirm rotation');
  assert.equal(f.posts(), 2); assert.equal(f.status().revision, 3);
  assert.throws(() => f.hive.agentByToken(lost), /Invalid token/);
  assert.equal(f.hive.agentByToken(f.secret()!.value).id, f.bot.bot.id);
});

test('lost creation response refreshes discovery and the same bot can be recovered', async t => {
  const f = await fixture(t); await f.create(); await f.name('RecoverableFeed'); f.lose(); await f.click('Create bot');
  assert.equal(f.refreshed(), 1); assert.match(f.host.textContent!, /open Credentials/);
  const discovered = f.hive.listAgents(f.human).find(a => a.name === 'RecoverableFeed')!;
  assert.ok(discovered); const lost = f.lostToken();
  await f.manage(discovered); await f.click('Rotate token'); await f.click('Confirm rotation');
  assert.equal(f.hive.agentByToken(f.secret()!.value).id, discovered.id);
  assert.throws(() => f.hive.agentByToken(lost), /Invalid token/);
  assert.equal(f.hive.listAgents(f.human).filter(a => a.name === 'RecoverableFeed').length, 1);
});

test('a stale Human panel cannot revoke a newer credential', async t => {
  const f = await fixture(t); await f.manage(); await f.click('Revoke token');
  const newer = f.hive.changeBotCredential(f.human, f.project.id, f.bot.bot.id, { action: 'rotate', expectedRevision: 1 });
  await f.click('Confirm revocation');
  assert.equal(f.hive.agentByToken(newer.token!).id, f.bot.bot.id);
  assert.match(f.host.textContent!, /credential changed/); assert.ok(f.button('Revoke token')!.disabled);
  await f.click('Reload credential state'); await f.click('Revoke token'); await f.click('Confirm revocation');
  assert.throws(() => f.hive.agentByToken(newer.token!), /Invalid token/);
});

