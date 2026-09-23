import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { getRequestListener } from "@hono/node-server";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { INBOX_BATCH_MAX, InboxDeliveryStore } from "./inbox-delivery.ts";
import { waitUntilMail } from "../mcp/wait-loop.ts";
import { backdate, countRows, inboxCursor } from "./test-fixtures.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-receipt-"));
  const file = path.join(dir, "hive.db");
  const hive = new Hive(file);
  t.after(() => { try { hive.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const sessionId = hive.openInboxSession(worker.agent, crypto.randomUUID());
  const send = (body: string) => hive.postMessage(brain.agent, { channel: dm.id, body });
  const wait = () => hive.wait(worker.agent, 2, undefined, { sessionId, compact: true });
  const cursor = () => inboxCursor(hive, worker.agent.id);
  return { dir, file, hive, brain, worker, sessionId, send, wait, cursor };
}

test("receipt preserves the cursor and exact batch until an idempotent ACK; newer mail stays queued", async t => {
  const f = fixture(t); const message = f.send("invented assignment"); const before = f.cursor();
  assert.equal(f.hive.queuedCounts()[f.worker.agent.id], 1);
  const first = (await f.wait()).delivery!;
  assert.equal(f.cursor(), before);
  assert.deepEqual(first.messageSeqs, [message.seq]);
  assert.equal(f.hive.inboxStatuses()[f.worker.agent.id].awaitingReceipt, 1);
  assert.equal(f.hive.queuedCounts()[f.worker.agent.id], 0);
  f.send("new assignment");
  const replay = (await f.wait()).delivery!;
  assert.equal(replay.id, first.id); assert.equal(replay.redelivered, true);
  assert.deepEqual(replay.messageSeqs, first.messageSeqs);
  assert.equal(f.hive.queuedCounts()[f.worker.agent.id], 1);
  const ack = f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id);
  assert.equal(ack.duplicate, false); assert.equal(f.cursor(), message.seq);
  assert.equal(f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id).duplicate, true);
  assert.deepEqual(f.hive.inbox.status(f.worker.agent.id), { awaitingReceipt: 0, acknowledgedMessages: 1, lastAcknowledgedAt: ack.acknowledgedAt });
  const second = (await f.wait()).delivery!; assert.notEqual(second.id, first.id);
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, second.id);
  const advanced = f.cursor();
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id);
  assert.equal(f.cursor(), advanced); assert.equal((await f.wait()).idle, true);
});

test("session takeover fences old waits, acknowledgements and delayed session-open retries", async t => {
  const f = fixture(t); f.send("only one pending batch"); const first = (await f.wait()).delivery!;
  const replacement = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  assert.throws(() => f.hive.openInboxSession(f.worker.agent, f.sessionId), /superseded/);
  await assert.rejects(f.wait(), /superseded/);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id), /superseded/);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, replacement, first.id), /older session/);
  const replay = await f.hive.wait(f.worker.agent, 1, undefined, { sessionId: replacement });
  assert.equal(replay.delivery!.id, first.id);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id), /superseded/);
  f.hive.acknowledgeInbox(f.worker.agent, replacement, first.id);
  assert.equal(f.hive.openInboxSession(f.worker.agent, replacement), replacement);
});

test("pending delivery survives restart and expiry without becoming accepted or completed work", async t => {
  const f = fixture(t); f.send("survive restart"); const first = (await f.wait()).delivery!;
  backdate(f.hive, "inbox_deliveries", "lease_until", { id: first.id });
  f.hive.db.close();
  const restarted = new Hive(f.file); t.after(() => restarted.db.close());
  assert.equal(restarted.inbox.status(f.worker.agent.id).awaitingReceipt, 1);
  const session = restarted.openInboxSession(f.worker.agent, crypto.randomUUID());
  const replay = (await restarted.wait(f.worker.agent, 1, undefined, { sessionId: session })).delivery!;
  assert.equal(replay.id, first.id); assert.deepEqual(replay.messageSeqs, first.messageSeqs);
  assert.ok(replay.leaseExpiresAt > Date.now());
  restarted.acknowledgeInbox(f.worker.agent, session, replay.id);
  assert.equal(countRows(restarted, "threads"), 0);
});

test("pre-aborted waits never reserve mail; a replacement session terminates an old sleeping wait", async t => {
  const f = fixture(t); const ac = new AbortController(); ac.abort(); f.send("do not consume");
  const idle = await f.hive.wait(f.worker.agent, 1, ac.signal, { sessionId: f.sessionId });
  assert.equal(idle.idle, true); assert.equal(f.hive.inbox.pending(f.worker.agent.id), undefined);
  const received = (await f.wait()).delivery!;
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, received.id);
  const sleeping = f.hive.wait(f.worker.agent, 10_000, undefined, { sessionId: f.sessionId });
  const rejected = assert.rejects(sleeping, /superseded/);
  f.hive.openInboxSession(f.worker.agent, crypto.randomUUID()); await rejected;
});

