import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import type { WaitResult } from "../shared/types.ts";
import { childEnv } from "../test-support/child-process.ts";
import { captureSession } from '../client/capture-session.ts';

test("real concurrent/repeated MCP joins reuse the active identity without exposing its token or resetting delivery", { timeout: 20_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-join-session-"));
  const hive = new Hive(path.join(dir, "hive.db")), service = startServer({ hive, port: 0, telegram: false });
  const client = new Client({ name: "join-fixture", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", path.join(root,"node_modules/tsx/dist/loader.mjs"), path.join(root,"src/cli.ts"), "mcp"], cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir,"identity"), HIVEMIND_URL: `http://127.0.0.1:${await service.ready}`, HIVEMIND_TOKEN: "" }), stderr: "pipe" });
  t.after(async () => { await client.close(); await transport.close(); await service.shutdown(); hive.db.close(); rmSync(dir,{ recursive:true,force:true }); });
  await client.connect(transport);
  const call = async <T>(name: string, args: Record<string,unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError,true,JSON.stringify(result));
    const text = (result.content as Array<{type:string;text:string}>)[0]!.text;
    assert.doesNotMatch(text, /hm_[a-f0-9]{48}/, "model result leaked a token");
    return JSON.parse(text) as T;
  };
  const prior = hive.identity.listAgents().length;
  const unbound = await client.callTool({ name: 'join', arguments: { role: 'brain', requireLaunchTracking: true } });
  assert.equal(unbound.isError, true);
  assert.match(JSON.stringify(unbound.content), /did not receive this launch binding/);
  assert.match(JSON.stringify(unbound.content), /mcp-config --cursor/);
  assert.equal(hive.identity.listAgents().length, prior, 'a missing launch binding must not allocate an employee');
  const [a,b] = await Promise.all([call<{ name:string;created:boolean }>("join",{ role:"brain" }), call<{ name:string;created:boolean }>("join",{ role:"brain" })]);
  assert.equal(a.name,b.name); assert.equal([a,b].filter(x=>x.created).length,1);
  assert.equal(hive.identity.listAgents().filter(a=>a.role==="brain").length,1);
  const agent = hive.identity.getAgentByName(a.name)!, human = hive.identity.getAgent("human");
  const dm = hive.channels.openDm(human,agent.name); hive.messages.postMessage(human,{channel:dm.id,body:"do not reset this delivery session"});
  const mail = await call<WaitResult>("wait"); const session = hive.inbox.currentSession(agent.id);
  await call("join",{role:"brain",resume:agent.name});
  assert.equal(hive.inbox.currentSession(agent.id),session);
  await call("ack_delivery",{deliveryId:mail.delivery!.id});
  const renamed = hive.identity.editIdentity(human, agent.id,
    { expectedRevision: agent.identityRevision!, name: 'RenamedBrain' });
  const resumed = await call<{ name: string; created: boolean }>("join", { role: "brain", resume: renamed.name });
  assert.equal(resumed.name, renamed.name, "the running MCP process accepts Human's current name");
  assert.equal(resumed.created, false);
  assert.equal(hive.inbox.currentSession(agent.id), session);
  const me = await call<{ you: { name: string } }>("whoami");
  assert.equal(me.you.name, renamed.name);
  const oldAlias = await call<{ name: string }>("join", { role: "brain", resume: agent.name });
  assert.equal(oldAlias.name, renamed.name, "an authenticated former name remains tied to this identity");
  const wrongName = await client.callTool({ name: "join", arguments: { role: "brain", resume: "Human" } });
  assert.equal(wrongName.isError, true, "a renamed process cannot switch identities");
  const bad = await client.callTool({name:"join",arguments:{role:"worker",seniority:"mid"}});
  assert.equal(bad.isError,true); assert.equal(hive.identity.listAgents().filter(a=>a.role!=="human").length,1);
});

test("an MCP client launched in a Hivemind tmux session reports it on join; the server keeps it as a label", { timeout: 20_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-join-terminal-"));
  const hive = new Hive(path.join(dir, "hive.db")), service = startServer({ hive, port: 0, telegram: false });
  const client = new Client({ name: "join-terminal-fixture", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", path.join(root,"node_modules/tsx/dist/loader.mjs"), path.join(root,"src/cli.ts"), "mcp"], cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir,"identity"), HIVEMIND_URL: `http://127.0.0.1:${await service.ready}`, HIVEMIND_TOKEN: "",
      HIVEMIND_TMUX_SESSION: "hm-acme-new-1" }), stderr: "pipe" });
  t.after(async () => { await client.close(); await transport.close(); await service.shutdown(); hive.db.close(); rmSync(dir,{ recursive:true,force:true }); });
  await client.connect(transport);
  const nativeSession = { software: "codex", sessionId: "019b2800-1234-7000-8000-000000000001", model: "test-model", effort: "high" };
  const result = await client.callTool({ name: "join", arguments: { role: "worker", seniority: "mid", nativeSession } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const { name } = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as { name: string };
  assert.equal(hive.identity.getAgentByName(name)!.terminalSession, "hm-acme-new-1");
  assert.deepEqual(hive.identity.nativeSession(hive.identity.getAgentByName(name)!.id), nativeSession);
  const repeated = await client.callTool({ name: "join", arguments: { role: "worker", seniority: "mid" } });
  assert.notEqual(repeated.isError, true, JSON.stringify(repeated));
  assert.deepEqual(hive.identity.nativeSession(hive.identity.getAgentByName(name)!.id), nativeSession,
    "an idempotent join without metadata preserves the current native conversation");
});

for (const software of ['codex', 'claude', 'cursor'] as const)
  test(`real MCP join and process reconnect preserve the tracked launch and unacknowledged mail (${software})`, { timeout: 20_000 }, async t => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-auto-session-'));
    const hive = new Hive(path.join(dir, 'hive.db')), service = startServer({ hive, port: 0, telegram: false });
    const project = hive.projects.listProjects()[0]!, url = `http://127.0.0.1:${await service.ready}`;
    const settings = { software, model: 'fixture', effort: 'high', extraFlags: '', environment: {},
      workspacePath: dir, cdWorktree: true, passProject: true, adoptUntrusted: true,
      role: 'brain' as const, seniority: null, focus: 'coord' };
    const launch = hive.launchSessions.prepare(project.id, settings, null);
    const clients: Client[] = [], transports: StdioClientTransport[] = [];
    const connect = async (omitBinding = false) => {
      const client = new Client({ name: 'tracked-fixture', version: '0' });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'src/cli.ts'), 'mcp',
          ...(software === 'cursor' || omitBinding ? [] : ['--launch-ticket', launch.ticket])], cwd: dir,
        env: childEnv({ PATH: process.env.PATH ?? '', HIVEMIND_HOME: path.join(dir, 'client'), HIVEMIND_URL: url,
          HIVEMIND_TOKEN: '', ...(software === 'cursor' && !omitBinding ? { HIVEMIND_LAUNCH_TICKET: launch.ticket } : {}) }), stderr: 'pipe' });
      clients.push(client); transports.push(transport);
      await client.connect(transport);
      return client;
    };
    t.after(async () => { for (const client of clients) await client.close();
      for (const transport of transports) await transport.close();
      await service.shutdown(); hive.db.close();
      rmSync(dir, { recursive: true, force: true }); });
    const id = launch.sessionId ?? '019b2800-1234-7000-8000-000000000001';
    if (software !== 'claude') {
      async function* input() { yield software === 'codex'
        ? JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: id }) : id; }
      await captureSession(['--url', url, '--ticket', launch.ticket, ...(software === 'codex' ? ['--hook'] : [])], input());
    }
    const client = await connect();
    const result = await client.callTool({ name: 'join', arguments: { role: 'brain', project: project.slug, requireLaunchTracking: true } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(!text.includes(launch.ticket), 'private launch capability never reaches model output');
    const agent = hive.identity.getAgentByName(JSON.parse(text).name)!;
    assert.deepEqual(hive.launchSessions.saved(agent.id), { settings, sessionId: id, captured: true });
    assert.equal(hive.identity.nativeSession(agent.id)!.sessionId, id);
    const dm = hive.channels.openDm(hive.identity.getAgent('human'), agent.name);
    hive.messages.postMessage(hive.identity.getAgent('human'), { channel: dm.id, body: 'Keep this pending across reconnect' });
    const offered = await client.callTool({ name: 'wait', arguments: {} });
    assert.notEqual(offered.isError, true);
    const mail = JSON.parse((offered.content as Array<{ text: string }>)[0]!.text) as WaitResult;
    assert.ok(mail.delivery);
    assert.ok(mail.mail?.length);
    const fingerprint = hive.identity.sessionFingerprint(agent.id);
    const unbound = await connect(true);
    const denied = await unbound.callTool({ name: 'join', arguments: { role: 'brain', project: project.slug,
      resume: agent.name, requireLaunchTracking: true } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /did not receive this launch binding/);
    assert.equal(hive.identity.sessionFingerprint(agent.id), fingerprint, 'a failed setup cannot supersede the employee');
    assert.deepEqual(hive.launchSessions.saved(agent.id), { settings, sessionId: id, captured: true }, 'the prior saved launch is preserved');
    await unbound.close();
    await client.close();
    const restarted = await connect();
    const rejoined = await restarted.callTool({ name: 'join', arguments: { role: 'brain', project: project.slug, resume: agent.name } });
    assert.notEqual(rejoined.isError, true, JSON.stringify(rejoined));
    const rejoinedText = (rejoined.content as Array<{ text: string }>)[0]!.text;
    assert.equal(JSON.parse(rejoinedText).name, agent.name);
    assert.doesNotMatch(rejoinedText, /hm_[a-f0-9]{48}|hml_[a-f0-9]{64}/);
    assert.notEqual(hive.identity.sessionFingerprint(agent.id), fingerprint);
    assert.deepEqual(hive.launchSessions.saved(agent.id), { settings, sessionId: id, captured: true });
    const redelivered = await restarted.callTool({ name: 'wait', arguments: {} });
    assert.notEqual(redelivered.isError, true);
    const nextMail = JSON.parse((redelivered.content as Array<{ text: string }>)[0]!.text) as WaitResult;
    assert.ok(nextMail.mail?.length);
    assert.deepEqual(nextMail.mail.map(m => m.messageId), mail.mail.map(m => m.messageId));
    const acknowledged = await restarted.callTool({ name: 'ack_delivery', arguments: { deliveryId: nextMail.delivery!.id } });
    assert.notEqual(acknowledged.isError, true);
  });
