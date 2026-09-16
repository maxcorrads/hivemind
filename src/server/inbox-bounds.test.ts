import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "./hive.ts";
import { INBOX_BATCH_MAX } from "./inbox-delivery.ts";
import { waitWireBytes } from "./wait-format.ts";
import { waitUntilMail } from "../mcp/wait-loop.ts";
import { BODY_MAX, WAIT_MAIL_CAP, WAIT_MAX_BYTES, WAIT_SCAN_MAX, WAIT_NEXT, type WaitResult } from "../shared/types.ts";

function fixture(t: TestContext, role: "brain" | "worker" = "brain") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-bounds-"));
  const file = path.join(dir, "hive.db");
  const hive = new Hive(file);
  t.after(() => { try { hive.db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const reader = hive.join(role === "brain" ? { role } : { role, seniority: "mid" });
  const writer = hive.join({ role: "brain" });
  const dm = hive.openDm(writer.agent, reader.agent.name);
  hive.db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages) WHERE id = ?").run(reader.agent.id);
  const sessionId = hive.openInboxSession(reader.agent, crypto.randomUUID());
  const bulk = (n: number, body = "ordinary", channel = dm.id, kind = "chat", mentions: string[] = []) => {
    const insert = hive.db.prepare(`INSERT INTO messages(id, channel_id, author_id, body, kind, control, mentions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const seqs: number[] = [];
    hive.db.exec("BEGIN");
    for (let i = 0; i < n; i++) seqs.push(Number(insert.run(crypto.randomUUID(), channel, writer.agent.id, body,
      kind, kind === "control" ? "clear_context" : null, JSON.stringify(mentions), Date.now()).lastInsertRowid));
    hive.db.exec("COMMIT");
    return seqs;
  };
  const wait = (compact = true) => hive.wait(reader.agent, 1, undefined, { sessionId, compact });
  const ack = (result: WaitResult) => hive.acknowledgeInbox(reader.agent, sessionId, result.delivery!.id);
  return { dir, file, hive, reader, writer, dm, sessionId, bulk, wait, ack };
}

function bounded(result: WaitResult, messageCap = INBOX_BATCH_MAX) {
  assert.ok(result.page!.scannedRows <= WAIT_SCAN_MAX);
  assert.ok(result.page!.hydratedMessages <= messageCap + 3);
  assert.ok((result.delivery?.messageSeqs.length ?? 0) <= messageCap);
  assert.ok(waitWireBytes(result) <= WAIT_MAX_BYTES);
  // Independently serialize the real MCP/CLI shapes, including escaping and UTF-8.
  const mcp = { content: [{ type: "text", text: JSON.stringify({ instruction: WAIT_NEXT, ...result }, null, 2) }] };
  assert.ok(Buffer.byteLength(JSON.stringify(mcp)) <= WAIT_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...result, sessionId: crypto.randomUUID() }, null, 2)) <= WAIT_MAX_BYTES);
}

/** Count actual header rows returned by SQLite, independently of page telemetry. */
function observeScans(hive: Hive) {
  const prepare = hive.db.prepare;
  const rows: number[] = [];
  hive.db.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes("WITH scanned AS MATERIALIZED")) {
      const all = statement.all.bind(statement);
      statement.all = ((...params: any[]) => {
        const result = all(...params);
        rows.push(result.length);
        return result;
      }) as typeof statement.all;
    }
    return statement;
  };
  return { rows, restore: () => { hive.db.prepare = prepare; } };
}

for (const role of ["brain", "worker"] as const) test(`${role} compact mail preserves channel identity across label clipping and replay`, async t => {
  const f = fixture(t, role);
  const channels = [199, 200, 201, 210, 10_000].map(length => f.hive.createChannel(f.writer.agent, {
    name: "a".repeat(length), type: "private", memberNames: [f.reader.agent.name],
  }));
  f.hive.db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages) WHERE id = ?").run(f.reader.agent.id);
  for (const channel of channels) {
    const sent = f.hive.postMessage(f.writer.agent, { channel: channel.id, body: "Reply in this channel." });
    const compact = await f.wait(); bounded(compact, role === "worker" ? WAIT_MAIL_CAP : INBOX_BATCH_MAX);
    const item = compact.mail![0];
    assert.equal(item.channelId, channel.id);
    assert.equal(item.ch, `#${channel.name.slice(0, 200)}${channel.name.length > 200 ? "…" : ""}`);
    assert.equal(item.body, sent.body);
    const raw = await f.wait(false); bounded(raw);
    assert.equal(raw.delivery!.id, compact.delivery!.id);
    assert.equal(raw.messages[0].channelId, item.channelId);
    const replay = await f.wait(); bounded(replay);
    assert.equal(replay.delivery!.id, compact.delivery!.id);
    assert.deepEqual(replay.mail, compact.mail);
    const history = f.hive.listMessages(f.reader.agent, item.channelId).messages;
    assert.ok(history.some(message => message.seq === sent.seq));
    f.ack(replay);
    const reply = f.hive.postMessage(f.reader.agent, { channel: item.channelId, body: "Received." });
    assert.equal(reply.channelId, channel.id);
  }
});

test("compact digests retain distinct channel IDs when abbreviated labels coincide", async t => {
  const f = fixture(t);
  const worker = f.hive.join({ role: "worker", seniority: "mid" });
  const prefix = "a".repeat(200);
  const channels = [prefix, `${prefix}-one`, `${prefix}-two`].map(name => f.hive.createChannel(f.writer.agent, {
    name, type: "private", memberNames: [f.reader.agent.name, worker.agent.name],
  }));
  f.hive.db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages) WHERE id = ?").run(f.reader.agent.id);
  const expected = new Map<string, number[]>();
  for (const channel of channels) expected.set(channel.id, [0, 1].map(i =>
    f.hive.postMessage(worker.agent, { channel: channel.id, body: `Report ${i}` }).seq));
  const compact = await f.wait(); bounded(compact);
  assert.equal(compact.mail!.length, channels.length);
  for (const [index, item] of compact.mail!.entries()) {
    assert.equal(item.channelId, channels[index].id);
    assert.equal(item.count, 2);
    assert.equal(item.excerpt, "Report 1");
    assert.equal(item.body, undefined);
    assert.equal(item.ch, `#${prefix}${index === 0 ? "" : "…"}`);
    const history = f.hive.listMessages(f.reader.agent, item.channelId).messages;
    assert.ok(expected.get(item.channelId)!.every(seq => history.some(message => message.seq === seq)));
  }
  const raw = await f.wait(false); bounded(raw);
  assert.equal(raw.delivery!.id, compact.delivery!.id);
  assert.deepEqual(new Set(raw.messages.map(message => message.channelId)), new Set(expected.keys()));
  f.ack(raw);
});

