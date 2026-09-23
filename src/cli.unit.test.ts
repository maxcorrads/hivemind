import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test, type TestContext } from "node:test";
import { arg, argRest, isCliEntrypoint, mcpLauncher, runCli } from "./cli.ts";
import { BODY_MAX } from "./shared/types.ts";

// Every command runs in-process against a mocked fetch; HIVEMIND_HOME is a
// throwaway directory so send journals and gc never touch a real hive.
const home = mkdtempSync(path.join(os.tmpdir(), "hivemind-cli-"));
const saved = { home: process.env.HIVEMIND_HOME, url: process.env.HIVEMIND_URL, token: process.env.HIVEMIND_TOKEN };
process.env.HIVEMIND_HOME = home;
process.env.HIVEMIND_URL = "http://127.0.0.1:7999";
after(() => {
  for (const [key, value] of [["HIVEMIND_HOME", saved.home], ["HIVEMIND_URL", saved.url], ["HIVEMIND_TOKEN", saved.token]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.HIVEMIND_TOKEN = "env-token";
});

type Call = { method: string; path: string; body: unknown; auth: string | null };
type Reply = unknown | Response | ((call: Call) => unknown | Response);

/** Mocks fetch (answering calls in order, the last reply repeating) and captures console output. */
function harness(t: TestContext, ...replies: Reply[]) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? undefined;
    const call = { method: init?.method ?? "GET", path: url.pathname + url.search, body, auth: headers.get("authorization") };
    calls.push(call);
    let reply: unknown = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    if (typeof reply === "function") reply = (reply as (call: Call) => unknown)(call);
    return reply instanceof Response ? reply : Response.json(reply);
  });
  t.mock.method(console, "log", (...args: unknown[]) => { out.push(args.join(" ")); });
  t.mock.method(console, "error", (...args: unknown[]) => { err.push(args.join(" ")); });
  return { calls, out, err };
}

test("arg and argRest read flag values", () => {
  assert.equal(arg(["--a", "1"], "--a"), "1");
  assert.equal(arg(["--a"], "--a"), undefined);
  assert.equal(arg([], "--a"), undefined);
  assert.equal(argRest(["--body", "hello", "big", "world", "--to", "X"], "--body"), "hello big world");
  assert.equal(argRest(["--body", "--to", "X"], "--body"), undefined);
  assert.equal(argRest(["send"], "--body"), undefined);
});

test("isCliEntrypoint only matches this module as the process entry", () => {
  const self = fileURLToPath(new URL("./cli.ts", import.meta.url));
  assert.equal(isCliEntrypoint(self, self), true);
  assert.equal(isCliEntrypoint(undefined, self), false);
  assert.equal(isCliEntrypoint(path.join(home, "missing.ts"), self), false);
  assert.equal(isCliEntrypoint(fileURLToPath(import.meta.url), self), false);
  assert.equal(isCliEntrypoint(), false);
});

test("help and its aliases print usage without contacting the hive", async (t) => {
  const { calls, out } = harness(t);
  for (const argv of [[], ["help"], ["-h"], ["--help"]]) await runCli(argv);
  assert.equal(out.length, 4);
  assert.ok(out.every(text => text.includes("hivemind send --to NAME") && text.includes("--execution-id ID")));
  assert.equal(calls.length, 0);
});

test("unknown commands print usage and fail", async (t) => {
  const { out } = harness(t);
  await assert.rejects(runCli(["bogus"]), /unknown command bogus/);
  assert.match(out[0]!, /local hive for Human/);
});

test("mcp-config prints a tsx launcher for this checkout", async (t) => {
  const { out, err } = harness(t);
  await runCli(["mcp-config"]);
  const config = JSON.parse(out[0]!);
  assert.deepEqual(config.mcpServers.hivemind.args.slice(0, 1), ["tsx"]);
  assert.ok(config.mcpServers.hivemind.args[1].endsWith(path.join("src", "cli.ts")));
  assert.equal(config.mcpServers.hivemind.env.HIVEMIND_URL, "http://127.0.0.1:7999");
  assert.match(err.join("\n"), /Server must be running at http:\/\/127\.0\.0\.1:7999/);
});

test("mcp-config launcher uses plain node and the compiled CLI for an installed package", () => {
  assert.deepEqual(mcpLauncher(true, "/pkg"), { command: "node", args: [path.resolve("/pkg", "dist/node/cli.js"), "mcp"] });
  assert.deepEqual(mcpLauncher(false, "/pkg"), { command: "npx", args: ["tsx", path.resolve("/pkg", "src/cli.ts"), "mcp"] });
});

