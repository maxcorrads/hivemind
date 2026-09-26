import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "../src/server/hive.ts";
import { startServer } from "../src/server/serve.ts";
import { registerBotDefinition, projectBotConfigurations } from "../src/server/bot-definitions.ts";
import { createHumanSession } from "./human-session.ts";
import type { Agent, BotCredentialView, Message } from "../src/shared/types.ts";
import type { ProjectBotConfiguration } from "../src/shared/bot-settings.ts";
import { countRows, listRows } from "../src/server/test-fixtures.ts";

// A real, deliberately installed local executable. Its persistent counter proves
// absence of execution, not just an HTTP status or a mocked configure call.
async function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hive-extensibility-session-"));
  const db = path.join(home, "hive.db"), pkg = path.join(home, "package");
  mkdirSync(pkg);
  const manifest = path.join(pkg, "hivemind-bot.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, kind: 'bot', capabilities: ['publish'], tools: [], id: "session-fixture", name: "Session Fixture",
    command: "tool", instructions: "TOOLS.md", settings: "settings.json" }));
  writeFileSync(path.join(pkg, "TOOLS.md"), "Use {{command}} only for this project.");
  writeFileSync(path.join(pkg, "settings.json"), JSON.stringify({ version: 1,
    fields: [{ key: "host", label: "Host", type: "string", required: true }] }));
  writeFileSync(path.join(pkg, "tool"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] !== 'configure' || process.argv[3] !== '--home') process.exit(3);
const home = process.argv[4]; let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const counter = path.join(home, 'executions');
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(count + 1));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(JSON.parse(input).config));
  console.log(JSON.stringify({ configured: true }));
});
`, { mode: 0o700 });
  registerBotDefinition(home, manifest);
  let hive = new Hive(db), started = startServer({ port: 0, hive, telegram: false });
  t.after(async () => {
    try { await started.shutdown(); } finally { hive.db.close(); rmSync(home, { recursive: true, force: true }); }
  });
  const port = await started.ready, base = `http://127.0.0.1:${port}`;
  const human = hive.identity.getAgent("human"), a = hive.projects.listProjects()[0]!;
  const b = hive.projects.createProject(human, { name: "Other project", slug: "other" });
  const bot = hive.bots.createBot(human, a.id, { name: "SessionFeed" });
  const botB = hive.bots.createBot(human, b.id, { name: "OtherFeed" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid", project: a.slug });
  const channel = hive.channels.createChannel(human, { name: "source", type: "private", project: a.slug });
  const channelB = hive.channels.createChannel(human, { name: "other-source", type: "private", project: b.slug });
  hive.channels.invite(human, channel.id, [bot.bot.name]);
  hive.channels.invite(human, channelB.id, [botB.bot.name]);
  const credentialPath = `/api/ui/projects/${a.id}/bots/${bot.bot.id}/credential`;
  const configurationPath = `/api/ui/projects/${a.slug}/bots/catalog/session-fixture`;
  const profile = (project = a) => projectBotConfigurations(home, project)[0]!;
  const file = (name: string) => existsSync(name) ? readFileSync(name, "utf8") : null;
  const executions = (project = a) => Number(file(path.join(profile(project).home, "executions")) ?? 0);
  // No assertions print real tokens, cookies, or raw database state on success.
  const state = () => JSON.stringify({
    identities: listRows(hive, "agents", { columns: ["id", "name", "token_hash"], orderBy: "id" }),
    credentials: listRows(hive, "bot_credentials", { orderBy: "bot_id" }),
    members: listRows(hive, "channel_members", { orderBy: ["channel_id", "agent_id"] }),
    events: listRows(hive, "bot_events", { orderBy: "message_id" }),
    registry: file(path.join(home, "bot-definitions.json")), bindings: file(path.join(home, "project-bots.json")),
    profiles: [a, b].map(p => ({ config: file(path.join(profile(p).home, "config.json")), calls: executions(p) })),
  });
  const status = () => hive.bots.botCredential(human, a.id, bot.bot.id).credential;
  return { home, base, port, human, a, b, bot, botB, worker, channel, channelB, credentialPath, configurationPath,
    profile, executions, state, status,
    get hive() { return hive; },
    async restart() {
      await started.shutdown(); hive.db.close();
      hive = new Hive(db); started = startServer({ port, hive, telegram: false });
      assert.equal(await started.ready, port);
    },
  };
}

async function bootstrap(base: string) {
  const response = await fetch(`${base}/api/ui/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", connection: "close" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function json<T>(base: string, target: string, init: RequestInit = {}) {
  // Restart tests target an actual pre-handler 401, not an undici pooled-socket
  // close racing the next request. Network ambiguity is tested separately and
  // must never be converted into an automatic mutation retry.
  const headers = new Headers(init.headers); headers.set("connection", "close");
  const response = await fetch(`${base}${target}`, { ...init, headers });
  return { status: response.status, headers: response.headers, data: await response.json() as T };
}

const change = (body: unknown, headers: Record<string, string>, method = "POST"): RequestInit =>
  ({ method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

function client(base: string) {
  let cookie = "", bootstraps = 0, losePath: string | undefined;
  const calls: Array<{ path: string; status: number }> = [];
  const session = createHumanSession(async (target, init) => {
    const headers = new Headers(init?.headers); headers.set("origin", base); headers.set("connection", "close");
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${base}${target}`, { ...init, headers });
    calls.push({ path: target, status: response.status });
    if (target === "/api/ui/session") {
      bootstraps++;
      const next = response.headers.get("set-cookie")?.split(";")[0];
      if (next) cookie = next;
    } else if (response.ok && target === losePath) {
      losePath = undefined;
      await response.body?.cancel();
      throw new TypeError("Fixture response lost after committed operation");
    }
    return response;
  });
  return { session, calls, bootstraps: () => bootstraps, cookie: () => cookie,
    loseNextResponse: (target: string) => { losePath = target; } };
}

