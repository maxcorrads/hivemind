import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TelegramBridge, writeTelegramFile } from "./telegram.ts";
import { startServer } from "./serve.ts";

test("a completed drain error remains visible but does not leak the server-owned database", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-owned-shutdown-"));
  const previousHome = process.env.HIVEMIND_HOME;
  process.env.HIVEMIND_HOME = dir;
  writeTelegramFile({ botToken: "shutdown-fixture", allowUserIds: [1], projects: { acme: -1001 } }, dir);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const originalStop = TelegramBridge.prototype.stop;
  t.mock.method(TelegramBridge.prototype, "stop", async function(this: TelegramBridge) {
    await originalStop.call(this);
    throw new Error("injected completed drain error");
  });
  const started = startServer({ port: 0 });
  t.after(async () => {
    await started.shutdown().catch(() => undefined);
    try { started.hive.db.close(); } catch { /* already closed */ }
    if (previousHome === undefined) delete process.env.HIVEMIND_HOME;
    else process.env.HIVEMIND_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  await started.ready;
  await assert.rejects(started.shutdown(), /injected completed drain error/);
  assert.equal(started.server.listening, false);
  assert.throws(() => started.hive.db.prepare("SELECT 1"), /not open/); // schema-level assertion: connection is closed
});