test("plugins delegates to the plugin manager", async (t) => {
  harness(t);
  await assert.rejects(runCli(["plugins", "list", "--home", "relative"]), /absolute Hivemind --home/);
});

const joined = (created: boolean, standingOrders?: string) => ({
  agent: { name: "Ada" }, token: "new-token", created, describe: "worker · senior", standingOrders,
});

test("join as a worker sends role, seniority, focus and project with the env token", async (t) => {
  const { calls, out } = harness(t, joined(true, "ORDERS"));
  await runCli(["join", "--as", "worker", "senior", "--focus", "tests", "--project", "demo"]);
  assert.equal(calls[0]!.path, "/api/agent/join");
  assert.equal(calls[0]!.auth, "Bearer env-token");
  assert.deepEqual(calls[0]!.body, {
    role: "worker", seniority: "senior", focus: "tests", resume: null, project: "demo", cwd: process.cwd(),
  });
  assert.deepEqual(out, ["Joined as Ada · worker · senior", "export HIVEMIND_TOKEN=new-token", "", "ORDERS"]);
});

test("join --resume sends no stored credential and reports unchanged orders", async (t) => {
  const { calls, out } = harness(t, joined(false));
  await runCli(["join", "--as", "brain", "--resume", "Ada"]);
  assert.equal(calls[0]!.auth, null);
  assert.deepEqual(calls[0]!.body, { role: "brain", seniority: null, focus: null, resume: "Ada", project: null, cwd: process.cwd() });
  assert.deepEqual(out, ["Back as Ada · worker · senior", "export HIVEMIND_TOKEN=new-token", "orders unchanged — hivemind standing-orders"]);
});

test("join keeps an explicit session token, even when resuming", async (t) => {
  const { calls } = harness(t, joined(false));
  await runCli(["join", "--as", "worker", "--seniority", "mid", "--resume", "Ada", "--token", "shell-token"]);
  assert.equal(calls[0]!.auth, "Bearer shell-token");
  assert.equal((calls[0]!.body as { seniority: string }).seniority, "mid");
});

test("join without a token and without resume joins anonymously", async (t) => {
  delete process.env.HIVEMIND_TOKEN;
  const { calls } = harness(t, joined(true));
  await runCli(["join", "--as", "brain"]);
  assert.equal(calls[0]!.auth, null);
});

test("join rejects missing roles and seniority", async (t) => {
  const { calls } = harness(t);
  await assert.rejects(runCli(["join"]), /join --as worker\|brain/);
  await assert.rejects(runCli(["join", "--as", "worker"]), /Workers need seniority/);
  assert.equal(calls.length, 0);
});

test("doctor checks server health", async (t) => {
  const { calls, out } = harness(t, { ok: true }, new Response("", { status: 503 }));
  await runCli(["doctor"]);
  assert.equal(calls[0]!.path, "/api/health");
  assert.deepEqual(out, ["ok http://127.0.0.1:7999"]);
  await assert.rejects(runCli(["doctor"]), /server not healthy \(503\)/);
});

test("authenticated commands require a token and prefer --token over the environment", async (t) => {
  const { calls } = harness(t, { standingOrders: "orders" });
  delete process.env.HIVEMIND_TOKEN;
  await assert.rejects(runCli(["whoami"]), /No token\. Join first/);
  assert.equal(calls.length, 0);
  process.env.HIVEMIND_TOKEN = "env-token";
  await runCli(["standing-orders", "--token", "flag-token"]);
  assert.equal(calls[0]!.auth, "Bearer flag-token");
});

test("wait opens the session, waits with the requested timeout and prints the session", async (t) => {
  const { calls, out } = harness(t, { ok: true }, { idle: true, messages: [] });
  await runCli(["wait", "--session", "session-1", "--timeout", "5"]);
  assert.deepEqual(calls.map(call => call.path), ["/api/agent/inbox/session", "/api/agent/wait"]);
  assert.deepEqual(calls[0]!.body, { sessionId: "session-1" });
  assert.deepEqual(calls[1]!.body, { timeoutMs: 5000, compact: true, sessionId: "session-1" });
  assert.deepEqual(JSON.parse(out[0]!), { idle: true, messages: [], sessionId: "session-1" });
});