test("NUL-containing text survives raw delivery, compact replay and ACK unchanged", async t => {
  const f = fixture(t);
  const bodies = ["before\0important instruction", "\0leading", "trailing\0", "\0",
    "界\0😀".repeat(1000)];
  for (const body of bodies) {
    const sent = f.hive.postMessage(f.writer.agent, { channel: f.dm.id, body });
    const raw = await f.wait(false); bounded(raw);
    assert.equal(raw.messages[0].body, body);
    assert.equal(raw.messages[0].recovery, undefined);
    const compact = await f.wait(); bounded(compact);
    assert.equal(compact.delivery!.id, raw.delivery!.id);
    assert.equal(compact.mail![0].body, body);
    assert.equal(compact.mail![0].recovery, undefined);
    assert.equal(f.hive.getVisibleMessage(f.reader.agent, sent.seq).body, body);
    f.ack(compact);
  }
  assert.equal((await f.wait()).idle, true);
});

test("byte-bounded control reads preserve NUL and recover Unicode safely at either clipping boundary", async t => {
  const f = fixture(t);
  const originals = ["prefix\0" + "x".repeat(BODY_MAX * 4),
    "\0x" + "界".repeat(BODY_MAX * 2), // byte ceiling falls inside a UTF-8 code point
    "x".repeat(BODY_MAX - 1) + "😀tail"]; // character ceiling falls inside a surrogate pair
  for (const original of originals) {
    const seq = f.bulk(1, original, f.dm.id, "control")[0];
    const result = await f.wait(); bounded(result);
    const item = result.control[0];
    const expected = original.slice(0, BODY_MAX).replace(/[\uD800-\uDBFF]$/, "");
    assert.equal(item.body, expected);
    assert.ok(item.recovery);
    assert.equal(f.hive.getVisibleMessage(f.reader.agent, seq).body, original);
    f.ack(result);
  }
});

