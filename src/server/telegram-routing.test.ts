import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { countRows, hasRow, insertRow, readValue, rowsContaining } from "./test-fixtures.ts";
import { TelegramBridge, startTelegram, writeTelegramFile, readTelegramFile, loadTelegramConfig, telegramConfigKey } from "./telegram.ts";
import { enqueueTelegramPending } from "./telegram-outbox.ts";
import { saveAdaptiveRouting } from "./adaptive-config.ts";
import { jevTopologyResponse } from "./fixtures/jev-topology.ts";

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
      return new Promise<Response>(resolve => { release = resolve; });
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
    assert.equal(hasRow(hive, "telegram_topics", { telegram_thread_id: 11 }), false);
    assert.equal(sentChats.length, 0);
    hive.postMessage(human, { channel: channel.id, body: "new audience" });
    await until(() => sentChats.length === 1);
    assert.deepEqual(sentChats, [-1002]);
    assert.ok(hive.telegramFailures().every(row => row.telegramChatId === -1001));
  } finally { await handle.stop(); close(); }
});

test("different bots process colliding update and message IDs without inheriting an offset", async t => {
  const { hive, close } = fixture();
  insertRow(hive, "telegram_state", { key: "offset", value: "777" });
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
    assert.equal(countRows(hive, "telegram_out", { telegram_message_id: 7 }), 2);
    assert.equal(countRows(hive, "telegram_in", { update_id: 900 }), 2);
    const bodies = hive.listMessages(hive.getAgent("human"), "general").messages.map(m => m.body);
    assert.ok(bodies.some(body => body.endsWith("first")) && bodies.some(body => body.endsWith("second")));
  } finally { await bridge.stop(); close(); }
});

test("Telegram Human replies in a brain DM use active Jev routing and keep receipt on the original request", async t => {
  const { hive, dir, close } = fixture();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain", project: "chapter" }).agent;
  const dm = hive.openDm(human, brain.name);
  const cfg = { botToken: "fixture", botId: 77, allowUserIds: [1], groups: { chapter: -1001 } };
  const botKey = telegramConfigKey(cfg);
  const bridge = new TelegramBridge(hive, cfg);
  insertRow(hive, "telegram_topics", { channel_id: dm.id, telegram_thread_id: 22, telegram_chat_id: -1001, bot_key: botKey });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: "typesafe-fixture" });
  let polls = 0, jevCalls = 0;
  const routingRequests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url) === "https://api.typesafe.ai/v1/systemone") {
      jevCalls++;
      const request = JSON.parse(String(init?.body)) as { state?: { request?: string } };
      routingRequests.push(request.state?.request);
      return Response.json(jevTopologyResponse(String(init?.body), "single"));
    }
    const method = String(url).split("/").at(-1);
    if (method === "getUpdates") {
      polls++;
      if (polls === 1) return Response.json({ ok: true, result: [{
        update_id: 901,
        message: { message_id: 88, message_thread_id: 22, chat: { id: -1001 },
          from: { id: 1, first_name: "Matteo" }, text: "Small Telegram request" },
      }] });
      return blocked(init?.signal);
    }
    return Response.json({ ok: true, result: { message_id: 999 } });
  });
  try {
    bridge.start();
    await until(() => jevCalls === 1 && rowsContaining(hive, "messages", "body", "Small Telegram request", "channel_id")
      .filter(row => row.channel_id === dm.id).length === 1);
    const messages = hive.listMessages(human, dm.id).messages.filter(m => m.kind === "chat");
    const original = messages.find(m => m.body.endsWith("Small Telegram request"))!;
    const directive = messages.find(m => m.body.includes("adaptive topology · SINGLE"))!;
    assert.ok(original && directive);
    assert.deepEqual(routingRequests, ["Small Telegram request"], "Sender display name is not classifier context");
    const state = hive.adaptiveTopology.view(human, dm.id).state!;
    assert.equal(state.recommendation?.providerStatus, "ok", "A malformed fixture must not silently pass via fallback");
    assert.equal(state.recommendation?.contractVersion, "adaptive-routing-v2");
    assert.equal(state.currentTopology, "single");
    assert.equal(hive.fromTelegram(original.id), true);
    assert.equal(hive.fromTelegram(directive.id), false);
    assert.equal(readValue(hive, "telegram_out", "seq", { telegram_chat_id: -1001, telegram_message_id: 88, bot_key: botKey }), original.seq);
  } finally {
    await bridge.stop();
    await hive.adaptiveTopology.stop();
    close();
  }
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
    assert.equal(readValue(hive, "telegram_pending", "bot_key", { seq: message.seq }), first);
    const before = readFileSync(path.join(dir, "telegram.json"), "utf8");
    t.mock.method(fs, "renameSync", () => { throw new Error("fixture publication failure"); }); syncBuiltinESMExports();
    await assert.rejects(handle.configure({ botToken: "different", allowUserIds: [1], projects: { chapter: -1002 } }), /publication failure/);
    assert.equal(readFileSync(path.join(dir, "telegram.json"), "utf8"), before);
    assert.equal(readdirSync(dir).some(file => file.startsWith(".telegram-")), false);
    t.mock.restoreAll(); syncBuiltinESMExports();
  } finally { await handle.stop(); t.mock.restoreAll(); syncBuiltinESMExports(); close(); }
});