test("wait generates a session and rejects an invalid timeout", async (t) => {
  const { calls, out } = harness(t, { ok: true }, { idle: true });
  await runCli(["wait"]);
  const sessionId = (calls[0]!.body as { sessionId: string }).sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(out[0]!).sessionId, sessionId);
  await assert.rejects(runCli(["wait", "--timeout", "0"]));
  await assert.rejects(runCli(["wait", "--timeout", "soon"]), /unsigned decimal integer/);
});

test("ack requires a delivery and session", async (t) => {
  const { calls, out } = harness(t, { ok: true });
  await assert.rejects(runCli(["ack"]), /ack DELIVERY_ID --session/);
  await assert.rejects(runCli(["ack", "d1"]), /ack DELIVERY_ID --session/);
  await runCli(["ack", "d1", "--session", "s"]);
  assert.deepEqual(calls, [{ method: "POST", path: "/api/agent/inbox/ack", body: { sessionId: "s", deliveryId: "d1" }, auth: "Bearer env-token" }]);
  assert.deepEqual(out, ['{"ok":true}']);
});

function inputFile(name: string, value: unknown) {
  const file = path.join(home, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("capabilities get and set", async (t) => {
  const file = inputFile("caps.json", { skills: ["ts"] });
  const { calls } = harness(t, { ok: true });
  await runCli(["capabilities", "get", "--worker", "w 1"]);
  await runCli(["capabilities", "set", "--input", file]);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["GET", "/api/agent/workers/w%201/capabilities", undefined],
    ["POST", "/api/agent/capabilities", { skills: ["ts"] }],
  ]);
  await assert.rejects(runCli(["capabilities", "get"]), /capabilities get --worker UUID/);
  await assert.rejects(runCli(["capabilities", "set"]), /capabilities get --worker UUID/);
});

test("task reads route to handoffs, handoff and get", async (t) => {
  const { calls, out } = harness(t, { ok: true });
  await runCli(["task", "handoffs"]);
  await runCli(["task", "handoffs", "--before", "t/1"]);
  await runCli(["task", "handoff", "--id", "t1"]);
  await runCli(["task", "get", "--id", "t1"]);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    "GET /api/agent/handoffs",
    "GET /api/agent/handoffs?beforeTask=t%2F1",
    "GET /api/agent/tasks/t1/handoff",
    "GET /api/agent/tasks/t1",
  ]);
  assert.equal(out.length, 4);
});

test("task writes route each operation to its endpoint", async (t) => {
  const file = inputFile("task.json", { title: "x" });
  const { calls } = harness(t, { ok: true });
  await runCli(["task", "assign", "--input", file]);
  for (const operation of ["event", "claim-preview", "suggest", "routing-outcome", "routing-override"]) {
    await runCli(["task", operation, "--id", "t1", "--input", file]);
  }
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    "POST /api/agent/tasks",
    "POST /api/agent/tasks/t1/events",
    "POST /api/agent/tasks/t1/claim-preview",
    "POST /api/agent/tasks/t1/routing",
    "POST /api/agent/tasks/t1/routing-outcome",
    "POST /api/agent/tasks/t1/routing-override",
  ]);
  assert.ok(calls.every(call => JSON.stringify(call.body) === '{"title":"x"}'));
});

test("task rejects missing input, unknown operations and missing ids", async (t) => {
  const file = inputFile("task.json", {});
  const { calls } = harness(t);
  for (const argv of [["task", "assign"], ["task", "bogus", "--input", file], ["task", "event", "--input", file], ["task", "get"], ["task"]]) {
    await assert.rejects(runCli(argv), /task assign --input FILE\.json \| task get/);
  }
  assert.equal(calls.length, 0);
});

test("room get, history and event", async (t) => {
  const file = inputFile("room.json", { kind: "note" });
  const { calls } = harness(t, { ok: true });
  await runCli(["room", "get", "--channel", "ops room"]);
  await runCli(["room", "history", "--channel", "ops"]);
  await runCli(["room", "history", "--channel", "ops", "--before", "4"]);
  await runCli(["room", "event", "--channel", "ops", "--input", file]);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["GET", "/api/agent/channels/ops%20room/room", undefined],
    ["GET", `/api/agent/channels/ops/room/history?before=${Number.MAX_SAFE_INTEGER}`, undefined],
    ["GET", "/api/agent/channels/ops/room/history?before=4", undefined],
    ["POST", "/api/agent/channels/ops/room", { kind: "note" }],
  ]);
  await assert.rejects(runCli(["room", "get"]), /room get\|history\|event --channel/);
  await assert.rejects(runCli(["room", "bogus", "--channel", "ops"]), /room get\|history\|event --channel/);
  await assert.rejects(runCli(["room", "--channel", "ops"]), /room get\|history\|event --channel/);
  await assert.rejects(runCli(["room", "event", "--channel", "ops"]), /room event requires --input/);
});

