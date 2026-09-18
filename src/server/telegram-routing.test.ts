import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { TelegramBridge, startTelegram, writeTelegramFile, readTelegramFile, loadTelegramConfig, telegramConfigKey } from "./telegram.ts";
import { enqueueTelegramPending } from "./telegram-outbox.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 5000; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Expected lifecycle progress");
}
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-routing-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  return { hive, dir, close: () => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("invalid or duplicate routes cannot replace the previous config", () => {
  const { dir, close } = fixture();
  try {
    writeTelegramFile({ botToken: "original", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
    const before = readFileSync(path.join(dir, "telegram.json"), "utf8");
    for (const projects of ([{ chapter: -1002, other: -1002 }, { chapter: 0 }, { chapter: 1.2 }, { chapter: "" }] as Array<Record<string, string | number>>)) {
      assert.throws(() => writeTelegramFile({ botToken: "replacement", allowUserIds: [1], projects }, dir));
      assert.equal(readFileSync(path.join(dir, "telegram.json"), "utf8"), before);
    }
  } finally { close(); }
});

test("configuration drains late old topic work before publishing, and never retargets queued old messages", async t => {
  const { hive, dir, close } = fixture();
  writeTelegramFile({ botToken: "fixture", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
  const human = hive.getAgent("human");
  const channel = hive.createChannel(human, { name: "room", type: "private", project: "chapter" });
  let release!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  const sentChats: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 123, is_bot: true } });
    if (method === "getUpdates") return blocked(init?.signal);
    const body = JSON.parse(String(init?.body));
    if (method === "createForumTopic" && body.chat_id === -1001) {
      oldSignal = init?.signal;
      return new Promise<Response>(resolve => { release = resolve; }); // intentionally ignores abort until released
    }
    if (method === "createForumTopic") return Response.json({ ok: true, result: { message_thread_id: 22 } });
    sentChats.push(body.chat_id);
    return Response.json({ ok: true, result: { message_id: sentChats.length } });
  });
  const handle = startTelegram(hive);
  try {
    hive.postMessage(human, { channel: channel.id, body: "old audience" });
    await until(() => Boolean(release));
    const change = handle.configure({ botToken: "fixture", allowUserIds: [1], projects: { chapter: -1002 } });
    await until(() => Boolean(oldSignal?.aborted));
    assert.equal(readTelegramFile(dir)?.projects.chapter, -1001);
    hive.postMessage(human, { channel: channel.id, body: "arrived while draining" });
    release(Response.json({ ok: true, result: { message_thread_id: 11 } }));
    await change;
    await until(() => hive.telegramFailureCount() === 2);
    assert.equal(readTelegramFile(dir)?.projects.chapter, -1002);
    assert.equal(hive.db.prepare("SELECT 1 FROM telegram_topics WHERE telegram_thread_id = 11").get(), undefined);
    assert.equal(sentChats.length, 0);
    hive.postMessage(human, { channel: channel.id, body: "new audience" });
    await until(() => sentChats.length === 1);
    assert.deepEqual(sentChats, [-1002]);
    assert.ok(hive.telegramFailures().every(row => row.telegramChatId === -1001));
  } finally { await handle.stop(); close(); }
});

test("different bots process colliding update and message IDs without inheriting an offset", async t => {
  const { hive, close } = fixture();
  hive.db.prepare("INSERT INTO telegram_state(key,value) VALUES('offset','777')").run();
  const pollOffsets = new Map<string, unknown[]>();
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const token = String(url).includes("/botfirst/") ? "first" : "second";
    const body = JSON.parse(String(init?.body));
    const offsets = pollOffsets.get(token) ?? []; offsets.push(body.offset); pollOffsets.set(token, offsets);
    if (offsets.length === 1) return Response.json({ ok: true, result: [{ update_id: 900, message: { message_id: 7, chat: { id: -1001 }, from: { id: 1 }, text: token } }] });
    return blocked(init?.signal);
  });
  let bridge = new TelegramBridge(hive, { botToken: "first", botId: 1, allowUserIds: [1], groups: { chapter: -1001 } });
  try {
    bridge.start();
    await until(() => (pollOffsets.get("first")?.length ?? 0) >= 2);
    await bridge.stop();
    bridge = new TelegramBridge(hive, { botToken: "second", botId: 2, allowUserIds: [1], groups: { chapter: -1001 } });
    bridge.start();
    await until(() => (pollOffsets.get("second")?.length ?? 0) >= 2);
    assert.equal(pollOffsets.get("first")![0], 777);
    assert.equal(pollOffsets.get("second")![0], undefined);
    assert.equal((hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_out WHERE telegram_message_id = 7").get() as { n: number }).n, 2);
    assert.equal((hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_in WHERE update_id = 900").get() as { n: number }).n, 2);
    const bodies = hive.listMessages(hive.getAgent("human"), "general").messages.map(m => m.body);
    assert.ok(bodies.some(body => body.endsWith("first")) && bodies.some(body => body.endsWith("second")));
  } finally { await bridge.stop(); close(); }
});

test("verified same-bot rotation preserves its namespace and publication failure preserves the prior file", async t => {
  const { hive, dir, close } = fixture();
  writeTelegramFile({ botToken: "original", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
  t.mock.method(globalThis, "fetch", async (url: unknown) => Response.json({ ok: true, result: { id: String(url).includes("different") ? 43 : 42, is_bot: true } }));
  const handle = startTelegram(hive, false);
  try {
    await handle.configure({ botToken: "original", allowUserIds: [1], projects: { chapter: -1001 } });
    const first = telegramConfigKey(loadTelegramConfig(dir)!);
    const message = hive.postMessage(hive.getAgent("human"), { channel: "general", body: "same bot" });
    enqueueTelegramPending(hive.db, message.seq, "message", undefined, { botKey: first, chatId: -1001 });
    await handle.configure({ botToken: "rotated", allowUserIds: [1], projects: { chapter: -1001 } });
    assert.equal(telegramConfigKey(loadTelegramConfig(dir)!), first);
    assert.equal((hive.db.prepare("SELECT bot_key FROM telegram_pending WHERE seq = ?").get(message.seq) as { bot_key: string }).bot_key, first);
    const before = readFileSync(path.join(dir, "telegram.json"), "utf8");
    t.mock.method(fs, "renameSync", () => { throw new Error("fixture publication failure"); }); syncBuiltinESMExports();
    await assert.rejects(handle.configure({ botToken: "different", allowUserIds: [1], projects: { chapter: -1002 } }), /publication failure/);
    assert.equal(readFileSync(path.join(dir, "telegram.json"), "utf8"), before);
    assert.equal(readdirSync(dir).some(file => file.startsWith(".telegram-")), false);
    t.mock.restoreAll(); syncBuiltinESMExports();
    // Restoring the mocked provider is deliberate; no network call is made after this point.
  } finally { await handle.stop(); t.mock.restoreAll(); syncBuiltinESMExports(); close(); }
});
