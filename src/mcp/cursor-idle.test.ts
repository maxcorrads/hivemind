import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import { childEnv } from "../test-support/child-process.ts";
import {
  CURSOR_IDLE_NEXT, CURSOR_REARM_MESSAGE, cursorIdleSocketPath, cursorStopHookConfigured, cursorStopHookOutput,
  requestCursorIdleWait, startCursorIdleServer,
} from "./cursor-idle.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hooks = (command: string) => JSON.stringify({ version: 1, hooks: { stop: [{ command, timeout: 86400, loop_limit: null }] } });
const session = () => `hm-acme-cursor-${randomUUID().slice(0, 8)}`;

test("the stop hook counts only when hooks.json runs cursor-stop-hook, at home or in the project or above it", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-cursor-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), project = path.join(dir, "work", "repo"), nested = path.join(project, "pkg");
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  mkdirSync(path.join(nested, ".cursor"), { recursive: true });
  assert.equal(cursorStopHookConfigured(nested, home), false, "no hooks.json");
  writeFileSync(path.join(home, ".cursor", "hooks.json"), hooks("./format.sh"));
  assert.equal(cursorStopHookConfigured(nested, home), false, "another stop hook");
  writeFileSync(path.join(nested, ".cursor", "hooks.json"), "{ not json");
  assert.equal(cursorStopHookConfigured(nested, home), false, "unreadable project hooks");
  mkdirSync(path.join(project, ".cursor"), { recursive: true });
  writeFileSync(path.join(project, ".cursor", "hooks.json"), hooks("/opt/hivemind/node_modules/.bin/tsx cli.ts cursor-stop-hook"));
  assert.equal(cursorStopHookConfigured(nested, home), true, "a project above the folder");
  rmSync(path.join(project, ".cursor"), { recursive: true });
  writeFileSync(path.join(home, ".cursor", "hooks.json"), hooks("node /usr/lib/hivemind/cli.js cursor-stop-hook"));
  assert.equal(cursorStopHookConfigured(nested, home), true, "the user's hooks.json");
});

test("the stop hook answers nothing outside Hivemind and turns each idle-socket reply into a follow-up", async () => {
  const env = { HIVEMIND_TMUX_SESSION: "hm-acme-cursor" };
  const asked: string[] = [];
  const answer = (reply: Awaited<ReturnType<typeof requestCursorIdleWait>>) => async (socketPath: string) => { asked.push(socketPath); return reply; };
  assert.deepEqual(await cursorStopHookOutput("{}", {}, answer({ mail: "x" })), {}, "no Hivemind session");
  assert.deepEqual(await cursorStopHookOutput(JSON.stringify({ status: "aborted" }), env, answer({ mail: "x" })), {}, "an interrupted turn");
  assert.deepEqual(await cursorStopHookOutput(JSON.stringify({ status: "error" }), env, answer({ mail: "x" })), {}, "a failed turn");
  assert.equal(asked.length, 0, "none of those asks the MCP process");
  assert.deepEqual(await cursorStopHookOutput(JSON.stringify({ status: "completed" }), env, answer(null)), {}, "no MCP process listening");
  assert.deepEqual(await cursorStopHookOutput(JSON.stringify({ status: "completed", loop_count: 3 }), env, answer({ mail: '{"delivery":{}}' })),
    { followup_message: 'Hivemind mail:\n{"delivery":{}}' });
  assert.deepEqual(await cursorStopHookOutput("", env, answer({ idle: true })), { followup_message: CURSOR_REARM_MESSAGE });
  assert.match((await cursorStopHookOutput("", env, answer({ error: "HTTP 409 superseded" }))).followup_message!, /could not wait.*HTTP 409.*Call wait once/);
  assert.ok(asked.every(socketPath => socketPath === cursorIdleSocketPath("hm-acme-cursor")));
  assert.ok(Buffer.byteLength(cursorIdleSocketPath("hm-" + "x".repeat(80))) < 104, "socket paths fit macOS sun_path");
});

