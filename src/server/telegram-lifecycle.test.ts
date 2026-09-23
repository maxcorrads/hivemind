import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { CoalescingPump } from "./coalescing-pump.ts";
import { Hive } from "./hive.ts";
import { hasRow } from "./test-fixtures.ts";
import { startServer } from "./serve.ts";
import { TelegramBridge, startTelegram, writeTelegramFile } from "./telegram.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-lifecycle-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { hive, dir };
}
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 500; turn++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("Operation did not make progress");
}

test("coalesced pump retains a wake during completion and does not spin when idle", async () => {
  const queue: number[] = [];
  const sent: number[] = [];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pump = new CoalescingPump(async () => {
    calls++;
    if (calls === 1) await gate;
    sent.push(...queue.splice(0));
  }, error => { throw error; });
  pump.wake();
  await nextTurn();
  queue.push(1);
  pump.wake();
  release();
  await until(() => sent.length === 1);
  const settledCalls = calls;
  await nextTurn();
  assert.equal(calls, settledCalls);
  queue.push(2);
  pump.wake();
  await until(() => sent.length === 2);
  await pump.stop();
  assert.deepEqual(sent, [1, 2]);
});

test("real bridge sends a job queued in the same turn as empty startup", async t => {
  const { hive } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    assert.ok(String(url).endsWith("sendMessage"));
    calls++;
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  const bridge = new TelegramBridge(hive, { botToken: "fixture", allowUserIds: [1], groups: { chapter: -1001 } });
  bridge.start();
  const message = hive.postMessage(hive.getAgent("human"), { channel: "general", body: "startup work" });
  try {
    await until(() => hasRow(hive, "telegram_out", { seq: message.seq }));
    assert.equal(calls, 1);
    assert.equal(hasRow(hive, "telegram_pending", { seq: message.seq }), false);
  } finally { await bridge.stop(); }
});

test("stop drains a delayed old topic response without restoring a mapping or consuming its job", async t => {
  const { hive } = fixture(t);
  const human = hive.getAgent("human");
  const channel = hive.createChannel(human, { name: "delayed", type: "private", project: "chapter" });
  let release!: (response: Response) => void;
  let topicStarted = false;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    assert.ok(String(url).endsWith("createForumTopic"));
    topicStarted = true;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const bridge = new TelegramBridge(hive, { botToken: "fixture", allowUserIds: [1], groups: { chapter: -1001 } });
  bridge.start();
  const message = hive.postMessage(human, { channel: channel.id, body: "pending" });
  await until(() => topicStarted);
  const stopped = bridge.stop();
  release(Response.json({ ok: true, result: { message_thread_id: 17 } }));
  await stopped;
  assert.equal(hasRow(hive, "telegram_topics", { channel_id: channel.id }), false);
  assert.ok(hasRow(hive, "telegram_pending", { seq: message.seq }));
});

test("serialized reload never overlaps polling generations", async t => {
  const { hive, dir } = fixture(t);
  writeTelegramFile({ botToken: "fixture", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
  let active = 0;
  let maxActive = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try { return await blocked(init?.signal); } finally { active--; }
  });
  const handle = startTelegram(hive);
  await Promise.all([handle.reload(), handle.reload()]);
  await handle.stop();
  assert.equal(active, 0);
  assert.equal(maxActive, 1);
});

test("shutdown fences new admission and keeps a caller-owned Hive usable", async t => {
  const { hive } = fixture(t);
  const started = startServer({ port: 0, hive, telegram: false, shutdownGraceMs: 100 });
  const port = await started.ready;
  const shuttingDown = started.shutdown();
  const duplicate = started.shutdown();
  assert.equal(shuttingDown, duplicate);
  await shuttingDown;
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/ui/snapshot`));
  assert.equal(hive.getAgent("human").role, "human");
});

test("shutdown deadline bounds an abort-ignoring bridge and closes remaining sockets", async t => {
  const { hive, dir } = fixture(t);
  writeTelegramFile({ botToken: "fixture", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(resolve => { release = resolve; }));
  const started = startServer({ port: 0, hive, shutdownGraceMs: 50 });
  const port = await started.ready;
  await until(() => Boolean(release));
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write("GET /api/ui/snapshot HTTP/1.1\r\nHost: localhost\r\n");
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // An incomplete HTTP header may be closed immediately by Node's idle cleanup.
    // The controlled poll response, not OS socket scheduling, forces the deadline path.
    const shuttingDown = started.shutdown();
    const rejected = assert.rejects(shuttingDown, /deadline/);
    let settled = false;
    void shuttingDown.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(49);
    await nextTurn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
    await closed;
    assert.equal(hive.getAgent("human").role, "human");
  } finally {
    release(Response.json({ ok: true, result: [] }));
    socket.destroy();
    await started.shutdown().catch(() => undefined);
    for (let i = 0; i < 10; i++) await nextTurn();
  }
});
