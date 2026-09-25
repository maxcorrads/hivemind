import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hive } from "../server/hive.ts";
import { startServer } from "../server/serve.ts";
import { snapshotTables } from "../server/test-fixtures.ts";
import type { WaitResult } from "../shared/types.ts";
import { childEnv } from "../test-support/child-process.ts";

async function fixture(t: TestContext) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-restart-mcp-"));
  const database = path.join(dir, "hive.db");
  let hive = new Hive(database), server = startServer({ hive, port: 0, telegram: false });
  const port = await server.ready;
  const client = new Client({ name: "restart-fixture", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli.ts"), "mcp"], cwd: dir,
    env: childEnv({ PATH: process.env.PATH ?? "", HIVEMIND_HOME: path.join(dir, "client"), HIVEMIND_URL: `http://127.0.0.1:${port}` }), stderr: "pipe" });
  t.after(async () => {
    await client.close(); await transport.close(); await server.shutdown(); hive.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const raw = async (name: string, args: Record<string, unknown> = {}, signal = t.signal) =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal }));
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await raw(name, args); assert.notEqual(result.isError, true, JSON.stringify(result));
    const block = result.content.find(item => item.type === "text"); assert(block?.type === "text"); return JSON.parse(block.text) as T;
  };
  const joined = await call<{ name: string }>("join", { role: "worker", seniority: "mid", project: "acme" });
  const worker = hive.identity.getAgentByName(joined.name)!;
  const human = hive.identity.getAgent("human"), brain = hive.identity.join({ role: "brain" });
  const channel = hive.channels.openDm(human, worker.name);
  const taskChannel = hive.channels.openDm(brain.agent, worker.name);
  const task = hive.tasks.assign(brain.agent, { requestId: "fixture-task", channel: taskChannel.id, worker: worker.name,
    contract: { objective: "Inspect the fixture only", scope: ["Fixture"], nonGoals: ["External writes"],
      acceptanceCriteria: ["Report findings"], dependencies: [], evidenceSeqs: [] } });
  const assignment = await call<WaitResult>("wait"); assert(assignment.delivery);
  await call("ack_delivery", { deliveryId: assignment.delivery.id });
  const observeWait = () => {
    let admit!: () => void; const admitted = new Promise<void>(resolve => { admit = resolve; });
    const wait = hive.delivery.wait.bind(hive.delivery);
    t.mock.method(hive.delivery, "wait", (...args: Parameters<typeof wait>) => { const pending = wait(...args); admit(); return pending; });
    return admitted;
  };
  return {
    get hive() { return hive; }, client, raw, call, worker, channel, task: task.task, observeWait,
    async stop() { await server.shutdown(); hive.close(); },
    reopen() { hive = new Hive(database); },
    async start() { server = startServer({ hive, port, telegram: false }); await server.ready; },
    post(body: string) { return hive.messages.postMessage(hive.identity.getAgent("human"), { channel: channel.id, body }); },
  };
}

for (const queuedDuringDowntime of [false, true]) {
  test(`one real MCP wait survives a server/database restart (queued during downtime=${queuedDuringDowntime})`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const session = f.hive.inbox.currentSession(f.worker.id), tokenHash = f.hive.identity.sessionFingerprint(f.worker.id);
    const taskBefore = f.hive.tasks.get(f.worker, f.task.id);
    const receiptsBefore = f.hive.inbox.status(f.worker.id).acknowledgedMessages;
    const admission = f.observeWait();
    let settled = false;
    const pending = f.raw("wait").then(result => { settled = true; return result; });
    await admission;
    await f.stop();
    f.reopen();
    let message = queuedDuringDowntime ? f.post("Mail queued during the isolated maintenance") : undefined;
    const nextAdmission = f.observeWait(); await f.start();
    const first = await Promise.race([nextAdmission.then(() => "reconnected"), pending.then(() => "returned")]);
    assert.equal(first, "reconnected", "shutdown must not return a fatal tool result to the host");
    if (!message) {
      assert.equal(settled, false, "no mail means no host/model wake");
      message = f.post("Mail after reconnect");
    }
    const result = await pending; assert.notEqual(result.isError, true, JSON.stringify(result));
    const block = result.content.find(item => item.type === "text"); assert(block?.type === "text");
    const delivery = (JSON.parse(block.text) as WaitResult).delivery!;
    assert(delivery.messageSeqs.includes(message.seq));
    assert.equal(f.hive.inbox.currentSession(f.worker.id), session, "no new inbox session");
    assert.equal(f.hive.identity.sessionFingerprint(f.worker.id), tokenHash, "no rejoin or token rotation");
    assert.equal(f.hive.inbox.status(f.worker.id).awaitingReceipt, 1);
    assert.equal(f.hive.inbox.status(f.worker.id).acknowledgedMessages, receiptsBefore, "no automatic ACK");
    assert.deepEqual(f.hive.tasks.get(f.worker, f.task.id), taskBefore, "no task replay or state change");
    await f.call("ack_delivery", { deliveryId: delivery.id });
    assert.equal(f.hive.inbox.status(f.worker.id).awaitingReceipt, 0);
    assert.equal(f.hive.inbox.status(f.worker.id).acknowledgedMessages, receiptsBefore + 1);
  });
}

