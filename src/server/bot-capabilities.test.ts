import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { registerBotDefinition, saveProjectBotConfiguration, callProjectBot, connectProjectBot } from './bot-definitions.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-bot-capabilities-'));
  const hive = new Hive(path.join(dir, 'hive', 'hive.db'));
  t.after(() => { hive.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human'), project = hive.projects.listProjects()[0]!;
  const brain = hive.identity.join({ role: 'brain', project: project.slug });
  const worker = hive.identity.join({ role: 'worker', seniority: 'senior', project: project.slug });
  const created = hive.bots.createBot(human, project.id, { name: 'Feed' });
  const channel = hive.channels.createChannel(human, { name: 'FeedRoom', type: 'private', project: project.slug, memberNames: [created.bot.name, brain.agent.name] });
  const app = createApp(hive);
  const request = (url: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST') => app.request(url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const access = (changes: Record<string, unknown>) => hive.bots.setAccess(human, project.id, created.bot.id, {
    capabilities: ['publish'], receiveChannels: [], definitionId: null, expectedRevision: hive.bots.access(created.bot).revision, ...changes,
  });
  return { dir, hive, human, project, brain, worker, created, channel, request, access };
}

test('bot capabilities are independent, revision fenced and Human-controlled', t => {
  const f = fixture(t);
  assert.deepEqual(f.hive.bots.access(f.created.bot).capabilities, ['publish']);
  f.access({ capabilities: ['receive'], receiveChannels: [f.channel.id] });
  assert.throws(() => f.hive.bots.postBotMessage(f.created.bot, f.channel.id, { eventId: 'one', body: 'No publishing' }), /disabled: publish/);
  assert.throws(() => f.hive.bots.setAccess(f.brain.agent, f.project.id, f.created.bot.id, {}), /Invalid bot/);
  assert.throws(() => f.access({ expectedRevision: 1 }), /changed/);
  const valid = { capabilities: ['receive'], receiveChannels: [f.channel.id], definitionId: null, expectedRevision: 2 };
  for (const actor of [f.brain.agent, f.worker.agent, f.created.bot])
    assert.throws(() => f.hive.bots.setAccess(actor, f.project.id, f.created.bot.id, valid), /Only Human/);
  assert.throws(() => f.access({ capabilities: ['tools'] }), /Invalid bot/);
  assert.throws(() => f.access({ capabilities: ['receive', 'receive'] }), /Invalid bot/);
});

test('Receive requires a grant plus selected membership, paginates and does not consume inbox/read state', async t => {
  const f = fixture(t), url = `/api/bot/channels/${f.channel.id}/messages`;
  assert.equal((await f.request(url, undefined, f.created.token)).status, 403);
  f.access({ capabilities: ['receive'], receiveChannels: [f.channel.id] });
  const one = f.hive.messages.postMessage(f.human, { channel: f.channel.id, body: 'First context' });
  const two = f.hive.messages.postMessage(f.human, { channel: f.channel.id, body: 'Second context' });
  const unread = f.hive.reads.readSnapshot(f.human);
  const response = await f.request(url + `?afterSeq=${one.seq - 1}&limit=1`, undefined, f.created.token);
  assert.equal(response.status, 200);
  const page = await response.json() as any;
  assert.equal(page.authority, 'context-only'); assert.equal(page.messages[0].id, one.id); assert.equal(page.hasMore, true);
  const next = await (await f.request(url + `?afterSeq=${page.nextAfterSeq}`, undefined, f.created.token)).json() as any;
  assert.equal(next.messages[0].id, two.id);
  assert.deepEqual(f.hive.reads.readSnapshot(f.human), unread);
  for (const query of ['?limit=0', '?limit=101', '?afterSeq=-1', '?limit=NaN']) assert.equal((await f.request(url + query, undefined, f.created.token)).status, 400);
  f.access({ capabilities: ['receive'] });
  assert.equal((await f.request(url, undefined, f.created.token)).status, 403);
});

test('Receive rejects uninvited channels, DMs and other projects', t => {
  const f = fixture(t);
  const hidden = f.hive.channels.createChannel(f.human, { name: 'Hidden', type: 'private', project: f.project.slug });
  assert.throws(() => f.access({ capabilities: ['receive'], receiveChannels: [hidden.id] }), /invitation/);
  const other = f.hive.projects.createProject(f.human, { name: 'Other', slug: 'other' });
  const ch = f.hive.channels.createChannel(f.human, { name: 'OtherRoom', type: 'public', project: other.slug });
  assert.throws(() => f.access({ capabilities: ['receive'], receiveChannels: [ch.id] }));
  const dm = f.hive.channels.openDm(f.human, f.brain.agent.name);
  assert.throws(() => f.access({ capabilities: ['receive'], receiveChannels: [dm.id] }), /invitation/);
});