test("the idle socket serves one waiter: a newer hook cancels the older wait, and a hook that leaves cancels its own", async t => {
  const socketPath = cursorIdleSocketPath(session());
  const seen: Array<{ maxMs: number; signal: AbortSignal }> = [];
  let release: ((mail: string | null) => void) | undefined;
  const server = startCursorIdleServer(socketPath, (signal, maxMs) => {
    seen.push({ maxMs, signal });
    return new Promise(resolve => { release = resolve; });
  });
  t.after(() => server.close());
  await new Promise(resolve => setTimeout(resolve, 50));
  const older = requestCursorIdleWait(socketPath, 5_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  const newer = requestCursorIdleWait(socketPath, 10_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.maxMs, 5_000);
  assert.equal(seen[0]!.signal.aborted, true, "the newer hook cancelled the older wait");
  release!("mail for you");
  assert.deepEqual(await newer, { mail: "mail for you" });
  server.close();
  assert.equal(await older, null, "the cancelled hook got no mail and lets its turn end");
  assert.equal(await requestCursorIdleWait(socketPath), null, "nobody listens after close");
});

test("a Cursor session with the stop hook ends its turn when idle and gets its mail through the hook", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-cursor-idle-"));
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  writeFileSync(path.join(home, ".cursor", "hooks.json"), hooks(`tsx ${path.join(root, "src/cli.ts")} cursor-stop-hook`));
  const hive = new Hive(path.join(dir, "data", "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const tmuxSession = session();
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const connect = async (name: string, token: string) => {
    const client = new Client({ name, version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"], cwd: dir,
      env: childEnv({ PATH: process.env.PATH ?? "", HOME: home, HIVEMIND_HOME: path.join(dir, "identities"),
        HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: token, HIVEMIND_TMUX_SESSION: tmuxSession }), stderr: "pipe" });
    clients.push({ client, transport });
    await client.connect(transport);
    return client;
  };
  const call = async <T>(client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as Array<{ type: string; text: string }>).find(x => x.type === "text")!.text) as T;
  };
  const stopHook = (input: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"),
      "cursor-stop-hook"], { cwd: dir, env: childEnv({ PATH: process.env.PATH ?? "", HOME: home, HIVEMIND_TMUX_SESSION: tmuxSession }) });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
    child.stdin.end(input);
  });
  try {
    const registered = hive.identity.join({ role: "worker", seniority: "mid", project: "acme" });
    const cursor = await connect("Cursor", registered.token);
    const joined = await call<{ name: string; next: string }>(cursor, "join", { role: "worker", seniority: "mid", project: "acme" });
    assert.match(joined.next, /end your turn without output and without calling wait/);
    const startedAt = Date.now();
    const idle = await call<{ idle: boolean; next: string }>(cursor, "wait");
    assert.deepEqual(idle, { idle: true, next: CURSOR_IDLE_NEXT });
    assert.ok(Date.now() - startedAt < 10_000, "an idle wait answers at once instead of running into Cursor's 60 s limit");

    const worker = hive.identity.getAgentByName(joined.name)!;
    const human = hive.identity.getAgent("human");
    const dm = hive.channels.openDm(human, worker.name);
    const hook = stopHook(JSON.stringify({ status: "completed", loop_count: 0 }));
    await new Promise(resolve => setTimeout(resolve, 1500));
    const message = hive.messages.postMessage(human, { channel: dm.id, body: "An invented assignment; no external effects" });
    const output = JSON.parse(await hook) as { followup_message: string };
    assert.match(output.followup_message, /^Hivemind mail:\n/);
    const mail = JSON.parse(output.followup_message.slice("Hivemind mail:\n".length)) as { next: string; delivery: { id: string; messageSeqs: number[] } };
    assert.ok(mail.delivery.messageSeqs.includes(message.seq));
    assert.match(mail.next, /end your turn without calling wait/);
    assert.equal(hive.inbox.status(worker.id).acknowledgedMessages, 0, "the hook only fetched the mail");
    await call(cursor, "ack_delivery", { deliveryId: mail.delivery.id });
    assert.equal(hive.inbox.status(worker.id).acknowledgedMessages, 1, "the session acknowledges what the hook handed it");

    // Any other client keeps the ordinary wait loop, hooks or not.
    const other = await connect("claude-code", hive.identity.join({ role: "worker", seniority: "mid", project: "acme" }).token);
    const otherJoin = await call<{ next: string }>(other, "join", { role: "worker", seniority: "mid", project: "acme" });
    assert.match(otherJoin.next, /call wait once with no arguments/);
  } finally {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    await started.shutdown(); hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