test("receipts cannot acknowledge another identity's batch and batches have a fixed maximum", async t => {
  const f = fixture(t); f.send("not for the brain"); const d = (await f.wait()).delivery!;
  const bs = f.hive.openInboxSession(f.brain.agent, crypto.randomUUID());
  assert.throws(() => f.hive.acknowledgeInbox(f.brain.agent, bs, d.id), /not found/);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, crypto.randomUUID()), /not found/);
  const dm = f.hive.openDm(f.brain.agent, f.worker.agent.name);
  for (let n = 0; n < INBOX_BATCH_MAX + 5; n++) f.hive.postMessage(f.worker.agent, { channel: dm.id, body: `event ${n}` });
  const batch = await f.hive.wait(f.brain.agent, 1, undefined, { sessionId: bs });
  assert.equal(batch.delivery!.messageSeqs.length, INBOX_BATCH_MAX);
  assert.ok((batch.more ?? 0) > 0);
  f.hive.acknowledgeInbox(f.brain.agent, bs, batch.delivery!.id);
  const rest = await f.hive.wait(f.brain.agent, 1, undefined, { sessionId: bs });
  assert.equal(rest.delivery!.messageSeqs.length, 5);
});

test("pre-receipt MCP clients stop on protocol upgrade and leave queued mail recoverable", async t => {
  const f = fixture(t); const app = createApp(f.hive);
  const message = f.send("mail retained across client upgrade"); const before = f.cursor();
  let calls = 0; let retryDelays = 0;
  // Freeze the v2 classifier: an updated client helper alone cannot fix a running old MCP.
  const legacyFatal = /join first|no token|HTTP 401|HTTP 403|HTTP 404|HTTP 409|superseded/i;
  await assert.rejects(waitUntilMail(async () => {
    calls++;
    const response = await app.request("/api/agent/wait", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.worker.token}` },
      body: JSON.stringify({ timeoutMs: 1, compact: true }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: string };
    // The v2 HTTP client forwards JSON's error string without the response status.
    const error = new Error(body.error || `HTTP ${response.status}`);
    assert.equal(legacyFatal.test(error.message), true, "The old client would retry this error indefinitely");
    throw error;
  }, { maxTransientErrors: 3, delay: async () => { retryDelays++; } }), /HTTP 409:.*Restart the Hivemind MCP client and rejoin/);
  assert.equal(calls, 1); assert.equal(retryDelays, 0);
  assert.equal(f.cursor(), before);
  assert.equal(f.hive.inbox.pending(f.worker.agent.id), undefined);
  assert.equal(f.hive.queuedCounts()[f.worker.agent.id], 1);
  const recovered = (await f.wait()).delivery!;
  assert.deepEqual(recovered.messageSeqs, [message.seq]);
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, recovered.id);
  assert.equal(f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages, 1);
});

test("HTTP dropped response and received-but-unacknowledged response both replay; UI reports each stage", async t => {
  const f = fixture(t); const app = createApp(f.hive); const listener = getRequestListener(app.fetch);
  let drop = false;
  let dropAck = false;
  const server = createServer((req, res) => {
    if ((drop && req.url === "/api/agent/wait") || (dropAck && req.url === "/api/agent/inbox/ack")) {
      drop = false;
      dropAck = false;
      // Lose all response bytes after the server has durably prepared the delivery.
      res.write = (() => true) as typeof res.write;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    listener(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${f.worker.token}` }, body: JSON.stringify(body) });
  f.send("HTTP receipt fixture"); const before = f.cursor(); drop = true;
  await assert.rejects(request("/api/agent/wait", { timeoutMs: 1, sessionId: f.sessionId }));
  assert.equal(f.cursor(), before);
  const pending = f.hive.inbox.pending(f.worker.agent.id)!; assert.ok(pending);
  const response = await request("/api/agent/wait", { timeoutMs: 1, sessionId: f.sessionId });
  const body = await response.json() as any;
  assert.equal(body.delivery.id, pending.id); assert.equal(f.cursor(), before);
  const snap = await (await fetch(base + "/api/ui/snapshot")).json() as any;
  assert.equal(snap.queued[f.worker.agent.id], 0);
  assert.equal(snap.inbox[f.worker.agent.id].awaitingReceipt, 1);
  assert.equal(snap.inbox[f.worker.agent.id].acknowledgedMessages, 0);
  assert.equal((await request("/api/agent/wait", { timeoutMs: 1 })).status, 409);
  assert.equal((await request("/api/agent/wait", { sessionId: 123 })).status, 400);
  for (const endpoint of ["/wait", "/inbox/session", "/inbox/ack"]) {
    assert.equal((await request("/api/agent" + endpoint, null)).status, 400);
  }
  dropAck = true;
  await assert.rejects(request("/api/agent/inbox/ack", { sessionId: f.sessionId, deliveryId: pending.id }));
  // The lost ACK response does not roll back the receipt; retry is still safe.
  assert.ok(f.cursor() > before);
  const ack = await request("/api/agent/inbox/ack", { sessionId: f.sessionId, deliveryId: pending.id });
  assert.equal(ack.status, 200); assert.ok(f.cursor() > before);
  assert.equal((await ack.json() as any).duplicate, true);
  assert.equal((await (await request("/api/agent/inbox/ack", { sessionId: f.sessionId, deliveryId: pending.id })).json() as any).duplicate, true);
});