test("subscriptions list, set and reset", async (t) => {
  const { calls } = harness(t, { ok: true });
  await runCli(["subscriptions", "list"]);
  await runCli(["subscriptions", "set", "--channel", "ops", "--events", "progress,blocker"]);
  await runCli(["subscriptions", "set", "--channel", "ops", "--thread", "root", "--mute"]);
  await runCli(["subscriptions", "reset", "--channel", "ops"]);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["GET", "/api/agent/subscriptions", undefined],
    ["POST", "/api/agent/subscriptions", { channel: "ops", eventTypes: ["progress", "blocker"] }],
    ["POST", "/api/agent/subscriptions", { channel: "ops", threadId: "root", eventTypes: [] }],
    ["POST", "/api/agent/subscriptions/reset", { channel: "ops" }],
  ]);
});

test("subscriptions reject bad operations and ambiguous event choices", async (t) => {
  const { calls } = harness(t);
  await assert.rejects(runCli(["subscriptions", "bogus"]), /subscriptions list\|set\|reset/);
  await assert.rejects(runCli(["subscriptions", "set"]), /subscriptions requires --channel/);
  await assert.rejects(runCli(["subscriptions", "set", "--channel", "ops"]), /Choose --events TYPE,TYPE or --mute/);
  await assert.rejects(runCli(["subscriptions", "set", "--channel", "ops", "--events", "progress", "--mute"]), /Choose --events/);
  assert.equal(calls.length, 0);
});

const sent = { ok: true, id: "m1", seq: 7 };