test("initial scan and timeout scan share one budget and report their actual combined work", async t => {
  const f = fixture(t);
  const general = f.hive.getChannel("general", f.reader.agent.projectId);
  f.bulk(123, "initial public noise", general.id);
  const observed = observeScans(f.hive); t.after(observed.restore);
  const pending = f.hive.wait(f.reader.agent, 10, undefined, { sessionId: f.sessionId, compact: true });
  f.bulk(WAIT_SCAN_MAX, "new public noise", general.id);
  const target = f.bulk(1, "mail beyond the request budget");
  const page = await pending; bounded(page);
  assert.deepEqual(observed.rows, [123, WAIT_SCAN_MAX - 123]);
  assert.equal(page.page!.scannedRows, observed.rows.reduce((a, b) => a + b, 0));
  assert.equal(page.idle, true);
  assert.equal(page.page!.continuation, true);
  assert.equal(page.page!.remaining.exact, false);
  observed.restore();
  const next = await f.wait(); bounded(next);
  assert.deepEqual(next.delivery!.messageSeqs, target);
  f.ack(next);
});

test("a fully spent initial scan returns without reserving another scan after sleep", async t => {
  const f = fixture(t);
  const general = f.hive.getChannel("general", f.reader.agent.projectId);
  f.bulk(WAIT_SCAN_MAX, "initial public noise", general.id);
  const observed = observeScans(f.hive); t.after(observed.restore);
  const pending = f.hive.wait(f.reader.agent, 10, undefined, { sessionId: f.sessionId, compact: true });
  const target = f.bulk(1, "mail for the next request");
  const page = await pending; bounded(page);
  assert.deepEqual(observed.rows, [WAIT_SCAN_MAX]);
  assert.equal(page.page!.scannedRows, WAIT_SCAN_MAX);
  assert.equal(page.idle, true);
  observed.restore();
  const next = await f.wait(); bounded(next);
  assert.deepEqual(next.delivery!.messageSeqs, target);
  f.ack(next);
});

test("a receipt offered during sleep is retained if it cannot fit the residual scan budget", async t => {
  const f = fixture(t);
  const general = f.hive.getChannel("general", f.reader.agent.projectId);
  f.bulk(WAIT_SCAN_MAX - 1, "initial noise", general.id);
  const observed = observeScans(f.hive); t.after(observed.restore);
  const waiting = f.hive.wait(f.reader.agent, 10, undefined, { sessionId: f.sessionId, compact: true });
  const seqs = f.bulk(2, "concurrently offered mail");
  const receipt = f.hive.inbox.offer(f.reader.agent.id, f.sessionId, seqs, seqs.at(-1)!);
  const page = await waiting; bounded(page);
  assert.equal(page.idle, true);
  assert.equal(page.page!.continuation, true);
  assert.deepEqual(observed.rows, [WAIT_SCAN_MAX - 1]);
  assert.equal(page.page!.scannedRows, WAIT_SCAN_MAX - 1);
  assert.equal(f.hive.inbox.pending(f.reader.agent.id)!.id, receipt.id);
  observed.restore();
  const next = await f.wait(); bounded(next);
  assert.equal(next.delivery!.id, receipt.id);
  assert.deepEqual(next.delivery!.messageSeqs, seqs);
  f.ack(next);
});

