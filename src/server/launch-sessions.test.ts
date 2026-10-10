import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { listRows, setAgentPresence, updateRows } from './test-fixtures.ts';
import type { LaunchSettings } from '../shared/launch-settings.ts';

const uuid = '67d735d1-9e33-4a61-9645-a931afc97f2b';
const settings: LaunchSettings = { software: 'codex-work', model: 'fixture-model', effort: 'high', extraFlags: '--search',
  environment: { CODEX_HOME: '/fixture/work-profile' }, workspacePath: '/fixture/project', cdWorktree: true,
  passProject: true, adoptUntrusted: true, role: 'brain', seniority: null, focus: 'coord' };

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-tracked-launch-'));
  const file = path.join(dir, 'hive.db'), hive = new Hive(file), app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = hive.projects.listProjects()[0]!;
  const call = async (method: string, url: string, body?: unknown, token?: string, extraHeaders = {}) => {
    const response = await app.request(url, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const prepare = async (software = 'codex-work', extra = {}) => {
    const result = await call('POST', '/api/ui/launch-prepare', { project: project.slug,
      settings: { ...settings, software }, ...extra });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const ticket = /hml_[a-f0-9]{64}/.exec(result.body.command)?.[0];
    assert.ok(ticket);
    return { ticket, command: String(result.body.command) };
  };
  const join = (ticket: string, extra = {}, token?: string) => call('POST', '/api/agent/join',
    { role: 'brain', project: project.slug, launchTicket: ticket, ...extra }, token);
  const capture = (ticket: string, sessionId = uuid) => call('POST', '/api/launch-session/capture', { sessionId }, ticket);
  return { hive, project, call, prepare, join, capture, file };
}

test('Human launch stores exact configuration, binds automatically, ignores model-reported settings and survives restart', async t => {
  const f = fixture(t), { ticket, command } = await f.prepare();
  assert.match(command, /hooks.SessionStart/);
  assert.doesNotMatch(command, /Include nativeSession=/);
  assert.equal((await f.join(ticket)).status, 409, 'no fabricated conversation when hook did not run');
  assert.equal(f.hive.identity.listAgents().filter(a => a.role === 'brain').length, 0);
  assert.equal((await f.capture(ticket)).status, 200);
  const joined = await f.join(ticket, { nativeSession: { software: 'claude', sessionId: null, model: 'wrong', effort: 'low' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const agent = joined.body.agent;
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), { settings, sessionId: uuid, captured: true });
  assert.equal(f.hive.identity.nativeSession(agent.id)!.software, 'codex');
  assert.equal((await f.join(ticket, { resume: agent.name }, joined.body.token)).status, 200);
  assert.equal((await f.join(ticket)).status, 409, 'reusing a pasted initial command never creates another identity');
  const rows = JSON.stringify(listRows(f.hive, 'launch_sessions'));
  assert.ok(!rows.includes(ticket) && !rows.includes('/fixture/work-profile'), 'ticket hashed and profile encrypted at rest');
  const context = await f.call('GET', `/api/ui/launch-context?project=${f.project.slug}`);
  assert.deepEqual(context.body.savedLaunches[agent.id].settings, settings);
  for (const endpoint of ['/api/ui/snapshot', '/api/agent/agents']) {
    const result = await f.call('GET', endpoint, undefined, endpoint.includes('/agent/') ? joined.body.token : undefined);
    assert.ok(!JSON.stringify(result.body).includes(uuid));
    assert.ok(!JSON.stringify(result.body).includes('/fixture/work-profile'));
  }
  const reopened = new Hive(f.file);
  try { assert.deepEqual(reopened.launchSessions.saved(agent.id), f.hive.launchSessions.saved(agent.id)); }
  finally { await reopened.adaptiveTopology.stop(); reopened.db.close(); }
});

test('Claude has an assigned exact UUID and Cursor captures create-chat output without model reporting', async t => {
  const f = fixture(t);
  const claude = await f.prepare('claude-work');
  const id = /--session-id '([^']+)'/.exec(claude.command)?.[1];
  assert.ok(id);
  const joined = await f.join(claude.ticket);
  assert.equal(joined.status, 200);
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)!.sessionId, id);
  const cursor = await f.prepare('cursor-agent');
  assert.match(cursor.command, /cursor-agent --model fixture-model --search create-chat/);
  assert.match(cursor.command, /--resume "\$_hivemind_chat_id"/);
  assert.equal((await f.join(cursor.ticket)).status, 409);
  assert.equal((await f.capture(cursor.ticket, 'chat_fixture-123')).status, 200);
  const cursorJoin = await f.join(cursor.ticket);
  assert.equal(cursorJoin.status, 200);
  assert.equal(f.hive.identity.nativeSession(cursorJoin.body.agent.id)!.sessionId, 'chat_fixture-123');
});