test('Receive stores canonical channel IDs when access uses an accepted channel name', async t => {
  const f = fixture(t);
  const saved = f.access({ capabilities: ['receive'], receiveChannels: [`#${f.channel.name}`] });
  assert.deepEqual(saved.receiveChannels, [f.channel.id]);
  const message = f.hive.messages.postMessage(f.human, { channel: f.channel.id, body: 'Named subscription' });
  const response = await f.request(`/api/bot/channels/${f.channel.id}/messages?afterSeq=${message.seq - 1}`, undefined, f.created.token);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).messages[0].id, message.id);
  assert.throws(() => f.access({ capabilities: ['receive'], receiveChannels: [f.channel.id, `#${f.channel.name}`] }), /Duplicate channel/);
  assert.deepEqual(f.hive.bots.access(f.created.bot), saved, 'Rejected aliases must not change the stored grant or revision');
});

async function definition(f: ReturnType<typeof fixture>) {
  const pkg = path.join(f.dir, 'definition'); mkdirSync(pkg);
  writeFileSync(path.join(pkg, 'TOOLS.md'), 'Use only for authorized work.');
  writeFileSync(path.join(pkg, 'tool'), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const input=JSON.parse(raw),home=process.argv[4];if(process.argv[2]==='configure'){fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(input.config));console.log(JSON.stringify({configured:true}));}else if(input.tool==='connect'){fs.writeFileSync(path.join(home,'connection.json'),JSON.stringify(input));console.log(JSON.stringify({connected:true}));}else{console.log(JSON.stringify({tool:input.tool,projectId:input.projectId,botId:input.botId,args:input.arguments}));}});`, { mode: 0o700 });
  const manifest = path.join(pkg, 'hivemind-bot.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, kind: 'bot', id: 'fixture-bot', name: 'Fixture Bot', capabilities: ['publish', 'tools'],
    command: 'tool', instructions: 'TOOLS.md', tools: [{ name: 'status', description: 'Local status', effect: 'read', parameters: { version: 1, fields: [] } }] }));
  registerBotDefinition(f.hive.home, manifest);
  return saveProjectBotConfiguration(f.hive.home, f.project, 'http://localhost', 'fixture-bot', { enabled: true, values: {}, expectedRevision: 0 });
}

test('bot tools are discovered and called only by project brains after explicit grants', async t => {
  const f = fixture(t); await definition(f);
  const route = `/api/agent/bots/${f.created.bot.id}/tools`, call = { tool: 'status', arguments: {} };
  assert.equal((await f.request(route, call, f.brain.token)).status, 403);
  f.access({ capabilities: ['tools'], definitionId: 'fixture-bot' });
  assert.equal((await f.request(route, call, f.worker.token)).status, 403);
  assert.equal((await f.request(route, call, f.created.token)).status, 403);
  const other = f.hive.projects.createProject(f.human, { name: 'Elsewhere', slug: 'elsewhere' });
  const otherBrain = f.hive.identity.join({ role: 'brain', project: other.slug });
  assert.equal((await f.request(route, call, otherBrain.token)).status, 404);
  const list = await (await f.request('/api/agent/bot-tools', undefined, f.brain.token)).json() as any;
  assert.equal(list.bots[0].name, 'Feed'); assert.equal(list.bots[0].tools[0].name, 'status');
  assert.ok(!JSON.stringify(list).includes(f.hive.home));
  const response = await f.request(route, call, f.brain.token); assert.equal(response.status, 200);
  assert.equal((await response.json() as any).result.projectId, f.project.id);
  assert.equal((await f.request(route, { tool: 'unknown', arguments: {} }, f.brain.token)).status, 404);
  assert.equal((await f.request(route, { ...call, arguments: { command: 'anything' } }, f.brain.token)).status, 400);
  f.hive.bots.changeBotCredential(f.human, f.project.id, f.created.bot.id, { action: 'revoke', expectedRevision: 1 });
  assert.equal((await f.request(route, call, f.brain.token)).status, 403);
  assert.deepEqual((await (await f.request('/api/agent/bot-tools', undefined, f.brain.token)).json() as any).bots, []);
});

test('managed setup stores its credential privately and does not return it or create duplicate identities', async t => {
  const f = fixture(t), saved = await definition(f);
  const route = `/api/ui/projects/${f.project.id}/bots/setup`;
  const response = await f.request(route, { name: 'ManagedFeed', definitionId: 'fixture-bot' });
  assert.equal(response.status, 201);
  const result = await response.json() as any; assert.equal(result.connected, true); assert.equal(result.token, undefined);
  const connection = JSON.parse(readFileSync(path.join(saved.home, 'connection.json'), 'utf8'));
  assert.equal(f.hive.identity.agentByToken(connection.token).id, result.bot.id);
  assert.equal(connection.projectId, f.project.id);
  assert.equal((await f.request(route, { name: 'DuplicateFeed', definitionId: 'fixture-bot' })).status, 409);
  const all = await (await f.request(`/api/ui/projects/${f.project.id}/bots`)).text();
  assert.ok(!all.includes(connection.token));
});

test('Human can revoke grants for a broken definition without detaching its identity; new grants still fail closed', async t => {
  const f = fixture(t), saved = await definition(f);
  f.access({ capabilities: ['publish', 'tools'], definitionId: 'fixture-bot' });
  writeFileSync(path.join(saved.home, 'config.json'), 'invalid json');
  const route = `/api/ui/projects/${f.project.id}/bots/${f.created.bot.id}/access`;
  const revoke = { capabilities: ['publish'], receiveChannels: [], definitionId: 'fixture-bot', expectedRevision: 2 };
  assert.equal((await f.request(route, revoke, undefined, 'PUT')).status, 200);
  assert.deepEqual(f.hive.bots.access(f.created.bot).capabilities, ['publish']);
  assert.equal((await f.request(route, { ...revoke, capabilities: ['publish', 'tools'], expectedRevision: 3 }, undefined, 'PUT')).status, 409);
  assert.equal((await f.request(route, { ...revoke, capabilities: [], expectedRevision: 3 }, undefined, 'PUT')).status, 200);
  assert.equal(f.hive.bots.access(f.created.bot).definitionId, 'fixture-bot');
});

test('connection provisioning cannot be advertised as a brain-callable tool', async t => {
  const f = fixture(t); await definition(f);
  const file = path.join(f.dir, 'definition', 'hivemind-bot.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.tools[0].name = 'connect';
  writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => registerBotDefinition(f.hive.home, file), /reserved|Human-only/);
});

for (const file of ['bot-definitions.json', 'project-bots.json']) {
  test(`an unreadable ${file} cannot hide bot identities or block access/credential revocation`, async t => {
    const f = fixture(t); await definition(f);
    const independent = f.hive.bots.createBot(f.human, f.project.id, { name: 'IndependentFeed' });
    f.access({ capabilities: ['publish', 'tools'], definitionId: 'fixture-bot' });
    const route = `/api/ui/projects/${f.project.id}/bots`;
    const location = path.join(f.hive.home, file), saved = readFileSync(location, 'utf8');
    const invalid = '{"privateFixtureSecret":"do-not-reflect",';
    writeFileSync(location, invalid);

    const response = await f.request(route);
    assert.equal(response.status, 200);
    const panel = await response.json() as any;
    assert.match(panel.catalogError, /catalog.*unavailable/i);
    assert.deepEqual(panel.definitions, []);
    assert.deepEqual(panel.bots.map((entry: any) => entry.bot.id).sort(), [f.created.bot.id, independent.bot.id].sort());
    assert.equal(panel.bots.find((entry: any) => entry.bot.id === f.created.bot.id).access.definitionId, 'fixture-bot');
    assert.ok(!JSON.stringify(panel).includes('do-not-reflect'));
    assert.ok(!JSON.stringify(panel).includes(f.dir));

    const reduce = { capabilities: [], receiveChannels: [], definitionId: 'fixture-bot', expectedRevision: 2 };
    assert.equal((await f.request(`${route}/${f.created.bot.id}/access`, reduce, undefined, 'PUT')).status, 200);
    const grant = await f.request(`${route}/${f.created.bot.id}/access`, { ...reduce, capabilities: ['tools'], expectedRevision: 3 }, undefined, 'PUT');
    assert.ok(grant.status >= 400, 'New grants must still fail closed without the catalog');
    assert.equal(f.hive.bots.access(f.created.bot).definitionId, 'fixture-bot');
    assert.deepEqual(f.hive.bots.access(f.created.bot).capabilities, []);
    assert.equal((await f.request(`${route}/${independent.bot.id}/access`, {
      capabilities: [], receiveChannels: [], definitionId: null, expectedRevision: 1,
    }, undefined, 'PUT')).status, 200);
    for (const created of [f.created, independent]) {
      const credentialRoute = `${route}/${created.bot.id}/credential`;
      assert.equal((await f.request(credentialRoute)).status, 200);
      const rotation = await f.request(credentialRoute, { action: 'rotate', expectedRevision: 1 });
      assert.equal(rotation.status, 200);
      const token = (await rotation.json() as any).token;
      assert.equal(f.hive.identity.agentByToken(token).id, created.bot.id);
      assert.equal((await f.request(credentialRoute, { action: 'revoke', expectedRevision: 2 })).status, 200);
      assert.throws(() => f.hive.identity.agentByToken(token), /Invalid token/);
    }
    assert.equal(readFileSync(location, 'utf8'), invalid, 'A degraded read must not repair or overwrite catalog files');
    writeFileSync(location, saved);
    const recovered = await (await f.request(route)).json() as any;
    assert.equal(recovered.catalogError, undefined);
    assert.equal(recovered.definitions[0].id, 'fixture-bot');
    assert.deepEqual(f.hive.bots.access(f.created.bot).capabilities, []);
  });
}

test('stale Human controls and reconnects cannot silently target a newly bound definition', async t => {
  const f = fixture(t); await definition(f);
  const source = path.join(f.dir, 'definition'), target = path.join(f.dir, 'replacement'); mkdirSync(target);
  const manifest = JSON.parse(readFileSync(path.join(source, 'hivemind-bot.json'), 'utf8'));
  manifest.id = 'replacement';
  manifest.tools.push({ name: 'stop', description: 'Stop fixture', effect: 'configure', parameters: { version: 1, fields: [] } });
  writeFileSync(path.join(target, 'hivemind-bot.json'), JSON.stringify(manifest));
  writeFileSync(path.join(target, 'TOOLS.md'), 'Fixture only');
  writeFileSync(path.join(target, 'tool'), readFileSync(path.join(source, 'tool')), { mode: 0o700 });
  registerBotDefinition(f.hive.home, path.join(target, 'hivemind-bot.json'));
  const saved = await saveProjectBotConfiguration(f.hive.home, f.project, 'http://localhost', 'replacement', { enabled: true, values: {}, expectedRevision: 0 });
  const previous = f.access({ capabilities: ['tools'], definitionId: 'fixture-bot' });
  const current = f.access({ capabilities: ['tools'], definitionId: 'replacement' });
  const route = `/api/ui/projects/${f.project.id}/bots/${f.created.bot.id}`;
  // An old page still showing the first service must not execute on the second.
  assert.equal((await f.request(`${route}/control`, { action: 'stop' })).status, 400);
  assert.equal((await f.request(`${route}/control`, { action: 'stop', expectedAccessRevision: previous.revision })).status, 409);
  assert.equal((await f.request(`${route}/connect`, { expectedRevision: 1 })).status, 400);
  assert.equal((await f.request(`${route}/connect`, { expectedRevision: 1, expectedAccessRevision: previous.revision })).status, 409);
  assert.equal(f.hive.bots.botCredential(f.human, f.project.id, f.created.bot.id).credential.revision, 1);
  assert.equal(existsSync(path.join(saved.home, 'connection.json')), false);
  assert.equal((await f.request(`${route}/control`, { action: 'stop', expectedAccessRevision: current.revision })).status, 200);
  assert.equal((await f.request(`${route}/connect`, { expectedRevision: 1, expectedAccessRevision: current.revision })).status, 200);
  assert.equal(f.hive.bots.botCredential(f.human, f.project.id, f.created.bot.id).credential.revision, 2);
});

test('queued bot invocations and connections expire before dispatch rather than execute after the caller timeout', async t => {
  const f = fixture(t), saved = await definition(f);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = saveProjectBotConfiguration(f.hive.home, f.project, 'http://localhost', 'fixture-bot',
    { enabled: true, values: {}, expectedRevision: saved.revision }, async () => { entered(); await gate; });
  await started;
  let authorized = false;
  const invoked = assert.rejects(callProjectBot(f.hive.home, f.project, 'http://localhost', 'fixture-bot', f.created.bot,
    { tool: 'status', arguments: {} }, false, () => { authorized = true; }), /expired before execution/);
  const connected = assert.rejects(connectProjectBot(f.hive.home, f.project, 'http://localhost', 'fixture-bot', f.created.bot,
    f.created.token, () => { authorized = true; }), /expired before execution/);
  const later = Date.now() + 30001;
  t.mock.method(Date, 'now', () => later);
  release(); await holding; await Promise.all([invoked, connected]);
  assert.equal(authorized, false);
  assert.equal(existsSync(path.join(saved.home, 'connection.json')), false);
});

test('a queued tool rechecks the grant after Human revokes it, before starting the executable', async t => {
  const f = fixture(t), saved = await definition(f);
  f.access({ capabilities: ['tools'], definitionId: 'fixture-bot' });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = saveProjectBotConfiguration(f.hive.home, f.project, 'http://localhost', 'fixture-bot',
    { enabled: true, values: {}, expectedRevision: saved.revision }, async () => { entered(); await gate; });
  await started;
  let authorized = false;
  const rejected = assert.rejects(callProjectBot(f.hive.home, f.project, 'http://localhost', 'fixture-bot', f.created.bot,
    { tool: 'status', arguments: {} }, false, () => { authorized = true; f.hive.bots.requireCapability(f.created.bot, 'tools'); }), /disabled: tools/);
  f.access({ capabilities: [], definitionId: 'fixture-bot' });
  release(); await holding; await rejected;
  assert.equal(authorized, true);
});