test("1103 full-size messages in one DM page without skipped mail in raw and compact formats", async t => {
  const f = fixture(t);
  const body = 'é\\\n"'.repeat(1000);
  const expected = f.bulk(1103, body);
  const received: number[] = [];
  let pages = 0;
  while (received.length < expected.length) {
    assert.ok(++pages < 1104);
    const result = await f.wait(pages % 2 === 0); bounded(result);
    assert.ok(result.delivery);
    if (pages === 1) {
      assert.equal(result.page!.remaining.exact, false);
      assert.equal(result.page!.scannedRows, WAIT_SCAN_MAX);
      const replay = await f.wait(false); bounded(replay);
      assert.equal(replay.delivery!.id, result.delivery.id);
      assert.deepEqual(replay.delivery!.messageSeqs, result.delivery.messageSeqs);
    }
    for (const item of [...result.messages, ...result.mentions, ...(result.mail ?? [])]) assert.equal(item.body, body);
    received.push(...result.delivery.messageSeqs);
    f.ack(result);
  }
  assert.deepEqual(received, expected);
  assert.ok(pages > 10, "Byte cap must apply within a single admitted conversation");
  const end = await f.wait(); bounded(end);
  assert.equal(end.idle, true);
  assert.deepEqual(end.page!.remaining, { atLeast: 0, exact: true });
});

test("reserved mentions and control cannot skip ordinary mail; sparse receipts survive restart", async t => {
  const f = fixture(t, "worker");
  const normal = f.bulk(20);
  const urgent = [...f.bulk(1, "look here", f.dm.id, "chat", [f.reader.agent.id]),
    ...f.bulk(1, "clear context", f.dm.id, "control")];
  const first = await f.wait(); bounded(first, WAIT_MAIL_CAP);
  assert.equal(first.delivery!.messageSeqs.length, WAIT_MAIL_CAP);
  assert.ok(first.delivery!.messageSeqs.includes(normal[0]));
  for (const seq of urgent) assert.ok(first.delivery!.messageSeqs.includes(seq));
  const replay = await f.wait(false); bounded(replay, WAIT_MAIL_CAP);
  assert.deepEqual(replay.delivery!.messageSeqs, first.delivery!.messageSeqs);
  f.ack(first);
  assert.equal(f.hive.db.prepare("SELECT COUNT(*) AS n FROM inbox_early_receipts").get()!.n, 2);
  f.hive.db.close();
  const restarted = new Hive(f.file); t.after(() => restarted.db.close());
  const sessionId = restarted.openInboxSession(f.reader.agent, crypto.randomUUID());
  const seen = [...first.delivery!.messageSeqs];
  while (seen.length < normal.length + urgent.length) {
    const next = await restarted.wait(f.reader.agent, 1, undefined, { sessionId, compact: true });
    bounded(next, WAIT_MAIL_CAP); assert.ok(next.delivery);
    seen.push(...next.delivery.messageSeqs);
    restarted.acknowledgeInbox(f.reader.agent, sessionId, next.delivery.id);
  }
  assert.deepEqual(seen.sort((a, b) => a - b), [...normal, ...urgent]);
  assert.equal(restarted.db.prepare("SELECT COUNT(*) AS n FROM inbox_early_receipts").get()!.n, 0);
});

