import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import type { WaitResult } from "../shared/types.ts";
import { childEnv } from "../test-support/child-process.ts";

test("real stdio MCP never auto-ACKs; replacement sessions replay and reject stale confirmations", { timeout: 20_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mcp-receipts-"));
  const hive = new Hive(path.join(dir, "data", "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const connect = async (token = "") => {
    const client = new Client({ name: "receipt-fixture", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"], cwd: dir,
      env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir, "identities"), HIVEMIND_URL: `http://127.0.0.1:${port}`, HIVEMIND_TOKEN: token }), stderr: "pipe" });
    clients.push({ client, transport }); await client.connect(transport); return client;
  };
  const call = async <T>(client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as Array<{ type: string; text: string }>).find(x => x.type === "text")!.text) as T;
  };
  try {
    const registered = hive.join({ role: "brain", project: "chapter" });
    const first = await connect(registered.token);
    assert.ok((await first.listTools()).tools.some(t => t.name === "ack_delivery"));
    const joined = await call<{ name: string }>(first, "join", { role: "brain", project: "chapter" });
    const brain = hive.getAgentByName(joined.name)!;
    const human = hive.getAgent("human"); const dm = hive.openDm(human, brain.name);
    const message = hive.postMessage(human, { channel: dm.id, body: "An invented assignment; no external effects" });
    const one = await call<WaitResult>(first, "wait");
    assert.ok(one.delivery); assert.ok(one.delivery.messageSeqs.includes(message.seq));
    assert.match(one.next, /ack_delivery/);
    assert.equal(hive.inbox.status(brain.id).acknowledgedMessages, 0);
    // A second wait in the same live session is not a receipt confirmation.
    // This specifically rejects the superseded implicit-ACK-on-next-wait model.
    const sameSessionReplay = await call<WaitResult>(first, "wait");
    assert.equal(sameSessionReplay.delivery?.id, one.delivery.id);
    assert.equal(sameSessionReplay.delivery?.redelivered, true);
    assert.equal(hive.inbox.status(brain.id).acknowledgedMessages, 0);
    const replacement = await connect(registered.token);
    const replay = await call<WaitResult>(replacement, "wait");
    assert.equal(replay.delivery!.id, one.delivery.id);
    assert.equal(replay.delivery!.redelivered, true);
    const stale = await first.callTool({ name: "ack_delivery", arguments: { deliveryId: one.delivery.id } });
    assert.equal(stale.isError, true);
    assert.equal(hive.inbox.status(brain.id).acknowledgedMessages, 0);
    await call(replacement, "ack_delivery", { deliveryId: replay.delivery!.id });
    assert.equal(hive.inbox.status(brain.id).awaitingReceipt, 0);
    assert.equal(hive.inbox.status(brain.id).acknowledgedMessages, 1);
    assert.equal((await call<{ duplicate: boolean }>(replacement, "ack_delivery", { deliveryId: replay.delivery!.id })).duplicate, true);

    hive.postMessage(human, { channel: dm.id, body: "Lost between receipt at MCP and confirmation by the host" });
    const unconfirmed = await call<WaitResult>(replacement, "wait");
    await replacement.close();
    const afterCrash = await connect(registered.token);
    const recovered = await call<WaitResult>(afterCrash, "wait");
    assert.equal(recovered.delivery!.id, unconfirmed.delivery!.id);
    await call(afterCrash, "ack_delivery", { deliveryId: recovered.delivery!.id });
    assert.equal(hive.inbox.status(brain.id).acknowledgedMessages, 2);
  } finally {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    await started.shutdown(); hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
