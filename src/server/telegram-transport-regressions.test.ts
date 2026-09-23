import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { hasRow, insertRow, readValue } from "./test-fixtures.ts";
import { TelegramBridge, startTelegram, telegramConfigKey, telegramRetryAfterMs, projectSlugForChat,
  readTelegramFile, writeTelegramFile, type TelegramConfig } from "./telegram.ts";
import { enqueueTelegramPending } from "./telegram-outbox.ts";
import { recordTelegramUpdateFailure } from "./telegram-inbox.ts";

const cfg: TelegramConfig = { botToken: "test-bot", allowUserIds: [1], groups: { chapter: -1001 } };
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-transport-"));
  const f = { dir, hive: new Hive(path.join(dir, "hive.db")), bridge: undefined as TelegramBridge | undefined };
  t.after(async () => { await f.bridge?.stop(); f.hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  return f;
}
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function flush() { for (let i = 0; i < 30; i++) await nextTurn(); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 3000; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Mocked transport did not make progress");
}

test("per-chat HTTP Retry-After survives restart while another chat progresses", async t => {
  const f = fixture(t); const human = f.hive.getAgent("human");
  const project = f.hive.createProject(human, { name: "Other", slug: "other" });
  const other = f.hive.getChannel("general", project.id);
  const config = { ...cfg, groups: { chapter: -1001, other: -1002 } };
  const calls: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    const chat = JSON.parse(String(init?.body)).chat_id as number; calls.push(chat);
    if (calls.length === 1) return Response.json({ ok: false }, { status: 429, headers: { "Retry-After": "30" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  });
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  const a = f.hive.postMessage(human, { channel: "general", body: "A" });
  await until(() => calls.length === 1); await flush(); await f.bridge.stop();
  f.hive.db.close(); f.hive = new Hive(path.join(f.dir, "hive.db"));
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  f.hive.postMessage(f.hive.getAgent("human"), { channel: other.id, body: "B" });
  await until(() => calls.length === 2);
  assert.deepEqual(calls, [-1001, -1002]);
  assert.equal(readValue(f.hive, "telegram_pending", "attempts", { seq: a.seq }), 1);
  t.mock.timers.tick(29_999); await flush(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); await until(() => calls.length === 3);
  assert.deepEqual(calls, [-1001, -1002, -1001]);
});

test("transient failure backoff is per chat and retry attempts cannot reset across restarts", async t => {
  const f = fixture(t); const human = f.hive.getAgent("human");
  const project = f.hive.createProject(human, { name: "Other", slug: "other" });
  const config = { ...cfg, groups: { chapter: -1001, other: -1002 } };
  const calls: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    const chat = JSON.parse(String(init?.body)).chat_id as number; calls.push(chat);
    return chat === -1001 ? Response.json({ ok: false, description: "temporary failure" })
      : Response.json({ ok: true, result: { message_id: calls.length } });
  });
  f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
  f.hive.postMessage(human, { channel: "general", body: "retry me" });
  f.hive.postMessage(human, { channel: f.hive.getChannel("general", project.id).id, body: "independent" });
  await until(() => calls.length === 2); assert.deepEqual(calls, [-1001, -1002]);
  for (const delay of [2000, 4000, 8000, 16000]) {
    await f.bridge.stop(); f.bridge = new TelegramBridge(f.hive, config); f.bridge.start();
    t.mock.timers.tick(delay); await flush();
  }
  assert.equal(calls.filter(chat => chat === -1001).length, 5);
  assert.equal(f.hive.telegramFailures()[0]?.attempts, 5);
  t.mock.timers.tick(100_000); await flush(); assert.equal(calls.length, 6);
});

test("eligible chats get round-robin turns without reordering a chat", async t => {
  const f = fixture(t); const human = f.hive.getAgent("human");
  const project = f.hive.createProject(human, { name: "Other", slug: "other" });
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    const body = JSON.parse(String(init?.body)); sent.push(String(body.text).split("\n").at(-1)!);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  f.bridge = new TelegramBridge(f.hive, { ...cfg, groups: { chapter: -1001, other: -1002 } }); f.bridge.start();
  for (const body of ["A1", "A2", "A3"]) f.hive.postMessage(human, { channel: "general", body });
  f.hive.postMessage(human, { channel: f.hive.getChannel("general", project.id).id, body: "B1" });
  await until(() => sent.length === 1); await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.deepEqual(sent, ["A1", "B1", "A2", "A3"]);
});

test("a newer reaction queued during an in-flight send is not deleted with the old job", async t => {
  const f = fixture(t); const human = f.hive.getAgent("human");
  const original = f.hive.postMessage(human, { channel: "general", body: "reaction target" });
  let release!: (response: Response) => void;
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    assert.ok(String(url).endsWith("setMessageReaction"));
    sent.push(JSON.parse(String(init?.body)).reaction[0]?.emoji ?? "none");
    if (sent.length === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ ok: true, result: true });
  });
  f.bridge = new TelegramBridge(f.hive, cfg);
  insertRow(f.hive, "telegram_out", {
    bot_key: telegramConfigKey(cfg), telegram_chat_id: -1001, telegram_message_id: 10, seq: original.seq, channel_id: original.channelId, thread_id: null,
  });
  f.bridge.start();
  f.hive.toggleReaction(human, original.seq, "👍"); await until(() => Boolean(release));
  f.hive.toggleReaction(human, original.seq, "👍"); f.hive.toggleReaction(human, original.seq, "👀");
  release(Response.json({ ok: true, result: true })); await flush();
  assert.ok(hasRow(f.hive, "telegram_pending", { seq: original.seq }));
  t.mock.timers.tick(1000); await until(() => sent.length === 2);
  assert.deepEqual(sent, ["👍", "👀"]);
});