test("send posts a multi-word body to a channel with thread, event type and recipients", async (t) => {
  const thread = "11111111-1111-4111-8111-111111111111";
  const { calls, out, err } = harness(t, sent);
  await runCli(["send", "--channel", "general", "--body", "hello", "big", "world", "--thread", thread,
    "--event-type", "progress", "--recipients", "Ada,Bob", "--request-id", "req-1"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/api/agent/channels/general/messages");
  assert.deepEqual(calls[0]!.body, {
    body: "hello big world", threadId: thread, attachmentIds: [], eventType: "progress",
    recipients: ["Ada", "Bob"], requestId: "req-1",
  });
  assert.deepEqual(err, ["Send requestId: req-1"]);
  assert.deepEqual(out, ["sent m1 seq 7"]);
});

test("send --to opens the DM first and forwards --execution-id", async (t) => {
  const { calls, err } = harness(t, { channel: { id: "dm-1" } }, sent);
  await runCli(["send", "--to", "Ada", "--body", "do it", "--execution-id", "exec-1"]);
  assert.deepEqual(calls.map(call => call.path), ["/api/agent/dms", "/api/agent/channels/dm-1/messages"]);
  assert.deepEqual(calls[0]!.body, { name: "Ada" });
  const body = calls[1]!.body as { executionId: string; requestId: string; threadId: null };
  assert.equal(body.executionId, "exec-1");
  assert.equal(body.threadId, null);
  assert.match(err[0]!, new RegExp(`^Send requestId: ${body.requestId}$`));
});

test("send uploads an attached file before posting", async (t) => {
  const file = path.join(home, "note.txt");
  const attachment = "22222222-2222-4222-8222-222222222222";
  writeFileSync(file, "attached");
  const { calls } = harness(t, { file: { id: attachment } }, sent);
  await runCli(["send", "--channel", "general", "--file", file]);
  assert.deepEqual(calls.map(call => call.path), ["/api/agent/files", "/api/agent/channels/general/messages"]);
  assert.deepEqual((calls[1]!.body as { attachmentIds: string[]; body: string }).attachmentIds, [attachment]);
  assert.equal((calls[1]!.body as { body: string }).body, "");
});

test("send validates its flags before contacting the hive", async (t) => {
  const { calls } = harness(t);
  await assert.rejects(runCli(["send", "--channel", "general", "--body", "x", "--event-type", "gossip"]), /Unknown --event-type/);
  await assert.rejects(runCli(["send", "--channel", "general"]), /send --body TEXT {2}and\/or {2}--file PATH/);
  await assert.rejects(runCli(["send", "--body", "x"]), /send --channel NAME {2}or {2}--to NAME/);
  await assert.rejects(runCli(["send", "--channel", "general", "--body", "x", "--execution-id", "bad id"]));
  await assert.rejects(runCli(["send", "--channel", "general", "--body", "x", "--thread", "not-a-uuid"]));
  await assert.rejects(runCli(["send", "--channel", "general", "--file", path.join(home, "blob.bin")]), /unsupported file type/);
  assert.equal(calls.length, 0);
});

test("send accepts a BODY_MAX body and rejects one more unit before contacting the hive", async (t) => {
  const { calls } = harness(t, sent);
  const body = "s".repeat(BODY_MAX);
  await runCli(["send", "--channel", "general", "--body", body, "--request-id", "long-1"]);
  assert.equal((calls[0]!.body as { body: string }).body, body);
  await assert.rejects(runCli(["send", "--channel", "general", "--body", body + "s"]), /Invalid request field: body/);
  assert.equal(calls.length, 1);
});

test("send reports a failed post with its retry key", async (t) => {
  harness(t, Response.json({ error: "nope" }, { status: 500 }));
  await assert.rejects(runCli(["send", "--channel", "general", "--body", "x", "--request-id", "req-2"]),
    /Send req-2 failed: nope\. Retry the same input with requestId\/--request-id req-2/);
});

test("expand posts message ids with an optional cursor", async (t) => {
  const { calls } = harness(t, { messages: [] });
  await runCli(["expand", "--channel", "c1", "--ids", "a,b"]);
  await runCli(["expand", "--channel", "c1", "--ids", "a", "--after", "3"]);
  assert.deepEqual(calls.map(call => call.body), [
    { channel: "c1", messageIds: ["a", "b"] },
    { channel: "c1", messageIds: ["a"], afterSeq: 3 },
  ]);
  await assert.rejects(runCli(["expand", "--channel", "c1"]), /expand --channel ID --ids/);
  await assert.rejects(runCli(["expand", "--ids", "a"]), /expand --channel ID --ids/);
});

test("fetch downloads an attachment into the output directory", async (t) => {
  const outDir = path.join(home, "inbox");
  const { calls, out } = harness(t, new Response("payload", {
    headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="note.txt"' },
  }));
  await runCli(["fetch", "--id", "abcdefgh1234", "--out", outDir]);
  assert.equal(calls[0]!.path, "/api/agent/files/abcdefgh1234");
  assert.equal(out[0], path.join(outDir, "abcdefgh-note.txt"));
  assert.equal(readFileSync(out[0]!, "utf8"), "payload");
  await assert.rejects(runCli(["fetch"]), /fetch --id ATT_ID/);
});

test("react adds or removes a reaction", async (t) => {
  const { calls, out } = harness(t, { ok: true });
  await runCli(["react", "--seq", "5", "--emoji", "👍"]);
  await runCli(["react", "--seq", "5", "--emoji", "👍", "--remove"]);
  assert.deepEqual(calls.map(call => [call.path, call.body]), [
    ["/api/agent/messages/5/reactions", { emoji: "👍", present: true }],
    ["/api/agent/messages/5/reactions", { emoji: "👍", present: false }],
  ]);
  assert.deepEqual(out, ["reacted 👍 on 5", "reacted 👍 on 5"]);
  await assert.rejects(runCli(["react", "--seq", "5"]), /react --seq N --emoji/);
  await assert.rejects(runCli(["react", "--emoji", "👍"]), /unsigned decimal integer/);
});

test("gc collects unreferenced files in the local hive", async (t) => {
  const { out } = harness(t);
  await runCli(["gc"]);
  assert.deepEqual(out, ["gc attachments=0 blobs=0"]);
});

test("search prints hits, DM names and the next page hint", async (t) => {
  const { calls, out } = harness(t, { hits: [], hasMore: false }, {
    hits: [
      { seq: 9, channelName: "general", channelType: "channel", authorName: "Ada", body: "found" },
      { seq: 4, channelName: "Ada·Bob", channelType: "dm", authorName: "Bob", body: "also" },
    ],
    hasMore: true,
  });
  await runCli(["search", "--q", "nothing"]);
  await runCli(["search", "--query", "found", "--channel", "general", "--before", "10", "--limit", "2"]);
  assert.deepEqual(calls.map(call => call.path), [
    "/api/agent/search?q=nothing",
    "/api/agent/search?q=found&channel=general&beforeSeq=10&limit=2",
  ]);
  assert.deepEqual(out, ["no hits", "9 #general Ada: found", "4 Ada·Bob Bob: also", "more: search --q … --before 4"]);
  await assert.rejects(runCli(["search"]), /search --q TEXT/);
});

test("history prints messages and both cursors, keeping the thread", async (t) => {
  const createdAt = Date.UTC(2026, 0, 1, 12, 34, 56);
  const { calls, out } = harness(t,
    { messages: [{ createdAt, authorName: "Ada", body: "hi" }], cursors: { before: 3, after: 8 } },
    { messages: [] });
  await runCli(["history", "--channel", "ops", "--thread", "root", "--since", "2", "--limit", "5", "--meta", "1"]);
  await runCli(["history", "--channel", "ops", "--before", "3"]);
  assert.deepEqual(calls.map(call => call.path), [
    "/api/agent/channels/ops/messages?limit=5&meta=1&threadId=root&afterSeq=2",
    "/api/agent/channels/ops/messages?limit=20&meta=0&beforeSeq=3",
  ]);
  assert.deepEqual(out, [
    "[12:34:56] Ada: hi",
    "older: history --channel ops --before 3 --thread root",
    "newer: history --channel ops --since 8 --thread root",
  ]);
  await assert.rejects(runCli(["history"]), /history --channel NAME/);
  await assert.rejects(runCli(["history", "--channel", "ops", "--since", "1", "--before", "2"]), /not both/);
});

test("history cursors omit the thread when none was requested", async (t) => {
  const { out } = harness(t, { messages: [], cursors: { before: 1, after: 2 } });
  await runCli(["history", "--channel", "ops"]);
  assert.deepEqual(out, ["older: history --channel ops --before 1", "newer: history --channel ops --since 2"]);
});

test("agents and channels print one line each", async (t) => {
  const { out } = harness(t,
    { agents: [{ name: "Ada", online: true, role: "worker", seniority: "senior", focus: "tests" },
      { name: "Bob", online: false, role: "brain", seniority: null, focus: null }] },
    { channels: [{ type: "channel", name: "general" }, { type: "dm", name: "Ada·Bob" }] });
  await runCli(["agents"]);
  await runCli(["channels"]);
  assert.deepEqual(out, [
    "online   Ada          worker senior tests",
    "offline  Bob          brain",
    "channel  #general",
    "dm       Ada·Bob",
  ]);
});

test("whoami, standing-orders and leave", async (t) => {
  const { calls, out } = harness(t, { you: { name: "Ada" } }, { standingOrders: "ORDERS" }, { ok: true });
  await runCli(["whoami"]);
  await runCli(["standing-orders"]);
  await runCli(["leave"]);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    "GET /api/agent/me", "GET /api/agent/me?orders=1", "POST /api/agent/leave",
  ]);
  assert.deepEqual(JSON.parse(out[0]!), { you: { name: "Ada" } });
  assert.deepEqual(out.slice(1), ["ORDERS", "offline"]);
});

