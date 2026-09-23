import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Hive } from "./hive.ts";
import { backdate, countRows, failWrites, insertRows, readValue } from "./test-fixtures.ts";
import { createApp } from "./app.ts";
import { SEND_KEYS_PER_ACTOR } from "../shared/mutation.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-idempotency-"));
  const file = path.join(dir, "hive.db");
  const hive = new Hive(file), human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  t.after(() => { try { hive.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { hive, file, human, brain, worker, dm };
}

test("send keys bind exact payloads atomically and replay attachments after restart", async t => {
  const f = fixture(t), input = { channel: f.dm.id, body: "one assignment", requestId: "stable-send" };
  const attachment = await f.hive.createFileFromBytes(f.brain.agent, { name: "proof.txt", mime: "text/plain", bytes: new TextEncoder().encode("fixture") });
  const payload = { ...input, attachmentIds: [attachment.id] };
  const messages: string[] = [], queues: unknown[] = [];
  f.hive.bus.on("message", message => messages.push(message.id));
  f.hive.bus.on("queued", value => queues.push(value));
  const original = f.hive.postMessage(f.brain.agent, payload);
  assert.equal(f.hive.postMessage(f.brain.agent, payload).id, original.id);
  assert.equal(queues.length, 1); assert.deepEqual(messages, [original.id]);
  for (const patch of [{ body: "changed" }, { attachmentIds: [] }, { eventType: "blocker" as const }, { recipients: [f.worker.agent.name] }])
    assert.throws(() => f.hive.postMessage(f.brain.agent, { ...payload, ...patch }), /already used/);
  for (const requestId of ["", "../escape", "x".repeat(101)])
    assert.throws(() => f.hive.postMessage(f.brain.agent, { ...input, requestId }), /Invalid requestId/);
  assert.equal(countRows(f.hive, "send_requests"), 1);
  f.hive.db.close();
  const restart = new Hive(f.file); t.after(() => restart.db.close());
  const replay = restart.postMessage(f.brain.agent, payload);
  assert.equal(replay.id, original.id); assert.equal(replay.seq, original.seq);
  assert.equal(readValue(restart, "attachments", "message_id", { id: attachment.id }), original.id);
});

test("a journal insert failure rolls back message/bindings/events and leaves the key reusable", async t => {
  const f = fixture(t), attachment = await f.hive.createFileFromBytes(f.brain.agent,
    { name: "rollback.txt", mime: "text/plain", bytes: new TextEncoder().encode("rollback") });
  const input = { channel: f.dm.id, body: "atomic", requestId: "rollback", attachmentIds: [attachment.id] };
  let events = 0; f.hive.bus.on("message", () => events++);
  const restoreLedger = failWrites(f.hive, "send_requests", { message: "ledger failure", persistent: true });
  const count = countRows(f.hive, "messages");
  assert.throws(() => f.hive.postMessage(f.brain.agent, input), /ledger failure/);
  assert.equal(countRows(f.hive, "messages"), count);
  assert.equal(readValue(f.hive, "attachments", "message_id", { id: attachment.id }), null);
  assert.equal(events, 0);
  restoreLedger();
  f.hive.postMessage(f.brain.agent, input);
  assert.equal(events, 1);
});

test("HTTP lost response and concurrent duplicate sends preserve one message and notification", { timeout: 15_000 }, async t => {
  const f = fixture(t), listener = getRequestListener(createApp(f.hive).fetch);
  let drop = true;
  const server = createServer((req, res) => {
    if (drop && req.url?.endsWith("/messages") && req.method === "POST") {
      drop = false; res.write = (() => true) as typeof res.write;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    listener(req, res);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/channels/${f.dm.id}/messages`;
  const input = { body: "lost response", requestId: "network-retry" };
  const request = (body: unknown, token = f.brain.token) => fetch(url,
    { method: "POST", signal: t.signal, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const events: string[] = []; f.hive.bus.on("message", message => events.push(message.id));
  await assert.rejects(request(input));
  const replies = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await request(input); assert.equal(response.status, 200);
    return response.json() as Promise<{ id: string; seq: number }>;
  }));
  assert.equal(new Set(replies.map(reply => reply.id)).size, 1);
  assert.equal(new Set(replies.map(reply => reply.seq)).size, 1);
  assert.deepEqual(events, [replies[0]!.id]);
  const conflict = await request({ ...input, body: "changed" }); assert.equal(conflict.status, 409); await conflict.body?.cancel();
  // Same key by another permitted actor is independent, not an oracle for the first actor's result.
  const other = await request(input, f.worker.token); assert.equal(other.status, 200);
  assert.notEqual((await other.json() as { id: string }).id, replies[0]!.id);
});

test("keys remain project scoped, cannot bypass visibility and do not evict unexpired guarantees", t => {
  const f = fixture(t), input = { channel: f.dm.id, body: "quota", requestId: "first" };
  const original = f.hive.postMessage(f.brain.agent, input);
  const other = f.hive.createProject(f.human, { name: "Other", slug: "other" });
  const foreign = f.hive.join({ role: "brain", project: other.slug });
  assert.throws(() => f.hive.postMessage(foreign.agent, input), /cannot|not found/i);
  const one = f.hive.postMessage(f.human, { channel: "general", body: "A", requestId: "human-key" });
  const two = f.hive.postMessage(f.human, { channel: f.hive.getChannel("general", other.id).id, body: "B", requestId: "human-key" });
  assert.notEqual(one.id, two.id);
  insertRows(f.hive, "send_requests", Array.from({ length: SEND_KEYS_PER_ACTOR - 1 }, (_, i) => ({
    actor_id: f.brain.agent.id, project_id: f.brain.agent.projectId!, request_id: `quota-${i + 1}`,
    payload_hash: "hash", message_id: original.id, expires_at: Date.now() + 100000,
  })));
  assert.throws(() => f.hive.postMessage(f.brain.agent, { ...input, requestId: "over-cap" }), /full/);
  assert.equal(f.hive.postMessage(f.brain.agent, input).id, original.id, "old key remains replayable at capacity");
  backdate(f.hive, "send_requests", "expires_at", { actor_id: f.brain.agent.id });
  const afterWindow = f.hive.postMessage(f.brain.agent, input);
  assert.notEqual(afterWindow.id, original.id, "the documented 24-hour promise does not extend indefinitely");
  assert.ok(countRows(f.hive, "send_requests", { actor_id: f.brain.agent.id }) < SEND_KEYS_PER_ACTOR);
});

test("desired-state reactions are retry safe, transactional and permission checked", t => {
  const f = fixture(t), message = f.hive.postMessage(f.brain.agent, { channel: f.dm.id, body: "react" });
  let events = 0; f.hive.bus.on("reaction", () => events++);
  assert.equal(f.hive.setReaction(f.worker.agent, message.seq, "👍", true).added, true);
  assert.equal(f.hive.setReaction(f.worker.agent, message.seq, "👍", true).added, true);
  assert.equal(events, 1);
  assert.equal(f.hive.setReaction(f.worker.agent, message.seq, "👍", false).added, false);
  assert.equal(f.hive.setReaction(f.worker.agent, message.seq, "👍", false).added, false);
  assert.equal(events, 2);
  assert.equal(f.hive.toggleReaction(f.worker.agent, message.seq, "👍").added, true);
  assert.equal(f.hive.toggleReaction(f.worker.agent, message.seq, "👍").added, false);
  assert.throws(() => f.hive.setReaction(f.worker.agent, 1.5, "👍", true), /Invalid/);
  assert.throws(() => f.hive.setReaction(f.worker.agent, message.seq, "bogus", true), /Invalid/);
  assert.throws(() => f.hive.setReaction(f.worker.agent, message.seq, "👍", "true" as unknown as boolean), /Invalid/);
  const foreign = f.hive.join({ role: "brain" }).agent;
  assert.throws(() => f.hive.setReaction(foreign, message.seq, "👍", true), /Cannot/);
});