test("unacknowledged mail retains its delivery ID across restart and does not absorb later mail", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const first = f.post("Keep this delivery unacknowledged");
  const offered = await f.call<WaitResult>("wait"); assert(offered.delivery);
  const session = f.hive.inbox.currentSession(f.worker.id), tokenHash = f.hive.identity.sessionFingerprint(f.worker.id);
  const before = snapshotTables(f.hive, ["task_records", "task_events"]);
  const receipts = f.hive.inbox.status(f.worker.id).acknowledgedMessages;
  await f.stop(); f.reopen(); const later = f.post("Do not fold this into the original delivery"); await f.start();
  const redelivery = await f.call<WaitResult>("wait"); assert(redelivery.delivery);
  assert.equal(redelivery.delivery.id, offered.delivery.id);
  assert.deepEqual(redelivery.delivery.messageSeqs, [first.seq]);
  assert.equal(f.hive.inbox.status(f.worker.id).acknowledgedMessages, receipts);
  assert.equal(f.hive.inbox.currentSession(f.worker.id), session);
  assert.equal(f.hive.identity.sessionFingerprint(f.worker.id), tokenHash);
  assert.deepEqual(snapshotTables(f.hive, Object.keys(before)), before);
  await f.call("ack_delivery", { deliveryId: redelivery.delivery.id });
  const next = await f.call<WaitResult>("wait"); assert(next.delivery);
  assert.notEqual(next.delivery.id, offered.delivery.id); assert.deepEqual(next.delivery.messageSeqs, [later.seq]);
  await f.call("ack_delivery", { deliveryId: next.delivery.id });
  assert.equal(f.hive.inbox.status(f.worker.id).acknowledgedMessages, receipts + 2);
});

test("a real identity replacement during downtime stays fatal and never triggers an automatic rejoin", { timeout: 20_000 }, async t => {
  const f = await fixture(t), admission = f.observeWait();
  const pending = f.raw("wait"); await admission;
  await f.stop(); f.reopen();
  const replacement = f.hive.identity.join({ role: "worker", resumeName: f.worker.name });
  const tokenHash = f.hive.identity.sessionFingerprint(f.worker.id);
  await f.start();
  const result = await pending; assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Invalid token/);
  assert.equal(f.hive.identity.sessionFingerprint(f.worker.id), tokenHash, "old client must not take over the replacement");
  assert.equal(f.hive.identity.agentByToken(replacement.token).id, f.worker.id);
});

test("host cancellation during downtime remains cancelled and leaves queued mail unacknowledged", { timeout: 20_000 }, async t => {
  const f = await fixture(t), admission = f.observeWait(), controller = new AbortController();
  const pending = f.raw("wait", {}, controller.signal);
  const cancelled = assert.rejects(pending, /cancelled by host/);
  await admission; await f.stop(); controller.abort(new Error("cancelled by host")); await cancelled;
  // A protocol round trip fences the cancellation notification in the unchanged MCP process.
  await f.client.ping();
  f.reopen(); const message = f.post("Still unread after host cancellation");
  const receipts = f.hive.inbox.status(f.worker.id).acknowledgedMessages;
  await f.start(); await f.call("whoami");
  assert.equal(f.hive.inbox.status(f.worker.id).acknowledgedMessages, receipts);
  const next = await f.call<WaitResult>("wait"); assert(next.delivery);
  assert.deepEqual(next.delivery.messageSeqs, [message.seq]);
  assert.equal(f.hive.inbox.status(f.worker.id).awaitingReceipt, 1);
  await f.call("ack_delivery", { deliveryId: next.delivery.id });
});
