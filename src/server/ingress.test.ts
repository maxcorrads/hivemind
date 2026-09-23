import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "./hive.ts";
import { countRows } from "./test-fixtures.ts";
import { createApp } from "./app.ts";
import { BotIngressBudget, readLimitedJson, assertLocalHumanRequest, BOT_JSON_BYTES } from "./ingress.ts";
import { HiveError } from "../shared/types.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-ingress-"));
  const dbPath = path.join(dir, "hive.db");
  let hive = new Hive(dbPath);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const a = hive.projects.listProjects()[0]!;
  const b = hive.projects.createProject(human, { slug: "other", name: "Other" });
  const channelA = hive.channels.createChannel(human, { project: a.slug, name: "scope-a", type: "private" });
  const channelB = hive.channels.createChannel(human, { project: b.slug, name: "scope-b", type: "private" });
  const botA = hive.bots.createBot(human, a.id, { name: "SourceA" });
  const botB = hive.bots.createBot(human, b.id, { name: "SourceB" });
  hive.channels.invite(human, channelA.id, [botA.bot.name]);
  hive.channels.invite(human, channelB.id, [botB.bot.name]);
  return { get hive() { return hive; }, human, a, b, channelA, channelB, botA, botB, dbPath,
    restart() { hive.db.close(); hive = new Hive(dbPath); },
  };
}
function jsonRequest(url: string, body: unknown, token?: string) {
  return new Request(url, { method: "POST", headers: {
    "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
}
function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/api/bot/channels/target/messages", {
    method: "POST", body, headers, signal, duplex: "half",
  } as RequestInit & { duplex: string });
}
const status = (expected: number) => (error: unknown) => error instanceof HiveError && error.status === expected;

test("JSON ingress bounds real bytes with missing/false lengths and cancels the producer", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "-1" }, { "content-length": "99999" }] as Array<Record<string, string>>) {
    let cancelled = false;
    const request = streamed(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('"' + "€".repeat(20))); },
      cancel() { cancelled = true; },
    }), headers);
    await assert.rejects(readLimitedJson(request, 30), status(headers["content-length"] === "-1" ? 400 : 413));
    assert.equal(cancelled, true);
    assert.equal(request.body!.locked, false);
  }
});

test("JSON ingress validates split UTF-8, rejects malformed/empty input without echoing it", async () => {
  const encoded = new TextEncoder().encode('{"value":"€"}');
  const request = streamed(new ReadableStream<Uint8Array>({ start(c) {
    for (const byte of encoded) c.enqueue(Uint8Array.of(byte));
    c.close();
  } }));
  assert.deepEqual(await readLimitedJson(request, encoded.length), { value: "€" });
  for (const body of ["", '{"private":"fixture-secret",', Uint8Array.of(0xff)]) {
    const bad = new Request("http://localhost", { method: "POST", body });
    await assert.rejects(readLimitedJson(bad, 100), (error: unknown) => {
      assert.ok(error instanceof HiveError);
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
  await assert.rejects(readLimitedJson(new Request("http://localhost"), 100), status(400));
});

test("JSON deadline and abort release the reader without waiting for cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = 0;
  const request = streamed(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } }));
  const outcome = assert.rejects(readLimitedJson(request, 100, 20), status(408));
  t.mock.timers.tick(20);
  await outcome;
  assert.equal(cancelled, 1);
  assert.equal(request.body!.locked, false);
  for (const beforeRead of [true, false]) {
    const abort = new AbortController();
    const req = streamed(new ReadableStream(), {}, abort.signal);
    if (beforeRead) abort.abort();
    const result = assert.rejects(readLimitedJson(req, 100), status(400));
    if (!beforeRead) abort.abort();
    await result;
    assert.equal(req.body!.locked, false);
  }
});

test("bot budgets bound bursts, concurrent work and cardinality without timers or clock resets", () => {
  let clock = 0;
  const budget = new BotIngressBudget(() => clock);
  for (let n = 0; n < 60; n++) {
    const release = budget.acquire("a"); assert.ok(release); release(); release();
  }
  assert.equal(budget.acquire("a"), undefined);
  clock = -100;
  assert.equal(budget.acquire("a"), undefined);
  clock = 100;
  budget.acquire("a")!();
  const other = budget.acquire("b"); assert.ok(other); other();
  const held = Array.from({ length: 4 }, () => budget.acquire("b")!);
  assert.equal(budget.acquire("b"), undefined);
  held.forEach(release => release());
  const all = Array.from({ length: 32 }, (_, n) => budget.acquire(`active-${n}`)!);
  assert.ok(all.every(Boolean));
  assert.equal(budget.acquire("overflow"), undefined);
  all.forEach(release => release());
  const bounded = new BotIngressBudget(() => clock);
  for (let n = 0; n < 1024; n++) bounded.acquire(String(n))!();
  assert.equal(bounded.acquire("new"), undefined);
  clock += 6000;
  bounded.acquire("new")!();
});

