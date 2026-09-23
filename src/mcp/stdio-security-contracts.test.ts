import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import { childEnv } from "../test-support/child-process.ts";

async function fixture(t: TestContext) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-stdio-security-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  let started: ReturnType<typeof startServer> | undefined;
  t.after(async () => {
    try {
      await Promise.all(clients.map(async ({ client, transport }) => {
        try { await client.close(); } finally { await transport.close(); }
      }));
    } finally {
      try { await started?.shutdown(); }
      finally { hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
    }
  });
  started = startServer({ port: 0, hive, telegram: false });
  const requests: string[] = [];
  started.server.on("request", request => requests.push(`${request.method} ${request.url}`));
  const port = await started.ready;
  const connect = async (token: string) => {
    const client = new Client({ name: "security-contract", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"],
      cwd: dir,
      env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir, "identities"),
        HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: token }),
      stderr: "pipe",
    });
    clients.push({ client, transport });
    await client.connect(transport, { timeout: 5000, signal: t.signal });
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema,
      { timeout: 5000, signal: t.signal }));
  return { hive, requests, connect, call };
}

function text(result: CallToolResult): string {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

test("real stdio wait fails invalid authentication once instead of entering a retry loop", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect("invalid-security-test-token");
  const result = await f.call(client, "wait");
  assert.equal(result.isError, true);
  assert.match(text(result), /token|unauthori[sz]ed|401/i);
  assert.equal(f.requests.filter(request => request === "POST /api/agent/inbox/session").length, 1);
  assert.equal(f.requests.filter(request => request === "POST /api/agent/wait").length, 0);
});

test("real stdio tools cannot read, search, DM or mutate another project's messages", { timeout: 20_000 }, async t => {
  const f = await fixture(t), human = f.hive.identity.getAgent("human");
  f.hive.projects.createProject(human, { name: "Beta", slug: "beta" });
  const alpha = f.hive.identity.join({ role: "brain", project: "chapter" });
  const beta = f.hive.identity.join({ role: "brain", project: "beta" });
  // Ordinary UUID channel avoids confusing project-local legacy 'general' aliases.
  const channel = f.hive.channels.createChannel(beta.agent, { name: "beta-private", type: "private" });
  const secret = "beta-secret-stdio-fixture";
  const root = f.hive.messages.postMessage(beta.agent, { channel: channel.id, body: secret });
  f.hive.messages.postMessage(beta.agent, { channel: channel.id, threadId: root.id, body: "private thread reply" });
  const before = f.hive.messageQueries.listMessages(beta.agent, channel.id, { limit: 100 }).messages;
  const client = await f.connect(alpha.token);
  const listed = await f.call(client, "channels");
  assert.notEqual(listed.isError, true);
  assert.ok(!text(listed).includes(channel.id));
  const searched = await f.call(client, "search", { q: secret });
  assert.notEqual(searched.isError, true);
  const searchData = JSON.parse(text(searched)) as { hits: unknown[] };
  assert.deepEqual(searchData.hits, []);
  for (const [name, args] of [
    ["history", { channel: channel.id }],
    ["history", { channel: channel.id, threadId: root.id }],
    ["search", { q: secret, channel: channel.id }],
    ["send", { to: beta.agent.name, body: "must never be delivered" }],
    ["send", { channel: channel.id, body: "must never be written" }],
    ["set_thread_status", { threadId: root.id, status: "done" }],
  ] satisfies Array<[string, Record<string, unknown>]>) {
    const result = await f.call(client, name, args);
    assert.equal(result.isError, true, name);
    assert.ok(!text(result).includes(secret), `${name} leaked content in its error`);
  }
  const thread = f.hive.messageQueries.threadsInChannel(channel.id).find(thread => thread.id === root.id);
  assert.equal(thread?.status, "open");
  assert.deepEqual(f.hive.messageQueries.listMessages(beta.agent, channel.id, { limit: 100 }).messages, before);
});