for (const restart of [false, true]) {
  test(`real Human bot/bot routes reject ${restart ? "stale after restart" : "missing and forged"} sessions without state changes`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const oldCookie = await bootstrap(f.base);
    if (restart) await f.restart();
    const liveCookie = restart ? await bootstrap(f.base) : oldCookie;
    const contexts = [
      { label: "absent", headers: { origin: f.base }, status: 401 },
      { label: "forged", headers: { origin: f.base, cookie: `hivemind_human_${f.port}=${"a".repeat(43)}` }, status: 401 },
      ...(restart ? [{ label: "stale", headers: { origin: f.base, cookie: oldCookie }, status: 401 }] : []),
      { label: "foreign", headers: { origin: "http://hostile.invalid", cookie: liveCookie }, status: 403 },
      { label: "other port", headers: { origin: "http://127.0.0.1:1", cookie: liveCookie }, status: 403 },
      { label: "opaque", headers: { origin: "null", cookie: liveCookie }, status: 403 },
      { label: "bot bearer alone", headers: { origin: f.base, authorization: `Bearer ${f.bot.token}` }, status: 401 },
      { label: "bot bearer and cookie", headers: { origin: f.base, cookie: liveCookie, authorization: `Bearer ${f.bot.token}` }, status: 403 },
      { label: "worker bearer and cookie", headers: { origin: f.base, cookie: liveCookie, authorization: `Bearer ${f.worker.token}` }, status: 403 },
    ];
    const routes: Array<{ path: string; method: string; body?: unknown }> = [
      { path: `/api/ui/projects/${f.a.id}/bots`, method: "POST", body: { name: "DoNotCreate" } },
      { path: f.credentialPath, method: "GET" },
      { path: f.credentialPath, method: "POST", body: { action: "rotate", expectedRevision: 1 } },
      { path: f.credentialPath, method: "POST", body: { action: "revoke", expectedRevision: 1 } },
      { path: f.configurationPath, method: "PUT", body: { enabled: true, values: { host: "do-not-save" }, expectedRevision: 0 } },
      { path: f.configurationPath, method: "PATCH", body: { enabled: true, expectedRevision: 0 } },
      { path: `/api/ui/projects/${f.a.slug}/bots/catalog`, method: "GET" },
      { path: `/api/ui/launch-context?project=${f.a.slug}`, method: "GET" },
      { path: "/api/ui/projects/missing/bots", method: "POST", body: { name: "DoNotCreate" } },
      { path: `/api/ui/projects/${f.b.id}/bots/${f.bot.bot.id}/credential`, method: "GET" },
    ];
    const before = f.state();
    for (const context of contexts) for (const route of routes) {
      const headers = Object.fromEntries(Object.entries(context.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const result = await json<{ error: string }>(f.base, route.path,
        route.body === undefined ? { headers, method: route.method } : change(route.body, headers, route.method));
      assert.equal(result.status, context.status, `${context.label}: ${route.method} ${route.path}`);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.equal(result.headers.get("x-hivemind-session-required"), context.status === 401 ? "1" : null);
      assert.equal(f.state() === before, true, "rejection must not execute/configure/mutate credentials or membership");
      assert.equal(f.executions(), 0);
    }
    const wrongType = await json(f.base, f.credentialPath, change({ action: "rotate", expectedRevision: 1 },
      { cookie: liveCookie, origin: f.base, "content-type": "text/plain" }));
    assert.equal(wrongType.status, 415);
    assert.equal(f.state() === before, true);
  });
}

test("authorized HTTP retains bot scope, durable retries and credential history across restart", async t => {
  const f = await fixture(t), cookie = await bootstrap(f.base), headers = { cookie, origin: f.base };
  const publish = (token: string, channel = f.channel.id, body = "fixture observation") => json<{ message: Message; duplicate: boolean }>(
    f.base, `/api/bot/channels/${channel}/messages`, change({ eventId: "stable-event", body }, { authorization: `Bearer ${token}` }));
  const first = await publish(f.bot.token);
  assert.equal(first.status, 201);
  assert.equal((await publish(f.bot.token)).data.message.id, first.data.message.id);
  assert.equal((await publish(f.bot.token, f.channelB.id)).status, 404);
  assert.equal((await publish(f.botB.token)).status, 404);
  const before = f.state();
  const denied = await json(f.base, `/api/ui/projects/${f.b.id}/bots/${f.bot.bot.id}/credential`,
    change({ action: "rotate", expectedRevision: 1 }, headers));
  assert.equal(denied.status, 404);
  assert.equal(f.state() === before, true);
  const rotated = await json<BotCredentialView & { token: string }>(f.base, f.credentialPath,
    change({ action: "rotate", expectedRevision: 1 }, headers));
  assert.equal(rotated.status, 200);
  assert.equal(rotated.data.credential.revision, 2);
  assert.equal((await publish(f.bot.token)).status, 401);
  assert.equal((await publish(rotated.data.token)).data.message.id, first.data.message.id);
  assert.equal((await publish(rotated.data.token, f.channel.id, "changed replay")).status, 409);
  const stored = await json<BotCredentialView>(f.base, f.credentialPath, { headers });
  assert.equal("token" in stored.data, false);
  assert.equal(JSON.stringify(stored.data).includes(rotated.data.token), false);
  await f.restart();
  const replay = await publish(rotated.data.token);
  assert.equal(replay.status, 200); assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.message.id, first.data.message.id);
  const freshHeaders = { origin: f.base, cookie: await bootstrap(f.base) };
  assert.equal((await json(f.base, f.credentialPath, change({ action: "revoke", expectedRevision: 1 }, freshHeaders))).status, 409);
  const revoked = await json<BotCredentialView>(f.base, f.credentialPath, change({ action: "revoke", expectedRevision: 2 }, freshHeaders));
  assert.equal(revoked.status, 200); assert.equal(revoked.data.credential.revoked, true);
  assert.equal((await publish(rotated.data.token)).status, 401);
  assert.equal(countRows(f.hive, "bot_events"), 1);
});

