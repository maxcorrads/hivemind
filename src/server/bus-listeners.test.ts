import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { HIVE_BUS_MAX_LISTENERS, type HiveEvents } from "./hive-events.ts";
import { startServer } from "./serve.ts";
import { startTelegram, writeTelegramFile } from "./telegram.ts";

const CYCLES = HIVE_BUS_MAX_LISTENERS + 2;
const EVENTS: Array<keyof HiveEvents> = [
  "message", "activity", "agent", "channel", "thread", "reaction", "queued", "project", "telegram-health",
  "telegram-inbox-wake", "telegram-outbox-wake", "task", "room", "adaptive-routing", "jev-call", "evidence-health",
];

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-bus-listeners-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  writeTelegramFile({ botToken: "fixture", allowUserIds: [1], projects: { acme: -1001 } }, dir);
  // Telegram polls block until the bridge aborts them, so every bridge stays live until stop().
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message); };
  process.on("warning", onWarning);
  t.after(() => { process.off("warning", onWarning); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const peak = () => Math.max(...EVENTS.map(event => hive.bus.listenerCount(event)));
  return { hive, warnings, peak };
}

test("the Hive bus keeps a small listener budget", t => {
  const { hive } = fixture(t);
  assert.equal(hive.bus.getMaxListeners(), HIVE_BUS_MAX_LISTENERS);
  assert.ok(HIVE_BUS_MAX_LISTENERS <= 16, "a large cap would hide leaked subscribers");
});

test("repeated server start/stop on one Hive leaves no bus listeners behind", async t => {
  const { hive, warnings, peak } = fixture(t);
  const baseline = hive.bus.totalListenerCount();
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const started = startServer({ port: 0, hive, shutdownGraceMs: 1_000 });
    await started.ready;
    // Web socket fan-out subscribes after commit; the Telegram bridge enqueues through the outbox hook.
    assert.equal(hive.bus.listenerCount("message"), 1);
    assert.equal(hive.bus.outboxListenerCount("message"), 1);
    assert.ok(peak() <= 2, `cycle ${cycle}: peak ${peak()}`);
    await started.shutdown();
    assert.equal(hive.bus.totalListenerCount(), baseline, `cycle ${cycle} leaked a listener`);
  }
  assert.deepEqual(warnings, []);
});

test("repeated Telegram reloads replace the bridge's subscriptions instead of stacking them", async t => {
  const { hive, warnings, peak } = fixture(t);
  const baseline = hive.bus.totalListenerCount();
  const handle = startTelegram(hive);
  assert.ok(handle.running());
  const running = hive.bus.totalListenerCount();
  assert.ok(running > baseline);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    await handle.reload();
    assert.ok(handle.running());
    assert.equal(hive.bus.totalListenerCount(), running, `reload ${cycle} leaked a listener`);
    assert.ok(peak() <= 1);
  }
  await handle.stop();
  assert.equal(hive.bus.totalListenerCount(), baseline);
  assert.deepEqual(warnings, []);
});
