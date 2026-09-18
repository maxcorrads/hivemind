import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { TelegramBridge, telegramDestinationForSeq, writeTelegramFile } from "./telegram.ts";
import { recordTelegramFailure, enqueueTelegramPending, TELEGRAM_FAILURE_CAP, telegramBotKey } from "./telegram-outbox.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Expected bridge progress before deadline");
    await nextTurn();
  }
}
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-outbox-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { hive, dir };
}

test("real bridge resumes only the failed part after restart and Human retry wakes the idle dispatcher", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-multipart-"));
  let hive = new Hive(path.join(dir, "hive.db"));
  const cfg = { botToken: "fixture", allowUserIds: [1], groups: { chapter: -1001 } };
  writeTelegramFile({ botToken: cfg.botToken, allowUserIds: [1], projects: cfg.groups }, dir);
  let bridge: TelegramBridge | undefined;
  const sent: string[] = [];
  let broken = true;
  let id = 100;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    const name = init?.body instanceof FormData ? (init.body.get("document") as File).name : "text";
    sent.push(name);
    if (name === "b.txt" && broken) return Response.json({ ok: false, description: "chat not found" });
    return Response.json({ ok: true, result: { message_id: id++ } });
  });
  try {
    const human = hive.getAgent("human");
    const a = await hive.createFileFromBytes(human, { name: "a.txt", mime: "text/plain", bytes: Buffer.from("a") });
    const b = await hive.createFileFromBytes(human, { name: "b.txt", mime: "text/plain", bytes: Buffer.from("b") });
    const health: number[] = [];
    hive.bus.on("telegram-health", value => health.push(value.failures));
    bridge = new TelegramBridge(hive, cfg);
    bridge.start();
    hive.postMessage(human, { channel: "general", body: "x".repeat(1100), attachmentIds: [a.id, b.id] });
    await until(() => hive.telegramFailureCount() === 1);
    assert.deepEqual(sent, ["text", "a.txt", "b.txt"]);
    assert.ok(health.includes(1));
    await bridge.stop();
    bridge = undefined;
    hive.db.close();
    hive = new Hive(path.join(dir, "hive.db"));
    broken = false;
    bridge = new TelegramBridge(hive, cfg);
    bridge.start();
    await nextTurn(); // dispatcher has reached idle before the explicit retry
    const failure = hive.telegramFailures()[0]!;
    const response = await createApp(hive).request(`/api/ui/telegram/failures/${failure.id}/retry`, { method: "POST" });
    assert.equal(response.status, 200);
    await until(() => sent.length === 4);
    assert.deepEqual(sent, ["text", "a.txt", "b.txt", "b.txt"]);
    assert.equal(hive.telegramFailureCount(), 0);
    assert.equal((hive.db.prepare("SELECT resolution FROM telegram_failures WHERE id = ?").get(failure.id) as { resolution: string }).resolution, "retried");
  } finally {
    await bridge?.stop();
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry rejects changed bot/chat and rolls back queue insertion on an audit failure", t => {
  const { hive } = fixture(t);
  const message = hive.postMessage(hive.getAgent("human"), { channel: "general", body: "private original" });
  const original = { botKey: telegramBotKey("a"), chatId: -1001 };
  recordTelegramFailure(hive.db, message.seq, "message", "fixture", 1, original.chatId, original.botKey);
  const failure = hive.telegramFailures()[0]!;
  for (const dest of [undefined, { ...original, chatId: -1002 }, { ...original, botKey: telegramBotKey("b") }]) {
    assert.throws(() => hive.retryTelegramFailure(failure.id, () => dest), /destination changed or unknown/);
  }
  hive.db.exec(`CREATE TEMP TRIGGER fail_audit BEFORE UPDATE ON telegram_failures BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
  assert.throws(() => hive.retryTelegramFailure(failure.id, () => original), /fixture audit failure/);
  assert.equal(hive.db.prepare("SELECT 1 FROM telegram_pending WHERE seq = ?").get(message.seq), undefined);
  assert.equal(hive.telegramFailureCount(), 1);
  hive.db.exec("DROP TRIGGER fail_audit");
  let wake = 0;
  hive.bus.on("telegram-outbox-wake", () => { wake++; assert.ok(hive.db.prepare("SELECT 1 FROM telegram_pending WHERE seq = ?").get(message.seq)); });
  hive.retryTelegramFailure(failure.id, () => original);
  assert.equal(wake, 1);
});

test("failure diagnostics are bounded and expirations remain visible in an aggregate", t => {
  const { hive } = fixture(t);
  for (let i = 0; i < TELEGRAM_FAILURE_CAP + 7; i++) recordTelegramFailure(hive.db, i, "message", "fixture");
  assert.equal(hive.telegramFailureCount(), TELEGRAM_FAILURE_CAP);
  assert.equal(hive.telegramOutboxHealth().diagnosticsPruned, 7);
});

test("old destination jobs are quarantined rather than sent under a new bridge", async t => {
  const { hive } = fixture(t);
  const message = hive.postMessage(hive.getAgent("human"), { channel: "general", body: "keep original audience" });
  enqueueTelegramPending(hive.db, message.seq, "message", undefined, { botKey: telegramBotKey("a"), chatId: -1001 });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    sends++;
    return Response.json({ ok: true, result: { message_id: 10 } });
  });
  const bridge = new TelegramBridge(hive, { botToken: "b", allowUserIds: [1], groups: { chapter: -1002 } });
  bridge.start();
  try {
    await until(() => hive.telegramFailureCount() === 1);
    assert.equal(sends, 0);
    assert.equal(hive.telegramFailures()[0]?.telegramChatId, -1001);
  } finally { await bridge.stop(); }
});