test("real session recovery replays rejected rotation and configure exactly once, preserving the other project", async t => {
  const f = await fixture(t), c = client(f.base);
  const get = await c.session.request(f.credentialPath); assert.equal(get.status, 200); await get.body?.cancel();
  assert.equal(c.bootstraps(), 1);
  const otherBefore = JSON.stringify(f.profile(f.b));
  await f.restart();
  const [rotation, configure] = await Promise.all([
    c.session.request(f.credentialPath, change({ action: "rotate", expectedRevision: 1 }, {})),
    c.session.request(f.configurationPath, change({ enabled: true, values: { host: "accepted" }, expectedRevision: 0 }, {}, "PUT")),
  ]);
  assert.equal(rotation.status, 200); await rotation.body?.cancel();
  assert.equal(configure.status, 200); await configure.body?.cancel();
  assert.equal(f.status().revision, 2); assert.equal(f.executions(), 1);
  assert.equal(f.profile().revision, 1); assert.equal(f.profile().values.host, "accepted");
  assert.equal(JSON.stringify(f.profile(f.b)), otherBefore); assert.equal(f.executions(f.b), 0);
  assert.equal(c.bootstraps(), 2, "one shared refresh for concurrent stale requests");
  assert.equal(c.calls.filter(call => call.path === f.credentialPath && call.status === 401).length, 1);
  assert.equal(c.calls.filter(call => call.path === f.configurationPath && call.status === 401).length, 1);
  const unavailable = await c.session.request(f.configurationPath, change({ enabled: false, expectedRevision: 1 }, {}, "PATCH"));
  assert.equal(unavailable.status, 200); await unavailable.body?.cancel();
  assert.equal(f.executions(), 1, "availability never starts Configure");
  assert.equal(f.profile().enabled, false);
});

