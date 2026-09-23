import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hive } from "../server/hive.ts";
import { createApp } from "../server/app.ts";
import { countRows } from "../server/test-fixtures.ts";
import { childEnv } from "../test-support/child-process.ts";

// Actual CLI process restart, upload, HTTP after-commit loss and stdio tool calls.
test("CLI and MCP preserve send keys and uploaded IDs across lost replies and process restarts", { timeout: 25_000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), dir = mkdtempSync(path.join(os.tmpdir(), "hive-send-transports-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const brain = hive.identity.join({ role: "brain" }), worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  const listener = getRequestListener(createApp(hive).fetch);
  let drop = true, uploads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/agent/files" && req.method === "POST") uploads++;
    if (drop && req.url?.endsWith("/messages") && req.method === "POST") {
      drop = false; res.write = (() => true) as typeof res.write;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    listener(req, res);
  });
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  t.after(async () => {
    try { await client?.close(); await transport?.close(); }
    finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      hive.db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const file = path.join(dir, "fixture.txt"); writeFileSync(file, "durable upload fixture");
  const env = childEnv({ ...process.env, HIVEMIND_HOME: path.join(dir, "client"), HIVEMIND_URL: url, HIVEMIND_TOKEN: brain.token });
  const cli = (body = "CLI lost response") => promisify(execFile)(process.execPath,
    ["--import", "tsx", "src/cli.ts", "send", "--channel", dm.id, "--file", file, "--request-id", "cli-operation", "--body", body],
    { cwd: root, env, signal: t.signal });
  const messages: string[] = []; hive.bus.on("message", message => messages.push(message.id));
  await assert.rejects(cli(), error => error instanceof Error && "code" in error && error.code !== 0 && "stderr" in error && /cli-operation/.test(String(error.stderr)));
  assert.equal(messages.length, 1); assert.equal(uploads, 1);
  const replay = await cli(); assert.ok(replay.stdout.includes(messages[0]!));
  assert.equal(messages.length, 1); assert.equal(uploads, 1);
  await assert.rejects(cli("different"), /another local payload/);
  writeFileSync(file, "different file under same key");
  await assert.rejects(cli(), /another local payload/);
  assert.equal(uploads, 1);

  transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"], cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: env.HIVEMIND_HOME, HIVEMIND_URL: url, HIVEMIND_TOKEN: brain.token }), stderr: "pipe" });
  client = new Client({ name: "send-retry-fixture", version: "1" }); await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = CallToolResultSchema.parse(await client!.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 5000, signal: t.signal }));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content[0]!; assert.equal(text.type, "text");
    return JSON.parse((text as { text: string }).text);
  };
  const input = { channel: dm.id, body: "MCP retry", requestId: "mcp-operation" };
  const a = await call("send", input), b = await call("send", input);
  assert.equal(a.id, b.id); assert.equal(a.seq, b.seq); assert.equal(a.requestId, input.requestId);
  assert.equal(messages.length, 2);
  await call("react", { seq: a.seq, emoji: "👍" });
  await call("react", { seq: a.seq, emoji: "👍" });
  assert.equal(countRows(hive, "reactions", { message_id: a.id }), 1);
  await call("react", { seq: a.seq, emoji: "👍", present: false });
  await call("react", { seq: a.seq, emoji: "👍", present: false });
  assert.equal(countRows(hive, "reactions", { message_id: a.id }), 0);
  const attached = { channel: dm.id, path: file, body: "MCP file", requestId: "mcp-attachment" };
  const af = await call("attach", attached), bf = await call("attach", attached);
  assert.equal(af.id, bf.id); assert.equal(uploads, 2); assert.equal(messages.length, 3);
});