function historicalReceipt(db: DatabaseSync, agentId: string, sessionId: string, seqs: number[], at: number | null) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO inbox_deliveries
    (id, agent_id, session_id, through_seq, seqs, attempts, offered_at, lease_until, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, 2, ?)`)
    .run(id, agentId, sessionId, seqs.at(-1)!, JSON.stringify(seqs), at);
  return id;
}

test("receipt totals backfill once, survive restart and preserve old duplicate ACKs and empty identities", t => {
  const f = fixture(t), db = f.hive.db;
  // Removing only the derived table models the pre-counter schema, retaining the ledger.
  db.exec("DROP TABLE IF EXISTS inbox_receipt_totals");
  const old = historicalReceipt(db, f.worker.agent.id, f.sessionId, [10, 11], 100);
  historicalReceipt(db, f.worker.agent.id, f.sessionId, [12], 300);
  historicalReceipt(db, f.brain.agent.id, crypto.randomUUID(), [20, 21, 22], 200);
  historicalReceipt(db, f.worker.agent.id, f.sessionId, [13, 14], null);
  let parsed = 0;
  db.function("json_array_length", value => { parsed++; return (JSON.parse(String(value)) as unknown[]).length; });
  const migrated = new InboxDeliveryStore(db);
  assert.equal(parsed, 3, "only confirmed legacy batches are backfilled");
  assert.deepEqual(migrated.status(f.worker.agent.id), { awaitingReceipt: 2, acknowledgedMessages: 3, lastAcknowledgedAt: 300 });
  assert.equal(migrated.status(f.brain.agent.id).acknowledgedMessages, 3);
  assert.equal(migrated.status("human").acknowledgedMessages, 0);
  assert.equal(migrated.acknowledge(f.worker.agent.id, f.sessionId, old).duplicate, true);
  assert.equal(migrated.status(f.worker.agent.id).acknowledgedMessages, 3);
  assert.equal(parsed, 3, "status and duplicate ACK must not aggregate history");
  db.close();
  const reopened = new DatabaseSync(f.file); t.after(() => reopened.close());
  reopened.exec("PRAGMA foreign_keys = ON");
  reopened.function("json_array_length", () => { throw new Error("backfill repeated"); });
  const restarted = new InboxDeliveryStore(reopened);
  assert.deepEqual(restarted.status(f.worker.agent.id), { awaitingReceipt: 2, acknowledgedMessages: 3, lastAcknowledgedAt: 300 });
  assert.equal(restarted.acknowledge(f.worker.agent.id, f.sessionId, old).duplicate, true);
  const pending = restarted.pending(f.worker.agent.id)!;
  restarted.acknowledge(f.worker.agent.id, f.sessionId, pending.id);
  assert.equal(restarted.status(f.worker.agent.id).acknowledgedMessages, 5);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM inbox_deliveries").get()!.n, 4);
  reopened.prepare("DELETE FROM agents WHERE id = ?").run(f.worker.agent.id);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM inbox_receipt_totals WHERE agent_id = ?").get(f.worker.agent.id)!.n, 0);
  assert.equal(restarted.status(f.brain.agent.id).acknowledgedMessages, 3);
});

test("failed receipt backfill rolls back its marker and totals so a restart can retry", t => {
  const f = fixture(t), db = f.hive.db;
  db.exec("DROP TABLE IF EXISTS inbox_receipt_totals");
  historicalReceipt(db, f.worker.agent.id, f.sessionId, [1, 2], 100);
  historicalReceipt(db, f.brain.agent.id, crypto.randomUUID(), [3], 200);
  let parsed = 0;
  db.function("json_array_length", value => {
    // Return an invalid aggregate value to provoke a real SQL constraint error.
    // Node 22.13 does not reliably rethrow JS exceptions from SQLite functions.
    if (++parsed === 2) return null;
    return (JSON.parse(String(value)) as unknown[]).length;
  });
  assert.throws(() => new InboxDeliveryStore(db));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox_receipt_totals'").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbox_deliveries").get()!.n, 2);
  db.function("json_array_length", value => (JSON.parse(String(value)) as unknown[]).length);
  const retried = new InboxDeliveryStore(db);
  assert.equal(retried.status(f.worker.agent.id).acknowledgedMessages, 2);
  assert.equal(retried.status(f.brain.agent.id).acknowledgedMessages, 1);
});

test("counter failures roll back receipt and cursor; retries count once and last ACK tolerates clock rollback", async t => {
  const f = fixture(t), db = f.hive.db;
  f.send("first confirmed message");
  const first = (await f.wait()).delivery!, before = f.cursor();
  db.exec(`CREATE TEMP TRIGGER reject_counter_insert BEFORE INSERT ON inbox_receipt_totals
    BEGIN SELECT RAISE(ABORT, 'injected counter failure'); END`);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id), /injected counter failure/);
  assert.equal(f.cursor(), before);
  assert.equal(f.hive.inbox.pending(f.worker.agent.id)!.id, first.id);
  assert.deepEqual(f.hive.inbox.status(f.worker.agent.id), { awaitingReceipt: 1, acknowledgedMessages: 0, lastAcknowledgedAt: null });
  db.exec("DROP TRIGGER reject_counter_insert");
  const now = t.mock.method(Date, "now", () => 2000);
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id);
  f.send("second confirmed message");
  const second = (await f.wait()).delivery!, previousCursor = f.cursor();
  db.exec(`CREATE TEMP TRIGGER reject_counter_update BEFORE UPDATE ON inbox_receipt_totals
    BEGIN SELECT RAISE(ABORT, 'injected counter update failure'); END`);
  assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, second.id), /injected counter update failure/);
  assert.equal(f.cursor(), previousCursor);
  assert.equal(f.hive.inbox.pending(f.worker.agent.id)!.id, second.id);
  assert.equal(f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages, 1);
  db.exec("DROP TRIGGER reject_counter_update");
  now.mock.mockImplementation(() => 1000);
  const ack = f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, second.id);
  assert.equal(ack.acknowledgedAt, 1000);
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id);
  f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, second.id);
  assert.deepEqual(f.hive.inbox.status(f.worker.agent.id), { awaitingReceipt: 0, acknowledgedMessages: 2, lastAcknowledgedAt: 2000 });
});

for (const historySize of [1_000, 10_000, 100_000]) {
  test(`full send/wait/ACK/status path does not aggregate ${historySize} retained receipts`, async t => {
    const f = fixture(t), db = f.hive.db;
    const past = f.send("fixed historical body");
    const first = (await f.wait()).delivery!;
    f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, first.id);
    // Synthetic retained ledger: repeat a historical reference to grow only receipt
    // history, leaving message history and the active inbox identical at every size.
    db.exec("DROP TABLE IF EXISTS inbox_receipt_totals");
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO inbox_deliveries(id, agent_id, session_id, through_seq, seqs, attempts, offered_at, lease_until, acknowledged_at)
      SELECT 'history-' || i, ?, ?, ?, ?, 1, 1, 2, 100 FROM n`)
      .run(historySize, f.worker.agent.id, f.sessionId, past.seq, JSON.stringify([past.seq]));
    new InboxDeliveryStore(db);
    let parsed = 0;
    db.function("json_array_length", value => { parsed++; return (JSON.parse(String(value)) as unknown[]).length; });
    const queries: string[] = [];
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
    assert.equal((await f.wait()).idle, true);
    f.hive.inboxStatuses();
    const current = f.send("one active message independent of ledger size");
    const offered = (await f.wait()).delivery!;
    assert.deepEqual(offered.messageSeqs, [current.seq]);
    assert.equal((await f.wait()).delivery!.id, offered.id);
    f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, offered.id);
    f.hive.acknowledgeInbox(f.worker.agent, f.sessionId, offered.id);
    const status = f.hive.inboxStatuses()[f.worker.agent.id];
    assert.equal(status.acknowledgedMessages, historySize + 2);
    assert.equal(status.awaitingReceipt, 0);
    assert.equal((await f.wait()).idle, true);
    assert.equal(parsed, 0, "no JSON aggregation of historical receipts in the complete path");
    const ledgerReads = queries.filter(sql => /^\s*SELECT\b/i.test(sql) && /\bFROM inbox_deliveries\b/i.test(sql));
    assert.ok(ledgerReads.length > 0);
    for (const sql of ledgerReads) {
      assert.match(sql, /acknowledged_at IS NULL|\bid = \?/, "ledger reads must select one pending batch or one receipt ID");
      assert.doesNotMatch(sql, /\b(SUM|COUNT|MAX)\s*\(/i);
    }
    assert.equal(prepare("SELECT COUNT(*) AS n FROM inbox_deliveries").get()!.n, historySize + 2);
  });
}