test('an explicit reconnect keeps the current launch and fences the old process without admitting a different identity', async t => {
  const f = fixture(t), { ticket } = await f.prepare('claude-work');
  const first = await f.join(ticket), agent = first.body.agent;
  const saved = f.hive.launchSessions.saved(agent.id);
  const other = f.hive.identity.join({ role: 'brain', project: f.project.slug }).agent;
  assert.equal((await f.join(ticket)).status, 409, 'replaying a new-agent launch cannot allocate another employee');
  assert.equal((await f.join(ticket, { resume: other.name })).status, 409);
  assert.equal((await f.join(ticket, { resume: agent.name, role: 'worker' })).status, 409);
  const reconnect = await f.join(ticket, { resume: agent.name });
  assert.equal(reconnect.status, 200, JSON.stringify(reconnect.body));
  assert.equal(reconnect.body.agent.id, agent.id);
  assert.equal(reconnect.body.created, false);
  assert.notEqual(reconnect.body.token, first.body.token);
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), saved);
  assert.equal((await f.join(ticket, { resume: agent.name }, first.body.token)).status, 401, 'a stale authenticated process cannot reconnect itself');
  assert.equal((await f.join(ticket, { resume: agent.name }, reconnect.body.token)).status, 200);
  const renamed = f.hive.identity.editIdentity(f.hive.identity.getAgent('human'), agent.id,
    { expectedRevision: agent.identityRevision, name: 'ReconnectedBrain' });
  const viaAlias = await f.join(ticket, { resume: agent.name });
  assert.equal(viaAlias.status, 200, JSON.stringify(viaAlias.body));
  assert.equal(viaAlias.body.agent.name, renamed.name);
  assert.equal((await f.call('POST', '/api/agent/join', { role: 'brain', project: f.project.slug, resume: renamed.name })).status, 200);
  assert.equal((await f.join(ticket, { resume: renamed.name })).status, 409, 'an untracked replacement invalidates old launch reconnects');
});

test('launch reconnects cannot revive removed employees', async t => {
  const f = fixture(t), { ticket } = await f.prepare('claude-work');
  const joined = await f.join(ticket), agent = joined.body.agent;
  assert.equal((await f.call('DELETE', `/api/ui/agents/${agent.name}`)).status, 200);
  const result = await f.join(ticket, { resume: agent.name });
  assert.equal(result.status, 410);
  assert.equal(f.hive.identity.getAgent(agent.id).online, false);
});

test('resume is bound to the immutable employee/project; wrong IDs, reuse and foreign callbacks fail closed', async t => {
  const f = fixture(t), first = await f.prepare();
  await f.capture(first.ticket);
  const joined = await f.join(first.ticket), agent = joined.body.agent;
  const other = f.hive.identity.join({ role: 'brain', project: f.project.slug }).agent;
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const next = await f.prepare('codex-work', { agentId: agent.id, native: true, sessionId: uuid });
  const stale = await f.prepare('codex-work', { agentId: agent.id, native: true, sessionId: uuid });
  assert.equal((await f.capture(next.ticket, '019b2800-1234-7000-8000-000000000002')).status, 409);
  assert.equal((await f.capture(next.ticket)).status, 200);
  assert.equal((await f.join(next.ticket, { resume: other.name })).status, 409);
  const count = f.hive.identity.listAgents().length;
  assert.equal((await f.join(next.ticket)).status, 409, 'no resume argument must roll the unintended new join back');
  assert.equal(f.hive.identity.listAgents().length, count);
  const resumed = await f.join(next.ticket, { resume: agent.name });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.agent.id, agent.id);
  await f.capture(stale.ticket);
  assert.equal((await f.join(stale.ticket, { resume: agent.name })).status, 409, 'an older prepared command cannot supersede a newer join');
  assert.equal((await f.join(first.ticket, { resume: agent.name }, resumed.body.token)).status, 409);
  assert.equal((await f.join(first.ticket, { resume: agent.name })).status, 409, 'reconnect cannot reclaim a superseded launch');
  assert.equal((await f.call('POST', '/api/launch-session/capture', { sessionId: uuid }, next.ticket,
    { origin: 'http://localhost' })).status, 403);
  assert.equal((await f.capture(`hml_${'f'.repeat(64)}`)).status, 409);
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: f.project.slug, settings }, resumed.body.token)).status, 403);
  const manual = await f.call('POST', '/api/agent/join', { role: 'brain', project: f.project.slug, resume: agent.name });
  assert.equal(manual.status, 200);
  assert.equal(f.hive.launchSessions.saved(agent.id), null, 'untracked replacement cannot restore a stale tracked conversation');
});

test('new launches do not overwrite saved settings until join; metadata never crosses projects', async t => {
  const f = fixture(t), initial = await f.prepare('claude-work'), joined = await f.join(initial.ticket);
  const agent = joined.body.agent, original = f.hive.launchSessions.saved(agent.id);
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  await f.prepare('codex-another', { agentId: agent.id });
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), original);
  const side = f.hive.projects.createProject(f.hive.identity.getAgent('human'), { name: 'Side', slug: 'side' });
  assert.deepEqual((await f.call('GET', `/api/ui/launch-context?project=${side.slug}`)).body.savedLaunches, {});
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: side.slug, agentId: agent.id, settings })).status, 409);
  const pending = await f.prepare('claude-work');
  assert.equal((await f.join(pending.ticket, { project: side.slug })).status, 409);
});

