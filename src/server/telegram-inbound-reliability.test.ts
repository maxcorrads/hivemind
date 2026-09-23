import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { countRows, failWrites, hasRow, insertRow, insertRows, deleteRows, rowsContaining, telegramOffset } from "./test-fixtures.ts";
import { createApp } from "./app.ts";
import { TelegramBridge, telegramConfigKey, writeTelegramFile, loadTelegramConfig, type TelegramConfig } from "./telegram.ts";
import { initTelegramRouting } from "./telegram-routing.ts";
import { recordTelegramUpdateFailure, finishTelegramUpdate, initTelegramInbox, pruneTelegramUpdates,
  telegramPollBackoffMs, isTelegramTerminalPollError, TELEGRAM_UPDATE_CAP, TELEGRAM_UPDATE_BYTES, TELEGRAM_UPDATE_RETRY_CAP } from "./telegram-inbox.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-inbound-"));
  const state = { dir, hive: new Hive(path.join(dir, "hive.db")), bridge: undefined as TelegramBridge | undefined };
  t.after(async () => { await state.bridge?.stop(); state.hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return state;
}
const config: TelegramConfig = { botToken: "fixture-secret", allowUserIds: [1], groups: { chapter: -1001 } };
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function flush() { for (let i = 0; i < 30; i++) await nextTurn(); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 3000; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Mocked Telegram did not make progress");
}
function freeze(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(Math, "random", () => 0.5);
}
function message(updateId: number, text: string, chatId = -1001) {
  return { update_id: updateId, message: { message_id: updateId + 100, chat: { id: chatId }, from: { id: 1, first_name: "Human" }, text } };
}
function scope(hive: Hive) {
  return { botKey: telegramConfigKey(config), chatId: -1001, projectId: hive.findProjectBySlug("chapter")!.id };
}

test("failure record, seen marker and cursor roll back at each SQLite statement and survive reopen", async t => {
  for (const [table, condition] of [["telegram_update_failures", "1"], ["telegram_in", "1"], ["telegram_bot_state", "NEW.key = 'offset'"]]) {
    await t.test(table!, async sub => {
      const f = fixture(sub);
      initTelegramRouting(f.hive.db, telegramConfigKey(config));
      failWrites(f.hive, table!, { timing: "after", when: condition, message: "injected crash point" });
      assert.throws(() => recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(7, "retain me"), "failure", { permanent: true }), /injected/);
      assert.equal(hasRow(f.hive, "telegram_update_failures"), false);
      assert.equal(hasRow(f.hive, "telegram_in", { update_id: 7 }), false);
      assert.equal(telegramOffset(f.hive), undefined);
      f.hive.db.close();
      f.hive = new Hive(path.join(f.dir, "hive.db"));
      recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(7, "retain me"), "failure", { permanent: true });
      assert.equal(f.hive.telegramQuarantine().length, 1);
      assert.ok(hasRow(f.hive, "telegram_in", { update_id: 7 }));
      assert.equal(telegramOffset(f.hive), "8");
    });
  }
});

test("a failed attachment cannot starve another project; retries have deadlines and explicit replay wakes an idle bridge", async t => {
  const f = fixture(t); freeze(t);
  const other = f.hive.createProject(f.hive.getAgent("human"), { name: "Other", slug: "other" });
  writeTelegramFile({ botToken: config.botToken, allowUserIds: [1], projects: { chapter: -1001, other: -1002 } }, f.dir);
  const cfg = loadTelegramConfig(f.dir)!;
  let polls = 0, downloads = 0, broken = true;
  const poison = { update_id: 1, message: { message_id: 101, chat: { id: -1001 }, from: { id: 1 }, document: { file_id: "document", file_name: "a.txt", mime_type: "text/plain" } } };
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) {
      if (++polls === 1) return Response.json({ ok: true, result: [poison, message(2, "other still works", -1002)] });
      return blocked(init?.signal);
    }
    if (String(url).endsWith("getFile")) {
      downloads++;
      return broken ? Response.json({ ok: false, description: `download failed ${config.botToken}` })
        : Response.json({ ok: true, result: { file_path: "file/a.txt", file_size: 3 } });
    }
    assert.ok(String(url).includes("/file/bot"));
    return new Response("abc");
  });
  f.bridge = new TelegramBridge(f.hive, cfg); f.bridge.start();
  await until(() => polls === 2);
  assert.equal(downloads, 1);
  assert.equal(f.hive.telegramPollHealth().retrying, 1);
  assert.ok(f.hive.listMessages(f.hive.getAgent("human"), f.hive.getChannel("general", other.id).id).messages.some(m => m.body.includes("other still works")));
  t.mock.timers.tick(999); await flush(); assert.equal(downloads, 1);
  for (const delay of [1, 2000, 4000, 8000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(downloads, 5);
  const failure = f.hive.telegramQuarantine()[0]!;
  assert.equal(failure.attempts, 5);
  assert.equal(failure.lastError.includes(config.botToken), false);
  t.mock.timers.tick(60_000); await flush(); assert.equal(downloads, 5);
  broken = false;
  const response = await createApp(f.hive).request(`/api/ui/telegram/quarantine/${failure.id}/retry`, { method: "POST" });
  assert.equal(response.status, 200);
  await until(() => f.hive.telegramPollHealth().retrying === 0);
  assert.equal(downloads, 6);
  assert.equal(f.hive.telegramQuarantine().length, 0);
  const inbound = f.hive.listMessages(f.hive.getAgent("human"), f.hive.getChannel("general", scope(f.hive).projectId).id).messages.filter(m => m.attachments?.length);
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0]!.attachments!.length, 1);
  assert.equal(telegramOffset(f.hive), "3", "old replay must not regress the cursor");
});

