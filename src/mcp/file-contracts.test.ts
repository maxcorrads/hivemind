import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as yieldForIO } from "node:timers/promises";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import { PNG } from "../server/fixtures/preview-images.ts";
import { childEnv } from "../test-support/child-process.ts";

function workspace(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mcp-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function client(t: TestContext, cwd: string, url: string, token: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", fileURLToPath(import.meta.resolve("tsx")), fileURLToPath(new URL("./index.ts", import.meta.url))],
    cwd,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_URL: url, HIVEMIND_HOME: cwd, HIVEMIND_TOKEN: token }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => { /* drain diagnostics without credentials in test logs */ });
  const client = new Client({ name: "file-contract", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test("real MCP fetch_file reads large image headers rather than a synthetic placeholder", { timeout: 10_000 }, async (t) => {
  const dir = workspace(t);
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => hive.db.close());
  const server = startServer({ port: 0, hive, telegram: false });
  const port = await server.ready;
  t.after(async () => { const closed = once(server.server, "close"); server.shutdown(); server.server.closeAllConnections(); await closed; });
  const joined = hive.identity.join({ role: "worker", seniority: "mid" });
  const oversized = Buffer.alloc(1_600_000);
  PNG.copy(oversized);
  oversized.writeUInt32BE(50_000, 16);
  oversized.writeUInt32BE(50_000, 20);
  PNG.subarray(-12).copy(oversized, oversized.length - 12);
  const att = await hive.files.createFileFromBytes(joined.agent, { name: "oversized.png", mime: "image/png", bytes: oversized });
  const mcp = await client(t, dir, `http://127.0.0.1:${port}`, joined.token);
  const result = await mcp.callTool({ name: "fetch_file", arguments: { id: att.id } });
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.equal(content.length, 1);
  assert.equal(content[0]!.type, "text");
  const file = JSON.parse(content[0]!.text!) as { path: string; bytes: number };
  assert.equal(file.bytes, oversized.length);
  assert.deepEqual(readFileSync(file.path), oversized);
  assert.ok(readdirSync(path.dirname(file.path)).every((name) => !name.startsWith(".download-")));
});

test("real MCP cancellation aborts its HTTP download and cleans the partial file", { timeout: 10_000 }, async (t) => {
  const dir = workspace(t);
  let respond!: () => void;
  const requested = new Promise<void>((resolve) => { respond = resolve; });
  let disconnected!: () => void;
  const closedResponse = new Promise<void>((resolve) => { disconnected = resolve; });
  const http = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="slow.txt"', "content-length": "100000" });
    res.write("partial");
    res.on("close", disconnected);
    respond();
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => { const done = once(http, "close"); http.close(); http.closeAllConnections(); await done; });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const mcp = await client(t, dir, `http://127.0.0.1:${address.port}`, "fixture-token");
  const controller = new AbortController();
  const call = mcp.callTool({ name: "fetch_file", arguments: { id: "fixture" } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(call);
  await requested;
  const inbox = path.join(dir, ".hivemind-inbox");
  // Directory-watch notifications can be coalesced or omitted on macOS. Poll
  // the actual lifecycle predicate instead; no elapsed sleep implies success.
  // The original test deadline and cancellation assertions remain unchanged.
  const waitFor = async (predicate: () => boolean) => {
    while (!predicate()) await yieldForIO(10, undefined, { signal: t.signal });
  };
  await waitFor(() => readdirSync(inbox).some((name) => name.startsWith(".download-")));
  const cleaned = waitFor(() => readdirSync(inbox).length === 0);
  controller.abort();
  await rejected;
  await closedResponse;
  await cleaned;
  assert.deepEqual(readdirSync(inbox), []);
});