test("network loss after real creation/rotation/configure never causes automatic mutation replay", async t => {
  const f = await fixture(t), c = client(f.base);
  const creationPath = `/api/ui/projects/${f.a.id}/bots`;
  c.loseNextResponse(creationPath);
  await assert.rejects(c.session.request(creationPath, change({ name: "LostCreation" }, {})), /response lost/);
  assert.equal(f.hive.identity.listAgents(f.human).filter(agent => agent.name === "LostCreation").length, 1);
  c.loseNextResponse(f.credentialPath);
  await assert.rejects(c.session.request(f.credentialPath, change({ action: "rotate", expectedRevision: 1 }, {})), /response lost/);
  assert.equal(f.status().revision, 2);
  c.loseNextResponse(f.configurationPath);
  await assert.rejects(c.session.request(f.configurationPath, change({ enabled: true, values: { host: "lost" }, expectedRevision: 0 }, {}, "PUT")), /response lost/);
  assert.equal(f.executions(), 1); assert.equal(f.profile().revision, 1);
  for (const target of [creationPath, f.credentialPath, f.configurationPath]) {
    assert.equal(c.calls.filter(call => call.path === target).length, 1);
  }
  assert.equal(c.bootstraps(), 1);
  const reload = await c.session.request(f.credentialPath);
  assert.equal((await reload.json() as BotCredentialView).credential.revision, 2);
  const explicit = await c.session.request(f.credentialPath, change({ action: "rotate", expectedRevision: 2 }, {}));
  assert.equal(explicit.status, 200); await explicit.body?.cancel();
  assert.equal(f.status().revision, 3);
});

test("authorized bot configuration rejects unknown projects/bots and stale revisions before execution", async t => {
  const f = await fixture(t), headers = { cookie: await bootstrap(f.base), origin: f.base };
  const before = f.state();
  for (const target of [`/api/ui/projects/missing/bots/catalog/session-fixture`, `/api/ui/projects/${f.a.slug}/bots/catalog/unknown`]) {
    const result = await json(f.base, target, change({ enabled: true, values: { host: "rejected" }, expectedRevision: 0 }, headers, "PUT"));
    assert.ok(result.status === 400 || result.status === 404);
    assert.equal(f.state() === before, true); assert.equal(f.executions(), 0);
  }
  const saved = await json<{ configuration: ProjectBotConfiguration }>(f.base, f.configurationPath,
    change({ enabled: true, values: { host: "project-a" }, expectedRevision: 0 }, headers, "PUT"));
  assert.equal(saved.status, 200); assert.equal(saved.data.configuration.revision, 1);
  const good = f.state();
  const stale = await json(f.base, f.configurationPath, change({ enabled: true, values: { host: "stale" }, expectedRevision: 0 }, headers, "PUT"));
  assert.equal(stale.status, 400); assert.equal(f.state() === good, true); assert.equal(f.executions(), 1);
  assert.equal(f.executions(f.b), 0);
  const created = await json<{ bot: Agent; token: string }>(f.base, `/api/ui/projects/${f.a.id}/bots`, change({ name: "ValidCreation" }, headers));
  assert.equal(created.status, 201); assert.equal(created.data.bot.projectId, f.a.id);
  assert.equal(created.headers.get("cache-control"), "no-store");
});