test("retry deadlines and original scopes survive restart without an unrelated incoming update", async t => {
  const f = fixture(t); freeze(t);
  initTelegramRouting(f.hive.db, telegramConfigKey(config));
  recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(10, "resumed"), "transient", { retryAt: Date.now() + 30_000 });
  f.hive.db.close(); f.hive = new Hive(path.join(f.dir, "hive.db"));
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => blocked(init?.signal));
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  await flush();
  t.mock.timers.tick(29_999); await flush();
  assert.equal(hasRow(f.hive, "telegram_out", { telegram_message_id: 110 }), false);
  t.mock.timers.tick(1);
  await until(() => hasRow(f.hive, "telegram_out", { telegram_message_id: 110 }));
  assert.equal(f.hive.telegramPollHealth().retrying, 0);
});

test("malformed input is quarantined, unknown chats are ignored, and polling respects terminal backoff", async t => {
  const f = fixture(t); freeze(t);
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    polls++;
    if (polls === 1) return Response.json({ ok: true, result: [
      { update_id: 1, message: { message_id: "bad", chat: { id: -1001 }, from: { id: 1 } } },
      message(2, "not our audience", -987), message(3, "valid"),
    ] });
    if (polls === 2) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    return blocked(init?.signal);
  });
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  await until(() => f.hive.telegramPollHealth().lastError === "Unauthorized");
  assert.equal(f.hive.telegramQuarantine().length, 1);
  const bodies = f.hive.listMessages(f.hive.getAgent("human"), "general").messages.map(m => m.body);
  assert.ok(bodies.some(b => b.endsWith("valid")));
  assert.ok(!bodies.some(b => b.includes("not our audience")));
  t.mock.timers.tick(29_999); await flush(); assert.equal(polls, 2);
  t.mock.timers.tick(1); await until(() => polls === 3);
  await f.bridge.stop(); t.mock.timers.tick(120_000); await flush(); assert.equal(polls, 3);
});

test("inbound post and Telegram receipt are atomic; failed receipt publication does not emit or duplicate a message", async t => {
  const f = fixture(t); freeze(t);
  let polls = 0, published = 0;
  f.hive.bus.on("message", () => { published++; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (++polls === 1) return Response.json({ ok: true, result: [message(4, "transactional")] });
    return blocked(init?.signal);
  });
  f.bridge = new TelegramBridge(f.hive, config);
  const restoreReceipts = failWrites(f.hive, "telegram_out", { message: "receipt failed" });
  f.bridge.start();
  await until(() => f.hive.telegramPollHealth().retrying === 1);
  assert.equal(published, 0);
  assert.equal(rowsContaining(f.hive, "messages", "body", "transactional").length, 0);
  restoreReceipts();
  t.mock.timers.tick(1_000);
  await until(() => published === 1);
  assert.equal(rowsContaining(f.hive, "messages", "body", "transactional").length, 1);
});

