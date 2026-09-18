import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

function cursor(hive: Hive, agentId: string): number {
  return (hive.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agentId) as {
    inbox_cursor: number;
  }).inbox_cursor;
}

async function postJson(base: string, url: string, body: unknown, token: string) {
  const response = await fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

test("unacknowledged deliveries replay, session fencing blocks stale ack, and duplicate ack is idempotent", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-delivery-"));
  const dbPath = path.join(dir, "hive.db");
  const hive = new Hive(dbPath);
  t.after(() => {
    try {
      hive.db.close();
    } catch {
      // May already be closed for the restart fixture.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const human = hive.getAgent("human");
  const joined = hive.join({ role: "worker", seniority: "mid" });
  const worker = joined.agent;
  const dm = hive.openDm(human, worker.name);
  const firstMessage = hive.postMessage(human, { channel: dm.id, body: "first" });
  const secondMessage = hive.postMessage(human, { channel: dm.id, body: "second" });
  const acknowledgedBefore = cursor(hive, worker.id);

  const first = await hive.wait(worker, 60_000, undefined, { sessionId: "session-a" });
  assert.ok(first.deliveryId);
  assert.equal(first.deliverySessionId, "session-a");
  assert.deepEqual(
    first.messages.map((message) => message.id),
    [firstMessage.id, secondMessage.id],
  );
  assert.equal(cursor(hive, worker.id), acknowledgedBefore, "delivery alone must not advance the durable cursor");

  const retry = await hive.wait(worker, 60_000, undefined, { sessionId: "session-a" });
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.deepEqual(
    retry.messages.map((message) => message.id),
    first.messages.map((message) => message.id),
  );
  assert.equal(cursor(hive, worker.id), acknowledgedBefore);

  const replacement = await hive.wait(worker, 60_000, undefined, { sessionId: "session-b" });
  assert.ok(replacement.deliveryId);
  assert.notEqual(replacement.deliveryId, first.deliveryId);
  assert.deepEqual(
    replacement.messages.map((message) => message.id),
    first.messages.map((message) => message.id),
  );
  assert.throws(
    () => hive.ackDelivery(worker, first.deliveryId!, "session-a"),
    /superseded/,
  );
  assert.equal(cursor(hive, worker.id), acknowledgedBefore);

  const ack = hive.ackDelivery(worker, replacement.deliveryId!, "session-b");
  assert.equal(ack.duplicate, false);
  assert.ok(ack.cursor >= secondMessage.seq);
  const duplicate = hive.ackDelivery(worker, replacement.deliveryId!, "session-b");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.cursor, ack.cursor);

  const stateAfterAck = hive.deliveryStates()[worker.id]!;
  assert.equal(stateAfterAck.inFlight, null);
  assert.equal(stateAfterAck.lastAcknowledged?.deliveryId, replacement.deliveryId);

  const thirdMessage = hive.postMessage(human, { channel: dm.id, body: "survives restart" });
  const beforeRestart = await hive.wait(worker, 60_000, undefined, { sessionId: "session-b" });
  assert.ok(beforeRestart.deliveryId);
  assert.deepEqual(beforeRestart.messages.map((message) => message.id), [thirdMessage.id]);
  const cursorBeforeRestart = cursor(hive, worker.id);
  hive.db.close();

  const reopened = new Hive(dbPath);
  t.after(() => reopened.db.close());
  const resumed = reopened.agentByToken(joined.token);
  const afterRestart = await reopened.wait(resumed, 60_000, undefined, { sessionId: "session-c" });
  assert.ok(afterRestart.deliveryId);
  assert.notEqual(afterRestart.deliveryId, beforeRestart.deliveryId);
  assert.deepEqual(afterRestart.messages.map((message) => message.id), [thirdMessage.id]);
  assert.equal(cursor(reopened, resumed.id), cursorBeforeRestart);
  assert.throws(
    () => reopened.ackDelivery(resumed, beforeRestart.deliveryId!, "session-b"),
    /superseded/,
  );
  reopened.ackDelivery(resumed, afterRestart.deliveryId!, "session-c");
  assert.ok(cursor(reopened, resumed.id) >= thirdMessage.seq);
});

test("HTTP wait keeps a delivered-but-unacknowledged response in flight across reconnect", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-delivery-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const human = hive.getAgent("human");
  const joined = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(human, joined.agent.name);
  const sent = hive.postMessage(human, { channel: dm.id, body: "transport fixture" });
  const cursorBefore = cursor(hive, joined.agent.id);
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    const closed = new Promise<void>((resolve) => started.server.once("close", () => resolve()));
    started.shutdown();
    await closed;
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const delivered = await postJson(
    base,
    "/api/agent/wait",
    { timeoutMs: 1_000, sessionId: "http-a" },
    joined.token,
  );
  assert.equal(delivered.status, 200);
  const first = delivered.data as {
    deliveryId: string;
    deliverySessionId: string;
    messages: Array<{ id: string }>;
  };
  assert.equal(first.messages[0]?.id, sent.id);
  assert.equal(cursor(hive, joined.agent.id), cursorBefore);

  // Simulate a response that reached the transport but was never acknowledged.
  const replayed = await postJson(
    base,
    "/api/agent/wait",
    { timeoutMs: 1_000, sessionId: "http-b" },
    joined.token,
  );
  assert.equal(replayed.status, 200);
  const second = replayed.data as {
    deliveryId: string;
    messages: Array<{ id: string }>;
  };
  assert.equal(second.messages[0]?.id, sent.id);
  assert.notEqual(second.deliveryId, first.deliveryId);

  const staleAck = await postJson(
    base,
    "/api/agent/wait/ack",
    { deliveryId: first.deliveryId, sessionId: "http-a" },
    joined.token,
  );
  assert.equal(staleAck.status, 409);
  assert.equal(cursor(hive, joined.agent.id), cursorBefore);

  const ack = await postJson(
    base,
    "/api/agent/wait/ack",
    { deliveryId: second.deliveryId, sessionId: "http-b" },
    joined.token,
  );
  assert.equal(ack.status, 200);
  assert.equal((ack.data as { duplicate: boolean }).duplicate, false);
  const duplicate = await postJson(
    base,
    "/api/agent/wait/ack",
    { deliveryId: second.deliveryId, sessionId: "http-b" },
    joined.token,
  );
  assert.equal(duplicate.status, 200);
  assert.equal((duplicate.data as { duplicate: boolean }).duplicate, true);
  assert.ok(cursor(hive, joined.agent.id) >= sent.seq);
});