test("public noise uses bounded empty continuations; the MCP loop only returns actual mail", async t => {
  const f = fixture(t);
  const general = f.hive.getChannel("general", f.reader.agent.projectId);
  f.bulk(1200, "public chatter", general.id);
  const target = f.bulk(1, "addressed after noise");
  assert.deepEqual(f.hive.inboxStatuses()[f.reader.agent.id].queued, { atLeast: 0, exact: false });
  const started = Date.now(); let calls = 0;
  const result = await waitUntilMail(async () => {
    calls++;
    const page = await f.hive.wait(f.reader.agent, 60_000, undefined, { sessionId: f.sessionId, compact: true });
    bounded(page);
    if (page.idle) {
      assert.equal(page.page!.continuation, true);
      assert.equal(page.page!.remaining.exact, false);
      assert.equal(page.delivery, undefined);
    }
    return page;
  });
  assert.equal(calls, 5);
  assert.ok(Date.now() - started < 5000, "No long-poll sleep between progress pages");
  assert.deepEqual(result.delivery!.messageSeqs, target);
  f.ack(result);
  assert.deepEqual(f.hive.inboxStatuses()[f.reader.agent.id].queued, { atLeast: 0, exact: true });
});

test("queue lower bound excludes pending and early-confirmed messages", async t => {
  const f = fixture(t, "worker");
  f.bulk(300);
  const first = await f.wait(); bounded(first, WAIT_MAIL_CAP);
  assert.deepEqual(first.page!.remaining, { atLeast: WAIT_SCAN_MAX - WAIT_MAIL_CAP, exact: false });
  assert.deepEqual(f.hive.inboxStatuses()[f.reader.agent.id].queued, first.page!.remaining);
  f.ack(first);
  assert.deepEqual(f.hive.inboxStatuses()[f.reader.agent.id].queued, { atLeast: WAIT_SCAN_MAX, exact: false });
});

test("legacy oversize pending batch is atomically split; its old ACK cannot discard the tail", async t => {
  const f = fixture(t);
  const all = f.bulk(100, "界".repeat(BODY_MAX));
  const old = f.hive.inbox.offer(f.reader.agent.id, f.sessionId, all, all.at(-1)!);
  // Recreate the exact v3 schema/index, then exercise startup migration.
  f.hive.db.exec(`DROP INDEX inbox_one_pending;
    ALTER TABLE inbox_deliveries DROP COLUMN superseded_by;
    CREATE UNIQUE INDEX inbox_one_pending ON inbox_deliveries(agent_id) WHERE acknowledged_at IS NULL;`);
  f.hive.db.close();
  const upgraded = new Hive(f.file); t.after(() => upgraded.db.close());
  const seen: number[] = [];
  while (seen.length < all.length) {
    const result = await upgraded.wait(f.reader.agent, 1, undefined, { sessionId: f.sessionId }); bounded(result);
    assert.ok(result.delivery); assert.notEqual(result.delivery.id, old.id);
    assert.throws(() => upgraded.acknowledgeInbox(f.reader.agent, f.sessionId, old.id), /Delivery was split/);
    seen.push(...result.delivery.messageSeqs);
    upgraded.acknowledgeInbox(f.reader.agent, f.sessionId, result.delivery.id);
  }
  assert.deepEqual(seen, all);
  assert.equal(upgraded.inbox.status(f.reader.agent.id).acknowledgedMessages, all.length);
});

test("control bodies, UTF-8 and JSON escapes obey byte caps; truncated originals remain recoverable", async t => {
  const f = fixture(t);
  const original = "\\\u0001界".repeat(BODY_MAX);
  const seq = f.bulk(1, original, f.dm.id, "control")[0];
  const result = await f.wait(); bounded(result);
  const control = result.control[0];
  assert.equal(control.seq, seq);
  assert.ok(control.body.length <= BODY_MAX);
  assert.equal(control.recovery!.channel, f.dm.id);
  assert.equal(control.recovery!.since, seq - 1);
  f.bulk(3, "later unrelated mail");
  const history = f.hive.listMessages(f.reader.agent, control.recovery!.channel,
    { threadId: control.recovery!.threadId, afterSeq: control.recovery!.since, limit: control.recovery!.limit });
  assert.equal(history.messages[0].body, original);
  f.ack(result);
});