for (const role of ['brain', 'worker'] as const) test(`an untracked ${role} reconnect invalidates a pending legacy resume without saved settings`, async t => {
  const f = fixture(t);
  const input = { role, seniority: role === 'worker' ? 'senior' : null, project: f.project.slug };
  const first = await f.call('POST', '/api/agent/join', input), agent = first.body.agent;
  assert.equal(first.status, 200);
  assert.equal(f.hive.launchSessions.saved(agent.id), null);
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const older = await f.prepare('claude-work', { agentId: agent.id,
    settings: { ...settings, software: 'claude-work', role, seniority: input.seniority } });
  const nativeSession = { software: 'claude', sessionId: uuid, model: 'newer-model', effort: 'low' };
  const newer = await f.call('POST', '/api/agent/join', { ...input, resume: agent.name, nativeSession });
  assert.equal(newer.status, 200);
  assert.equal(f.hive.launchSessions.saved(agent.id), null, 'the optional launch pointer never changed');
  const fingerprint = f.hive.identity.sessionFingerprint(agent.id);
  assert.equal((await f.join(older.ticket, { role, resume: agent.name })).status, 409);
  assert.equal(f.hive.identity.sessionFingerprint(agent.id), fingerprint, 'a stale command cannot fence the newer client');
  assert.equal(f.hive.identity.agentByToken(newer.body.token).id, agent.id);
  assert.deepEqual(f.hive.identity.nativeSession(agent.id), nativeSession);
  assert.equal(f.hive.launchSessions.saved(agent.id), null);
});

test('a bound MCP reconnect invalidates older prepared resumes even while the saved launch pointer stays unchanged', async t => {
  const f = fixture(t), initial = await f.prepare('claude-work'), first = await f.join(initial.ticket);
  const agent = first.body.agent, saved = f.hive.launchSessions.saved(agent.id);
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const older = await f.prepare('claude-work', { agentId: agent.id });
  const newer = await f.join(initial.ticket, { resume: agent.name });
  assert.equal(newer.status, 200);
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), saved);
  assert.equal((await f.join(older.ticket, { resume: agent.name })).status, 409);
  assert.equal(f.hive.identity.agentByToken(newer.body.token).id, agent.id);
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), saved);
});

test('same-session activity and a server restart do not invalidate a prepared resume', async t => {
  const f = fixture(t), first = await f.call('POST', '/api/agent/join', { role: 'brain', project: f.project.slug });
  const agent = first.body.agent;
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const prepared = await f.prepare('claude-work', { agentId: agent.id });
  assert.equal((await f.call('POST', '/api/agent/join', { role: 'brain', project: f.project.slug }, first.body.token)).status, 200);
  const reopened = new Hive(f.file);
  try {
    const response = await createApp(reopened).request('/api/agent/join', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'brain', project: f.project.slug,
        resume: agent.name, launchTicket: prepared.ticket }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { agent: { id: string } }).agent.id, agent.id);
  } finally { await reopened.adaptiveTopology.stop(); reopened.db.close(); }
});

test('pre-migration pending resumes fail closed but bound launches can still reconnect', async t => {
  const f = fixture(t), initial = await f.prepare('claude-work'), first = await f.join(initial.ticket);
  const agent = first.body.agent, saved = f.hive.launchSessions.saved(agent.id);
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const prepared = await f.prepare('claude-work', { agentId: agent.id });
  // Migration 43 leaves this field null rather than trusting today's key for an old command.
  updateRows(f.hive, 'launch_sessions', { previous_session_fingerprint: null });
  assert.equal((await f.join(prepared.ticket, { resume: agent.name })).status, 409);
  assert.equal(f.hive.identity.agentByToken(first.body.token).id, agent.id);
  assert.equal((await f.join(initial.ticket, { resume: agent.name })).status, 200);
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), saved);
});

test('tracked joins keep the selected project even when the prompt omits it, and normalize launch choices', async t => {
  const f = fixture(t);
  const side = f.hive.projects.createProject(f.hive.identity.getAgent('human'), { name: 'Side', slug: 'side' });
  const result = await f.call('POST', '/api/ui/launch-prepare', { project: side.slug,
    settings: { ...settings, software: 'claude-work', model: ' fixture-model ', effort: 'HIGH', passProject: false } });
  assert.equal(result.status, 200);
  const ticket = /hml_[a-f0-9]{64}/.exec(result.body.command)![0];
  const joined = await f.join(ticket, { project: null });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.agent.projectId, side.id);
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)?.settings.model, 'fixture-model');
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)?.settings.effort, 'high');
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: side.slug,
    settings: { ...settings, extraFlags: '--last' } })).status, 400);
});
