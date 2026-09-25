import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { hasRow, insertRow } from "./test-fixtures.ts";
import { TelegramBridge } from "./telegram.ts";

const CONFIG = { botToken: "fixture", allowUserIds: [1], groups: { acme: -1001 } };

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

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-tx-outbox-"));
  const file = path.join(dir, "hive.db");
  const hives: Hive[] = [];
  const open = () => { const hive = new Hive(file); hives.push(hive); return hive; };
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    sent.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""));
    return Response.json({ ok: true, result: { message_id: 100 + sent.length } });
  });
  t.after(() => {
    for (const hive of hives) try { hive.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, sent };
}

/** The process dies right after COMMIT: no post-commit effect (bus event, pump wake) ever runs. */
function crashAfterCommit(t: TestContext, hive: Hive) {
  t.mock.method(hive.storage as unknown as { flush(): void }, "flush", function (this: { effects: unknown[] }) {
    this.effects.length = 0;
  });
}

test("the Telegram outbox row commits with the message, so a crash right after commit loses no delivery", async t => {
  const { file, open, sent } = fixture(t);
  const first = open();
  const bridge = new TelegramBridge(first, CONFIG);
  bridge.start();
  for (let turn = 0; turn < 20; turn++) await nextTurn(); // let the empty startup pump settle
  crashAfterCommit(t, first);
  const message = first.messages.postMessage(first.identity.getAgent("human"), { channel: "general", body: "survives the crash" });

  // Durable before any post-commit code could run: another connection already sees the job.
  const observer = new DatabaseSync(file);
  try {
    assert.ok(observer.prepare("SELECT 1 FROM telegram_pending WHERE seq = ? AND kind = 'message'").get(message.seq));
  } finally { observer.close(); }
  for (let turn = 0; turn < 20; turn++) await nextTurn();
  assert.deepEqual(sent, [], "the crashed process never woke its pump");
  await bridge.stop();
  first.close();

  // Restart: the new bridge's startup pump delivers the committed job.
  const second = open();
  const restarted = new TelegramBridge(second, CONFIG);
  restarted.start();
  try {
    await until(() => hasRow(second, "telegram_out", { seq: message.seq }));
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /survives the crash/);
    assert.equal(hasRow(second, "telegram_pending", { seq: message.seq }), false);
  } finally { await restarted.stop(); }
});

test("a rolled-back send leaves no Telegram job behind", async t => {
  const { open } = fixture(t);
  const hive = open();
  const bridge = new TelegramBridge(hive, CONFIG);
  bridge.start();
  try {
    let seq = 0;
    assert.throws(() => hive.storage.transaction(() => {
      seq = hive.messages.postMessage(hive.identity.getAgent("human"), { channel: "general", body: "never committed" }).seq;
      assert.ok(hasRow(hive, "telegram_pending", { seq }), "enqueued inside the message transaction");
      throw new Error("abort the send");
    }), /abort the send/);
    assert.equal(hasRow(hive, "telegram_pending", { seq }), false);
  } finally { await bridge.stop(); }
});

test("a failing outbox hook is isolated: the message commits and other hooks and listeners still run", async t => {
  const { open } = fixture(t);
  const hive = open();
  const logged = t.mock.method(console, "error", () => undefined);
  const hooks: string[] = [];
  const failing = () => {
    insertRow(hive, "telegram_state", { key: "outbox:test_partial", value: "x" });
    throw new Error("hook failed");
  };
  const healthy = ({ seq }: { seq: number }) => { hooks.push(`hook ${seq}`); };
  const listener = (message: { seq: number }) => { hooks.push(`event ${message.seq}`); };
  hive.bus.onOutbox("message", failing);
  hive.bus.onOutbox("message", healthy);
  hive.bus.on("message", listener);
  t.after(() => { hive.bus.offOutbox("message", failing); hive.bus.offOutbox("message", healthy); hive.bus.off("message", listener); });

  const message = hive.messages.postMessage(hive.identity.getAgent("human"), { channel: "general", body: "still sent" });
  assert.deepEqual(hooks, [`hook ${message.seq}`, `event ${message.seq}`]);
  assert.ok(hasRow(hive, "messages", { seq: message.seq }));
  assert.equal(hasRow(hive, "telegram_state", { key: "outbox:test_partial" }), false, "the failing hook's own writes roll back");
  assert.ok(logged.mock.calls.some(call => /hook failed/.test(call.arguments.join(" "))));
});