test("local Human boundary rejects bot credentials, foreign browsers and rebinding hosts", () => {
  for (const [url, headers] of [
    ["http://localhost", { authorization: "Bearer fixture" }],
    ["http://evil.invalid", {}],
    ["http://localhost", { host: "evil.invalid" }],
    ["http://localhost", { origin: "null" }],
    ["http://localhost", { origin: "https://evil.invalid" }],
    ["http://localhost", { origin: "http://localhost:1111" }],
    ["http://localhost", { "sec-fetch-site": "cross-site" }],
  ] as Array<[string, Record<string, string>]>) {
    assert.throws(() => assertLocalHumanRequest(new Request(url, { headers })), status(403));
  }
  assertLocalHumanRequest(new Request("http://localhost"));
  assertLocalHumanRequest(new Request("http://localhost:7421", { headers: { origin: "http://localhost:7421" } }));
  assertLocalHumanRequest(new Request("http://127.0.0.1:7421", { headers: { origin: "http://127.0.0.1:7420" } }));
});

test("HTTP rejects malformed/oversized ingress, unknown fields and credential URLs before publishing", async t => {
  const f = fixture(t), app = createApp(f.hive);
  const url = `http://localhost/api/bot/channels/${f.channelA.id}/messages`;
  const before = countRows(f.hive, "messages");
  for (const body of ["{", JSON.stringify({ eventId: "too-large", body: "x".repeat(BOT_JSON_BYTES) }),
    JSON.stringify({ eventId: "wrong-plugin", body: "test", pluginId: "unknown" }),
    JSON.stringify({ eventId: "wrong-type", body: "test", type: "execute" })]) {
    const response = await app.request(url, { method: "POST", body, headers: { authorization: `Bearer ${f.botA.token}` } });
    assert.ok([400, 413].includes(response.status));
    assert.doesNotMatch(await response.text(), new RegExp(f.botA.token));
  }
  const unauthenticated = await app.request(url + `?token=${f.botA.token}`, { method: "POST", body: "{" });
  assert.equal(unauthenticated.status, 401);
  assert.doesNotMatch(await unauthenticated.text(), new RegExp(f.botA.token));
  const body = { eventId: "ok", body: "observation" };
  assert.equal((await app.request(jsonRequest(url, body, f.botA.token))).status, 201);
  assert.equal((await app.request(jsonRequest(url, body, f.botA.token))).status, 200);
  assert.equal(countRows(f.hive, "messages"), before + 1);
});

test("a credential revoked while JSON is streaming cannot commit an observation", async t => {
  const f = fixture(t), app = createApp(f.hive);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let began!: () => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { began(); } }, { highWaterMark: 0 });
  const request = new Request(`http://localhost/api/bot/channels/${f.channelA.id}/messages`, {
    method: "POST", headers: { authorization: `Bearer ${f.botA.token}` }, body: stream, duplex: "half",
  } as RequestInit & { duplex: string });
  const result = app.request(request);
  await reading;
  f.hive.bots.changeBotCredential(f.human, f.a.id, f.botA.bot.id, { action: "revoke", expectedRevision: 1 });
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ eventId: "in-flight", body: "denied" })));
  controller.close();
  assert.equal((await result).status, 401);
  assert.equal(countRows(f.hive, "bot_events"), 0);
});