test("actual inbound replies preserve roots across nested replies, attachment mappings, stale roots, duplicates and restart", async t => {
  const f = fixture(t); freeze(t);
  const human = f.hive.getAgent("human");
  const root = f.hive.postMessage(human, { channel: "general", body: "root" });
  const nested = f.hive.postMessage(human, { channel: "general", body: "child", threadId: root.id });
  const gone = f.hive.postMessage(human, { channel: "general", body: "deleted" });
  f.bridge = new TelegramBridge(f.hive, config);
  insertRows(f.hive, "telegram_out", ([[11, root], [12, nested], [13, root], [14, gone]] as const).map(([id, m]) => ({
    bot_key: telegramConfigKey(config), telegram_chat_id: -1001, telegram_message_id: id, seq: m.seq, channel_id: m.channelId, thread_id: m.threadId,
  })));
  deleteRows(f.hive, "messages", { id: gone.id });
  const updates = [11, 12, 13, 14, 999].map((replyId, i) => ({ ...message(20 + i, `reply-${replyId}`), message: { ...message(20 + i, `reply-${replyId}`).message, reply_to_message: { message_id: replyId } } }));
  updates.push(updates[0]!); // redelivered update
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (++polls === 1) return Response.json({ ok: true, result: updates });
    return blocked(init?.signal);
  });
  f.bridge.start(); await until(() => polls === 2);
  const replies = rowsContaining(f.hive, "messages", "body", "reply-", "seq").map(row => f.hive.getMessageBySeq(Number(row.seq)));
  assert.equal(replies.length, 5);
  for (const id of [11, 12, 13]) assert.equal(replies.find(m => m.body.endsWith(`reply-${id}`))!.threadId, root.id);
  for (const id of [14, 999]) {
    const reply = replies.find(m => m.body.endsWith(`reply-${id}`))!;
    assert.equal(reply.threadId, null); assert.match(reply.body, /Original reply unavailable/);
  }
  await f.bridge.stop(); f.hive.db.close(); f.hive = new Hive(path.join(f.dir, "hive.db"));
  polls = 0;
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  await flush(); assert.equal(polls, 1); t.mock.timers.tick(250); await until(() => polls === 2);
  assert.equal(rowsContaining(f.hive, "messages", "body", "reply-").length, 5);
});

test("quarantine API rejects a different bot/project/chat, rolls back a failed retry and publishes only after commit", async t => {
  const f = fixture(t);
  writeTelegramFile({ botToken: config.botToken, allowUserIds: [1], projects: config.groups }, f.dir);
  initTelegramRouting(f.hive.db, telegramConfigKey(config));
  recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(1, "secret"), "poison", { permanent: true });
  const id = f.hive.telegramQuarantine()[0]!.id;
  const app = createApp(f.hive);
  for (const [token, chat] of [["other-bot", -1001], [config.botToken, -1002]] as const) {
    writeTelegramFile({ botToken: token, allowUserIds: [1], projects: { chapter: chat } }, f.dir);
    assert.equal((await app.request(`/api/ui/telegram/quarantine/${id}/retry`, { method: "POST" })).status, 409);
  }
  writeTelegramFile({ botToken: config.botToken, allowUserIds: [1], projects: config.groups }, f.dir);
  assert.equal((await app.request("/api/ui/telegram/quarantine?limit=NaN")).status, 400);
  const list = await app.request("/api/ui/telegram/quarantine");
  assert.equal(list.status, 200); assert.equal(JSON.stringify(await list.json()).includes('"payload"'), false);
  const restoreRetries = failWrites(f.hive, "telegram_update_failures", { on: "update", message: "retry failed" });
  let wakes = 0;
  f.hive.bus.on("telegram-inbox-wake", () => { wakes++; assert.equal(f.hive.telegramPollHealth().retrying, 1); });
  assert.throws(() => f.hive.retryTelegramUpdate(id, () => true), /retry failed/);
  assert.equal(wakes, 0); assert.equal(f.hive.telegramQuarantine().length, 1);
  restoreRetries();
  assert.equal((await app.request(`/api/ui/telegram/quarantine/${id}/retry`, { method: "POST" })).status, 200);
  assert.equal(wakes, 1);
  f.hive.bus.removeAllListeners("telegram-inbox-wake");
  assert.equal((await app.request(`/api/ui/telegram/quarantine/${id}/discard`, { method: "POST" })).status, 200);
  assert.equal(f.hive.telegramPollHealth().retrying, 0);
  assert.equal((await app.request(`/api/ui/telegram/quarantine/${id}/retry`, { method: "POST" })).status, 404);
});