test("route removal and restoration cannot revive cancelled outbound or inbound history", t => {
  const f = fixture(t); const human = f.hive.getAgent("human");
  const m = f.hive.postMessage(human, { channel: "general", body: "original audience" });
  f.bridge = new TelegramBridge(f.hive, cfg);
  const destination = { botKey: telegramConfigKey(cfg), chatId: -1001 };
  enqueueTelegramPending(f.hive.db, m.seq, "message", undefined, destination);
  recordTelegramUpdateFailure(f.hive.db, { ...destination, projectId: f.hive.findProjectBySlug("chapter")!.id },
    { update_id: 4, message: { message_id: 40, chat: { id: -1001 }, from: { id: 1 }, text: "old input" } }, "temporary");
  f.bridge = new TelegramBridge(f.hive, { ...cfg, groups: { chapter: -1002 } });
  assert.equal(f.hive.telegramFailureCount(), 1);
  f.bridge = new TelegramBridge(f.hive, cfg);
  assert.throws(() => f.hive.retryTelegramFailure(f.hive.telegramFailures()[0]!.id, () => destination), /invalidated/);
  const inbound = f.hive.telegramQuarantine()[0]!;
  assert.equal(inbound.replayable, false);
  assert.throws(() => f.hive.retryTelegramUpdate(inbound.id, () => true), /original bot/);
});

test("legacy configuration validation rejects duplicate ownership and non-integer users", t => {
  const f = fixture(t);
  for (const extra of [{ groupChatId: -1001, projects: { other: -1001 } }, { allowUserIds: [1.5] }, { projects: { chapter: 0 } }, { projects: [] }]) {
    writeFileSync(path.join(f.dir, "telegram.json"), JSON.stringify({ botToken: "x", allowUserIds: [1], ...extra }));
    assert.equal(readTelegramFile(f.dir), null);
  }
  assert.equal(projectSlugForChat({ ...cfg, groups: { chapter: -1001, other: -1001 } }, -1001), undefined);
});

test("raw reload captures both messages and reactions while the old poller drains", async t => {
  const f = fixture(t);
  writeTelegramFile({ botToken: cfg.botToken, allowUserIds: [1], projects: cfg.groups }, f.dir);
  const human = f.hive.getAgent("human");
  const root = f.hive.postMessage(human, { channel: "general", body: "root" });
  let release!: (response: Response) => void, oldSignal: AbortSignal | null | undefined;
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) {
      if (++polls === 1) { oldSignal = init?.signal; return new Promise<Response>(resolve => { release = resolve; }); }
      return blocked(init?.signal);
    }
    return Response.json({ ok: true, result: { message_id: 90 } });
  });
  const handle = startTelegram(f.hive);
  try {
    const reload = handle.reload(); await until(() => Boolean(oldSignal?.aborted));
    const m = f.hive.postMessage(human, { channel: "general", body: "during drain" });
    f.hive.toggleReaction(human, root.seq, "👍");
    assert.ok(hasRow(f.hive, "telegram_pending", { seq: m.seq, kind: "message" }));
    assert.ok(hasRow(f.hive, "telegram_pending", { seq: root.seq, kind: "reaction" }));
    release(Response.json({ ok: true, result: [] })); await reload;
    assert.equal(polls, 2);
  } finally { await handle.stop(); }
});

test("failed bot verification preserves a running bridge and its original configuration", async t => {
  const f = fixture(t); writeTelegramFile({ botToken: cfg.botToken, allowUserIds: [1], projects: cfg.groups }, f.dir);
  let active = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getMe")) return Response.json({ ok: false }, { status: 401 });
    active++;
    try { return await blocked(init?.signal); } finally { active--; }
  });
  const handle = startTelegram(f.hive);
  const before = readFileSync(path.join(f.dir, "telegram.json"), "utf8");
  try {
    await assert.rejects(handle.configure({ botToken: "invalid", allowUserIds: [1], projects: cfg.groups }), /previous configuration unchanged/);
    assert.equal(readFileSync(path.join(f.dir, "telegram.json"), "utf8"), before);
    assert.equal(handle.running(), true); assert.equal(active, 1);
  } finally { await handle.stop(); }
  assert.equal(active, 0);
});

test("Retry-After accepts seconds and HTTP dates, rejects malformed fields and never schedules a busy loop", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  assert.equal(telegramRetryAfterMs(429, {}, 2000, "30"), 30_000);
  assert.equal(telegramRetryAfterMs(429, {}, 2000, new Date(130_000).toUTCString()), 30_000);
  assert.equal(telegramRetryAfterMs(429, { parameters: { retry_after: 60 } }, 2000, "30"), 60_000);
  for (const raw of [null, false, {}, -1, Infinity]) assert.equal(telegramRetryAfterMs(429, { parameters: { retry_after: raw } }), 2000);
  assert.equal(telegramRetryAfterMs(429, { parameters: { retry_after: 0 } }), 1000);
});
