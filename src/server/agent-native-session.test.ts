import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, LATEST_VERSION } from './migrations/index.ts';
import { agentNativeSessions } from './migrations/agent-native-sessions.ts';

const metadata = { software: 'codex' as const, sessionId: '67d735d1-9e33-4a61-9645-a931afc97f2b', model: 'fixture-model', effort: 'high' as const };
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-session-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const r = await app.request(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  return { hive, call };
}

test('join stores native metadata only in project-scoped Human launch context, not shared roster or snapshots', async t => {
  const { hive, call } = fixture(t);
  const project = hive.projects.listProjects()[0]!;
  const joined = await call('POST', '/api/agent/join', { role: 'brain', project: project.slug, nativeSession: metadata });
  assert.equal(joined.status, 200);
  const id = joined.body.agent.id;
  assert.deepEqual(hive.identity.nativeSession(id), metadata);
  const context = await call('GET', `/api/ui/launch-context?project=${project.slug}`);
  assert.equal(context.status, 200);
  assert.deepEqual(context.body.nativeSessions[id], metadata);
  assert.deepEqual((await call('GET', '/api/ui/launch-context')).body.nativeSessions, {});
  for (const endpoint of ['/api/agent/agents', '/api/agent/me']) {
    const response = await call('GET', endpoint, undefined, joined.body.token);
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.body).includes(metadata.sessionId));
  }
  const snapshot = await call('GET', '/api/ui/snapshot');
  assert.equal(snapshot.status, 200);
  assert.ok(!JSON.stringify(snapshot.body).includes(metadata.sessionId));
  const human = hive.identity.getAgent('human');
  hive.projects.createProject(human, { name: 'Side', slug: 'side' });
  const other = hive.identity.join({ role: 'brain', project: 'side', nativeSession: { ...metadata, software: 'claude' } });
  assert.deepEqual((await call('GET', `/api/ui/launch-context?project=${project.slug}`)).body.nativeSessions, { [id]: metadata });
  assert.deepEqual((await call('GET', '/api/ui/launch-context?project=side')).body.nativeSessions,
    { [other.agent.id]: { ...metadata, software: 'claude' } });
  assert.equal((await call('GET', `/api/ui/launch-context?project=${project.slug}`, undefined, joined.body.token)).status, 403);
});

test('reported sessions survive server restart and identity rename, but cannot revive a removed employee', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-session-restart-'));
  const file = path.join(dir, 'hive.db');
  let hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = hive.identity.join({ role: 'brain', nativeSession: metadata });
  await hive.adaptiveTopology.stop(); hive.db.close();
  hive = new Hive(file);
  assert.deepEqual(hive.identity.nativeSession(first.agent.id), metadata);
  const human = hive.identity.getAgent('human');
  const renamed = hive.identity.editIdentity(human, first.agent.id,
    { expectedRevision: first.agent.identityRevision!, name: 'RenamedBrain' });
  assert.deepEqual(hive.identity.nativeSession(renamed.id), metadata);
  const app = createApp(hive);
  const removed = await app.request(`/api/ui/agents/${renamed.name}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const context = await app.request(`/api/ui/launch-context?project=${renamed.project}`);
  assert.deepEqual((await context.json() as { nativeSessions: object }).nativeSessions, {});
  assert.throws(() => hive.identity.join({ role: 'brain', resumeName: renamed.name, nativeSession: metadata }), /removed/);
});

test('same-session retries preserve metadata; a new unreported session clears it rather than resuming stale context', t => {
  const { hive } = fixture(t);
  const first = hive.identity.join({ role: 'brain', nativeSession: metadata });
  hive.identity.join({ role: 'brain', token: first.token });
  assert.deepEqual(hive.identity.nativeSession(first.agent.id), metadata);
  hive.identity.join({ role: 'brain', resumeName: first.agent.name });
  assert.equal(hive.identity.nativeSession(first.agent.id), null);
  hive.identity.join({ role: 'brain', resumeName: first.agent.name, nativeSession: { ...metadata, software: 'claude', sessionId: null } });
  assert.equal(hive.identity.nativeSession(first.agent.id)?.software, 'claude');
  assert.equal(hive.identity.nativeSession(first.agent.id)?.sessionId, null);
});

test('invalid reported metadata is rejected before joining or changing identity', async t => {
  const { hive, call } = fixture(t);
  for (const patch of [{ software: 'rm' }, { sessionId: '--last' }, { model: 'x;bad' }, { effort: 'unknown' }, { token: 'secret' }]) {
    const r = await call('POST', '/api/agent/join', { role: 'brain', nativeSession: { ...metadata, ...patch } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /nativeSession/);
  }
  assert.equal(hive.identity.listAgents().filter(a => a.role === 'brain').length, 0);
});

test('migration preserves an existing database and does not invent provider sessions', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, { target: 40 });
  const agents = db.prepare('SELECT * FROM agents').all();
  assert.deepEqual(applyMigrations(db).map(m => m.name), ['agent_native_sessions', 'launch_sessions', 'launch_session_fencing']);
  assert.deepEqual(db.prepare('SELECT * FROM agents').all(), agents);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_native_sessions').get() as { n: number }).n, 0);
  agentNativeSessions(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, LATEST_VERSION);
});