test("bounded failure retention, legacy scope and monotone replay offsets remain inspectable", t => {
  const f = fixture(t); initTelegramRouting(f.hive.db, telegramConfigKey(config));
  for (let i = 0; i < TELEGRAM_UPDATE_CAP + 2; i++) recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(i, "bounded"), "poison", { permanent: true });
  assert.equal(f.hive.telegramPollHealth().quarantined, TELEGRAM_UPDATE_CAP);
  assert.equal(f.hive.telegramPollHealth().inboundDiagnosticsPruned, 2);
  recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(9999, "x".repeat(TELEGRAM_UPDATE_BYTES)), "too large");
  assert.ok(f.hive.telegramQuarantine(200).some(row => row.lastError === "update_payload_too_large" && !row.replayable));
  finishTelegramUpdate(f.hive.db, telegramConfigKey(config), 3);
  assert.equal(telegramOffset(f.hive), "10000");
  pruneTelegramUpdates(f.hive.db, Date.now() + 31 * 86400_000);
  assert.equal(f.hive.telegramPollHealth().quarantined, 0);
  // schema-level assertion: recreate the legacy failure table before migration.
  f.hive.db.exec("DROP TABLE telegram_update_failures; CREATE TABLE telegram_update_failures(update_id INTEGER PRIMARY KEY, payload TEXT, attempts INTEGER, last_error TEXT, state TEXT, updated_at INTEGER)");
  insertRow(f.hive, "telegram_update_failures", { update_id: 1, payload: JSON.stringify(message(1, "legacy")), attempts: 3, last_error: "failure", state: "retrying", updated_at: Date.now() });
  initTelegramInbox(f.hive.db); initTelegramInbox(f.hive.db);
  const legacy = f.hive.telegramQuarantine()[0]!;
  assert.equal(legacy.lastError, "legacy_scope_unknown"); assert.equal(legacy.replayable, false);
  assert.throws(() => f.hive.retryTelegramUpdate(legacy.id, () => false), /original bot/);
});

test("automatic and manual retries share a bounded capacity; backoff is finite and capped", t => {
  const f = fixture(t); initTelegramRouting(f.hive.db, telegramConfigKey(config));
  for (let i = 0; i < TELEGRAM_UPDATE_RETRY_CAP + 1; i++) recordTelegramUpdateFailure(f.hive.db, scope(f.hive), message(i, "transient"), "transient");
  assert.equal(f.hive.telegramPollHealth().retrying, TELEGRAM_UPDATE_RETRY_CAP);
  const overflow = f.hive.telegramQuarantine()[0]!;
  assert.equal(overflow.lastError, "inbound_retry_queue_full");
  assert.throws(() => f.hive.retryTelegramUpdate(overflow.id, () => true), /queue is full/);
  for (const n of [1, 2, 100, Infinity]) for (const sample of [0, 0.5, 1, NaN]) {
    const delay = telegramPollBackoffMs(n, () => sample);
    assert.ok(delay >= 750 && delay <= 30_000);
  }
  assert.equal(telegramPollBackoffMs(1, () => 0, true), 30_000);
  assert.ok(isTelegramTerminalPollError("Unauthorized"));
  assert.ok(!isTelegramTerminalPollError("upstream timeout"));
});

test("a proxy repeating an already-seen successful batch cannot spin the poller", async t => {
  const f = fixture(t); freeze(t);
  let polls = 0;
  t.mock.method(globalThis, "fetch", async () => { polls++; return Response.json({ ok: true, result: [message(8, "once")] }); });
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  await until(() => polls === 2); await flush();
  assert.equal(polls, 2);
  t.mock.timers.tick(249); await flush(); assert.equal(polls, 2);
  t.mock.timers.tick(1); await until(() => polls === 3); await flush();
  assert.equal(countRows(f.hive, "telegram_out", { telegram_message_id: 108 }), 1);
});

test("file download HTTP 429 retains its Retry-After deadline and releases the error body", async t => {
  const f = fixture(t); freeze(t);
  let polls = 0, downloads = 0, cancelled = 0;
  const input = { update_id: 8, message: { message_id: 108, chat: { id: -1001 }, from: { id: 1 }, document: { file_id: "f", file_name: "f.txt", mime_type: "text/plain" } } };
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) {
      if (++polls === 1) return Response.json({ ok: true, result: [input, message(9, "later valid message")] });
      return blocked(init?.signal);
    }
    if (String(url).endsWith("getFile")) return Response.json({ ok: true, result: { file_path: "a", file_size: 3 } });
    downloads++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429, headers: { "Retry-After": "30" } });
  });
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  await until(() => f.hive.telegramPollHealth().retrying === 1 && polls === 2);
  assert.equal(cancelled, 1); assert.equal(downloads, 1);
  t.mock.timers.tick(29_999); await flush(); assert.equal(downloads, 1);
  t.mock.timers.tick(1); await until(() => downloads === 2); await flush();
  assert.equal(cancelled, 2);
  assert.ok(f.hive.listMessages(f.hive.getAgent("human"), "general").messages.some(m => m.body.endsWith("later valid message")));
});
