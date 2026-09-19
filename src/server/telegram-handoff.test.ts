import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { startTelegram, writeTelegramFile } from "./telegram.ts";

function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Handoff did not make progress");
}
async function flush() { for (let i = 0; i < 30; i++) await nextTurn(); }
function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-handoff-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  hive.createProject(hive.getAgent("human"), { name: "Other", slug: "other" });
  writeTelegramFile({ botToken: "handoff-fixture", allowUserIds: [1], projects: { chapter: -1001 } }, dir);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const batch = [
    { update_id: 1, message: { message_id: 101, chat: { id: -1001 }, from: { id: 1 }, document: { file_id: "document", file_name: "a.txt", mime_type: "text/plain" } } },
    { update_id: 2, message: { message_id: 102, chat: { id: -1001 }, from: { id: 1 }, text: "original project's decision" } },
  ];
  const calls = { polls: 0, files: 0 };
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getMe")) return Response.json({ ok: true, result: { id: 42, is_bot: true } });
    if (String(url).endsWith("getUpdates")) {
      // A duplicate batch from the replacement poller must not adopt its new audience.
      if (++calls.polls <= 2) return Response.json({ ok: true, result: batch });
      return blocked(init?.signal);
    }
    if (String(url).endsWith("getFile")) {
      if (++calls.files === 1) return blocked(init?.signal);
      return Response.json({ ok: true, result: { file_path: "file/a.txt", file_size: 3 } });
    }
    assert.ok(String(url).includes("/file/bot"), `Unexpected external method: ${String(url)}`);
    return new Response("abc");
  });
  const handle = startTelegram(hive);
  t.after(async () => { await handle.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const receipts = () => (hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_out WHERE telegram_message_id IN (101, 102)").get() as { n: number }).n;
  return { dir, hive, handle, calls, receipts };
}

test("remap during an accepted batch preserves the original project of its entire unfinished remainder", async t => {
  const f = setup(t);
  const originalProject = f.hive.findProjectBySlug("chapter")!.id;
  await until(() => f.calls.files === 1);
  await f.handle.configure({ allowUserIds: [1], projects: { other: -1001 } });
  await until(() => f.calls.polls >= 2); await flush();
  const rows = f.hive.db.prepare("SELECT project_id, update_id, state, invalidated FROM telegram_update_failures ORDER BY update_id").all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { project_id: originalProject, update_id: 1, state: "quarantined", invalidated: 1 },
    { project_id: originalProject, update_id: 2, state: "quarantined", invalidated: 1 },
  ]);
  assert.equal(f.receipts(), 0);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.calls.files, 1);
  assert.equal(f.receipts(), 0);
  assert.equal((f.hive.db.prepare("SELECT value FROM telegram_bot_state WHERE key = 'offset'").get() as { value: string }).value, "3");
});

test("same-route reload resumes an interrupted accepted batch once, without new traffic", async t => {
  const f = setup(t);
  await until(() => f.calls.files === 1);
  await f.handle.reload(); await flush();
  assert.equal(f.receipts(), 0);
  t.mock.timers.tick(999); await flush();
  assert.equal(f.calls.files, 1);
  t.mock.timers.tick(1);
  await until(() => f.receipts() === 2);
  assert.equal(f.calls.files, 2);
  assert.equal((f.hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_update_failures WHERE state = 'resolved'").get() as { n: number }).n, 2);
  await f.handle.reload(); t.mock.timers.tick(10_000); await flush();
  assert.equal(f.receipts(), 2); assert.equal(f.calls.files, 2);
});

test("failure on the second handoff record rolls back the whole batch and blocks new configuration publication", async t => {
  const f = setup(t);
  await until(() => f.calls.files === 1);
  const original = readFileSync(path.join(f.dir, "telegram.json"), "utf8");
  f.hive.db.exec("CREATE TEMP TRIGGER fail_handoff AFTER INSERT ON telegram_update_failures WHEN NEW.update_id = 2 BEGIN SELECT RAISE(ABORT, 'handoff storage failure'); END");
  // Hold the replacement's next poll until the assertions have observed the rollback.
  f.calls.polls = 2;
  await assert.rejects(f.handle.configure({ allowUserIds: [1], projects: { other: -1001 } }), /drain could not persist/);
  assert.equal(readFileSync(path.join(f.dir, "telegram.json"), "utf8"), original);
  assert.equal(f.hive.db.prepare("SELECT 1 FROM telegram_update_failures").get(), undefined);
  assert.equal(f.hive.db.prepare("SELECT 1 FROM telegram_in").get(), undefined);
  assert.equal(f.hive.db.prepare("SELECT 1 FROM telegram_bot_state WHERE key = 'offset'").get(), undefined);
  assert.equal(f.receipts(), 0);
  assert.equal(f.handle.running(), true);
  f.hive.db.exec("DROP TRIGGER fail_handoff");
});