test("oversize single-message metadata returns an explicit history stub, not a stuck queue", async t => {
  const f = fixture(t);
  const seq = f.bulk(1)[0];
  const row = f.hive.db.prepare("SELECT id FROM messages WHERE seq = ?").get(seq)!;
  f.hive.db.prepare(`INSERT INTO bot_events(message_id, bot_id, channel_id, event_id, metadata, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, f.writer.agent.id, f.dm.id, "legacy", JSON.stringify({ eventId: "legacy", origin: { label: "x".repeat(100_000) } }), "fixture");
  const result = await f.wait(); bounded(result);
  assert.match(result.mail![0].body!, /exceeds the wait budget/);
  assert.ok(result.mail![0].recovery);
  f.ack(result);
  assert.equal((await f.wait()).idle, true);
});

test("many channel memberships do not create a SQL-variable list and all classes obey the conversation cap", async t => {
  const f = fixture(t);
  const channel = f.hive.db.prepare(`INSERT INTO channels(id, name, type, created_by, created_at, project_id)
    VALUES (?, ?, 'private', ?, ?, ?)`);
  const member = f.hive.db.prepare("INSERT INTO channel_members(channel_id, agent_id) VALUES (?, ?)");
  const channels: string[] = [];
  f.hive.db.exec("BEGIN");
  for (let i = 0; i < 1100; i++) {
    const id = crypto.randomUUID(); channels.push(id);
    channel.run(id, `fixture-${i}`, f.writer.agent.id, Date.now(), f.reader.agent.projectId!);
    member.run(id, f.reader.agent.id);
  }
  f.hive.db.exec("COMMIT");
  const expected = channels.slice(0, 12).flatMap(id => f.bulk(1, "urgent", id, "chat", [f.reader.agent.id]));
  const first = await f.wait(false); bounded(first);
  assert.equal(first.delivery!.messageSeqs.length, WAIT_MAIL_CAP);
  assert.equal(new Set([...first.messages, ...first.mentions].map(m => m.channelId)).size, WAIT_MAIL_CAP);
  f.ack(first);
  const rest = await f.wait(false); bounded(rest); f.ack(rest);
  assert.deepEqual([...first.delivery!.messageSeqs, ...rest.delivery!.messageSeqs], expected);
});

test("a flood made entirely of mentions/control still paginates by bytes", async t => {
  const f = fixture(t);
  const body = "\u0001".repeat(BODY_MAX);
  const expected = [...f.bulk(20, body, f.dm.id, "control"),
    ...f.bulk(20, body, f.dm.id, "chat", [f.reader.agent.id])];
  const received: number[] = [];
  while (received.length < expected.length) {
    const page = await f.wait(); bounded(page);
    assert.ok(page.delivery);
    assert.ok(page.delivery.messageSeqs.length < expected.length);
    received.push(...page.delivery.messageSeqs);
    f.ack(page);
  }
  assert.deepEqual(received, expected);
});

test("thread reply fallback recovers the exact original, even with newer replies", async t => {
  const f = fixture(t);
  const root = f.hive.postMessage(f.writer.agent, { channel: f.dm.id, body: "root" });
  const reply = f.hive.postMessage(f.writer.agent, { channel: f.dm.id, threadId: root.id, body: "reply" });
  const original = "😀".repeat(BODY_MAX);
  f.hive.db.prepare("UPDATE messages SET body = ?, kind = 'control', control = 'clear_context' WHERE seq = ?").run(original, reply.seq);
  f.hive.postMessage(f.writer.agent, { channel: f.dm.id, threadId: root.id, body: "later reply" });
  const page = await f.wait(); bounded(page);
  const item = page.control.find(m => m.seq === reply.seq)!;
  const recovery = item.recovery!; assert.ok(recovery);
  const recovered = f.hive.listMessages(f.reader.agent, recovery.channel,
    { threadId: recovery.threadId, afterSeq: recovery.since, limit: recovery.limit });
  assert.equal(recovered.messages[0].seq, reply.seq);
  assert.equal(recovered.messages[0].body, original);
});
