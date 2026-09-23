import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import { markInboxRead } from "../server/test-fixtures.ts";
import { WAIT_MAX_BYTES, type DigestExpansionResult, type WaitResult } from "../shared/types.ts";
import { childEnv } from "../test-support/child-process.ts";

test("real MCP and CLI send typed events, reply by root ID and expand the same digest after ACK", { timeout: 25_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-digest-clients-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const server = startServer({ port: 0, hive, telegram: false });
  const port = await server.ready;
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  const room = hive.channels.createChannel(brain.agent, { name: "other-task", type: "private", memberNames: [worker.agent.name] });
  markInboxRead(hive);
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const env = (token: string) => childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_TOKEN: token,
    HIVEMIND_HOME: path.join(dir, "identities"), HIVEMIND_URL: `http://127.0.0.1:${port}` });
  const args = ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts")];
  const connect = async (token: string) => {
    const client = new Client({ name: "digest-fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...args, "mcp"], cwd: dir, env: env(token), stderr: "pipe" });
    clients.push({ client, transport }); await client.connect(transport); return client;
  };
  const call = async <T>(client: Client, name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= WAIT_MAX_BYTES);
    return JSON.parse((result.content as Array<{ type: string; text: string }>).find(c => c.type === "text")!.text) as T;
  };
  const cli = async (token: string, input: string[]) => (await promisify(execFile)(process.execPath, [...args, ...input],
    { cwd: dir, env: env(token), timeout: 10_000 })).stdout;
  try {
    const sender = await connect(worker.token);
    const reader = await connect(brain.token);
    assert.ok((await reader.listTools()).tools.some(tool => tool.name === "expand_digest"));
    const first = await call<{ id: string }>(sender, "send", { channel: dm.id, body: "Step zero", eventType: "progress" });
    const expected = [first.id];
    for (let i = 0; i < 9; i++) expected.push((await call<{ id: string }>(sender, "send",
      { channel: dm.id, threadId: first.id, body: `Step ${i + 1}`, eventType: "progress" })).id);
    const blocker = await call<{ id: string; seq: number }>(sender, "send",
      { channel: dm.id, threadId: first.id, body: "Decision needed", eventType: "blocker" });
    await call(sender, "send", { channel: room.id, body: "Other thread", eventType: "progress" });
    const batch = await call<WaitResult>(reader, "wait", {});
    const digest = batch.mail!.find(m => m.expand?.messageIds.includes(first.id))!;
    assert.deepEqual(digest.expand!.messageIds, expected);
    assert.equal(batch.mail!.find(m => m.seq === blocker.seq)!.body, "Decision needed");
    const pending = hive.inbox.status(brain.agent.id);
    const page = await call<DigestExpansionResult>(reader, "expand_digest", digest.expand!);
    assert.equal(page.hasMore, true); assert.equal(page.messages.length, 8);
    assert.deepEqual(hive.inbox.status(brain.agent.id), pending);
    await call(reader, "ack_delivery", { deliveryId: batch.delivery!.id });
    const next = await call<DigestExpansionResult>(reader, "expand_digest", { ...digest.expand!, afterSeq: page.nextAfterSeq });
    assert.deepEqual([...page.messages, ...next.messages].map(m => m.id), expected);
    const reply = await call<{ seq: number }>(reader, "send", { channel: digest.channelId, threadId: digest.rootId, body: "Answer" });
    assert.equal(hive.messageQueries.getVisibleMessage(brain.agent, reply.seq).threadId, first.id);

    const cliPage = JSON.parse(await cli(brain.token, ["expand", "--channel", digest.channelId, "--ids", expected.join(",")])) as DigestExpansionResult;
    assert.deepEqual(cliPage, page);
    const cliTail = JSON.parse(await cli(brain.token, ["expand", "--channel", digest.channelId, "--ids", expected.join(","), "--after", String(cliPage.nextAfterSeq)])) as DigestExpansionResult;
    assert.deepEqual(cliTail, next);
    const sent = await cli(worker.token, ["send", "--channel", dm.id, "--thread", first.id, "--event-type", "question", "--body", "CLI question"]);
    const match = /seq (\d+)/.exec(sent)!;
    assert.equal(hive.messageQueries.getVisibleMessage(brain.agent, Number(match[1])).eventType, "question");
    const acked = hive.inbox.status(brain.agent.id);
    const invalid = await reader.callTool({ name: "expand_digest", arguments: { channel: dm.id, messageIds: ["invalid"] } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(hive.inbox.status(brain.agent.id), acked);
  } finally {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    server.shutdown(); server.server.closeAllConnections(); hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