test("parallel retries publish one event, retry conflicts do not poison the next transaction on Node 22.13", async t => {
  const f = fixture(t), app = createApp(f.hive);
  // Node 24 exposes a non-configurable native property. Intercept through a
  // separate facade so the same compatibility fault is exercised on every Node.
  const originalHive = f.hive, database = originalHive.db;
  Object.defineProperty(originalHive, "db", { value: new Proxy({}, {
    get(_target, key) {
      if (key === "isTransaction") throw new Error("Do not depend on a newer SQLite API");
      const value: unknown = Reflect.get(database, key, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) });
  t.after(() => { Object.defineProperty(originalHive, "db", { value: database }); });
  assert.throws(() => originalHive.db.isTransaction, /Do not depend on a newer SQLite API/);
  const url = `http://localhost/api/bot/channels/${f.channelA.id}/messages`;
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.request(jsonRequest(url, { eventId: "same", body: "same" }, f.botA.token))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 200, 201]);
  assert.equal((await app.request(jsonRequest(url, { eventId: "same", body: "different" }, f.botA.token))).status, 409);
  assert.equal((await app.request(jsonRequest(url, { eventId: "next", body: "ok" }, f.botA.token))).status, 201);
  assert.throws(() => f.hive.bots.changeBotCredential(f.human, f.a.id, f.botA.bot.id, { action: "revoke", expectedRevision: 99 }), status(409));
  const rotated = f.hive.bots.changeBotCredential(f.human, f.a.id, f.botA.bot.id, { action: "rotate", expectedRevision: 1 });
  assert.equal(f.hive.identity.agentByToken(rotated.token!).id, f.botA.bot.id);
  f.restart();
  assert.equal((await createApp(f.hive).request(jsonRequest(url, { eventId: "same", body: "same" }, rotated.token))).status, 200);
  assert.throws(() => f.hive.identity.agentByToken(f.botA.token), status(401));
});

test("bot HTTP credentials cannot enumerate another project, use Human/plugin settings, or cross-route events", async t => {
  const f = fixture(t), app = createApp(f.hive);
  for (const route of ["/api/ui/snapshot", "/api/ui/launch-context?project=other", `/api/ui/projects/${f.b.slug}/plugins`,
    `/api/ui/projects/${f.b.id}/bots/${f.botB.bot.id}/credential`, "/api/agent/agents", "/api/agent/search?q=private"]) {
    const response = await app.request(route, { headers: { authorization: `Bearer ${f.botA.token}` } });
    assert.equal(response.status, 403, route);
    assert.doesNotMatch(await response.text(), new RegExp(f.botB.bot.id + "|" + f.botB.token));
  }
  const cross = `http://localhost/api/bot/channels/${f.channelB.id}/messages`;
  assert.equal((await app.request(jsonRequest(cross, { eventId: "foreign", body: "denied" }, f.botA.token))).status, 404);
  assert.equal(countRows(f.hive, "bot_events"), 0);
});

test("bot burst refusals carry retry guidance and another bot keeps its own budget", async t => {
  t.mock.method(performance, "now", () => 0);
  const f = fixture(t), app = createApp(f.hive);
  const url = `http://localhost/api/bot/channels/${f.channelA.id}/messages`;
  for (let n = 0; n < 80; n++) {
    const response = await app.request(jsonRequest(url, { eventId: "burst", body: "one" }, f.botA.token));
    if (response.status === 429) {
      assert.equal(response.headers.get("retry-after"), "1");
      const own = `http://localhost/api/bot/channels/${f.channelB.id}/messages`;
      assert.equal((await app.request(jsonRequest(own, { eventId: "burst", body: "two" }, f.botB.token))).status, 201);
      return;
    }
    assert.ok([200, 201].includes(response.status));
  }
  assert.fail("A synchronous burst must hit admission control");
});

test("credentials remain hashes across restart; HTTP and internal error diagnostics do not leak tokens", async t => {
  const f = fixture(t), app = createApp(f.hive);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(f.hive.bots, "postBotMessage", () => { throw new Error(`provider error ${f.botA.token}`); });
  const url = `http://localhost/api/bot/channels/${f.channelA.id}/messages`;
  const result = await app.request(jsonRequest(url, { eventId: "no-log", body: "safe" }, f.botA.token));
  assert.equal(result.status, 500);
  assert.equal(await result.text(), '{"error":"Internal server error"}');
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(f.botA.token));
  f.hive.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // schema-level assertion: flush WAL to inspect the file
  assert.equal(readFileSync(f.dbPath).includes(Buffer.from(f.botA.token)), false);
  assert.ok(statSync(f.dbPath).size > 0);
  assert.equal(statSync(f.dbPath).mode & 0o777, 0o600);
  f.restart();
  assert.equal(f.hive.identity.agentByToken(f.botA.token).id, f.botA.bot.id);
});
