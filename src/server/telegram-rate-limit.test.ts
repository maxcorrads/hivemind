import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { TelegramBridge } from "./telegram.ts";
import { telegramRetryAfterMs, selectTelegramPendingJob } from "./telegram-rate-limit.ts";

async function flush(turns = 25) { for (let i = 0; i < turns; i++) await nextTurn(); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 5_000; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Expected bridge progress");
}
function blocked(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("actual polling observes the full rate-limit deadline and stop cancels the wait", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-rate-poll-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    polls++;
    if (polls <= 2) return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, { status: 429 });
    return blocked(init?.signal);
  });
  const bridge = new TelegramBridge(hive, { botToken: "fixture", allowUserIds: [1], groups: { chapter: -1001 } });
  bridge.start();
  try {
    await flush();
    assert.equal(polls, 1);
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(polls, 1);
    t.mock.timers.tick(1);
    await until(() => polls === 2);
    await flush();
    await bridge.stop();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(polls, 2);
  } finally { await bridge.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("multipart 429 preserves confirmed parts, serves another chat and resumes on its own deadline", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-rate-parts-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const human = hive.getAgent("human");
  const project = hive.createProject(human, { name: "Other", slug: "other" });
  const other = hive.getChannel("general", project.id);
  const a = await hive.createFileFromBytes(human, { name: "a.txt", mime: "text/plain", bytes: Buffer.from("a") });
  const b = await hive.createFileFromBytes(human, { name: "b.txt", mime: "text/plain", bytes: Buffer.from("b") });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const sent: string[] = [];
  let rateLimited = false;
  let id = 1;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("getUpdates")) return blocked(init?.signal);
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body));
    const chat = body instanceof FormData ? Number(body.get("chat_id")) : body.chat_id;
    const name = body instanceof FormData ? (body.get("document") as File).name : "text";
    sent.push(`${chat}:${name}`);
    if (name === "b.txt" && !rateLimited) {
      rateLimited = true;
      return Response.json({ ok: false, parameters: { retry_after: 30 } }, { status: 429 });
    }
    return Response.json({ ok: true, result: { message_id: id++ } });
  });
  const bridge = new TelegramBridge(hive, { botToken: "fixture", allowUserIds: [1], groups: { chapter: -1001, other: -1002 } });
  bridge.start();
  try {
    hive.postMessage(human, { channel: "general", body: "x".repeat(1100), attachmentIds: [a.id, b.id] });
    hive.postMessage(human, { channel: other.id, body: "unrelated work" });
    await until(() => sent.length === 4);
    assert.deepEqual(sent, ["-1001:text", "-1001:a.txt", "-1001:b.txt", "-1002:text"]);
    t.mock.timers.tick(1_000); // normal inter-job pacing, then earliest cooldown is scheduled
    await flush();
    t.mock.timers.tick(28_999);
    await flush();
    assert.equal(sent.length, 4);
    t.mock.timers.tick(1);
    await until(() => sent.length === 5);
    await flush();
    assert.deepEqual(sent, ["-1001:text", "-1001:a.txt", "-1001:b.txt", "-1002:text", "-1001:b.txt"]);
    assert.equal((hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_pending").get() as { n: number }).n, 0);
  } finally { await bridge.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler exposes earliest deadline and parser rejects malformed retry_after", () => {
  const jobs = [{ seq: 1, kind: "message" as const }, { seq: 2, kind: "message" as const }];
  assert.equal(selectTelegramPendingJob(jobs, seq => seq, chat => chat === 1 ? 40 : 0, 10).job?.seq, 2);
  assert.equal(selectTelegramPendingJob(jobs, seq => seq, chat => chat === 1 ? 40 : 20, 10).wakeAt, 20);
  assert.equal(telegramRetryAfterMs(429, { parameters: { retry_after: 30 } }), 30_000);
  assert.equal(telegramRetryAfterMs(200, { error_code: 429, parameters: { retry_after: 1 } }), 1_000);
  assert.equal(telegramRetryAfterMs(429, { parameters: { retry_after: Infinity } }), 2_000);
  assert.equal(telegramRetryAfterMs(200, {}), null);
});