test("clear-context accepts --agent or --to", async (t) => {
  const { calls, out } = harness(t, { message: { id: "m9" } });
  await runCli(["clear-context", "--agent", "Ada"]);
  await runCli(["clear-context", "--to", "Bob"]);
  assert.deepEqual(calls.map(call => call.body), [{ name: "Ada" }, { name: "Bob" }]);
  assert.deepEqual(out, ["clear_context sent to Ada (m9)", "clear_context sent to Bob (m9)"]);
  await assert.rejects(runCli(["clear-context"]), /clear-context --agent NAME/);
});

test("invite accepts --member or --name and names DMs without a hash", async (t) => {
  const { calls, out } = harness(t, { channel: { type: "channel", name: "ops" } }, { channel: { type: "dm", name: "Ada·Bob" } });
  await runCli(["invite", "--channel", "ops", "--member", "Ada"]);
  await runCli(["invite", "--channel", "dm 1", "--name", "Bob"]);
  assert.deepEqual(calls.map(call => [call.path, call.body]), [
    ["/api/agent/channels/ops/invite", { names: ["Ada"] }],
    ["/api/agent/channels/dm%201/invite", { names: ["Bob"] }],
  ]);
  assert.deepEqual(out, ["invited Ada to #ops", "invited Bob to Ada·Bob"]);
  await assert.rejects(runCli(["invite", "--channel", "ops"]), /invite --channel NAME --member NAME/);
  await assert.rejects(runCli(["invite", "--member", "Ada"]), /invite --channel NAME --member NAME/);
});
