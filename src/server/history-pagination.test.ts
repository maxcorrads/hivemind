import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";

test("thread history pages both ways through gaps and rejects conflicting cursors", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-history-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent("human");
  const root = hive.postMessage(human, { channel: "general", body: "root" });
  const expected = [root.seq];
  for (let i = 0; i < 215; i++) {
    expected.push(hive.postMessage(human, { channel: "general", threadId: root.id, body: `reply ${i}` }).seq);
    hive.postMessage(human, { channel: "general", body: `unrelated ${i}` });
  }
  const actual: number[] = [];
  let after: number | undefined;
  for (let pages = 0; pages < 30; pages++) {
    const page = hive.listMessages(human, "general", { threadId: root.id, afterSeq: after, limit: 17 });
    actual.push(...page.messages.map(m => m.seq));
    if (!page.hasNewer) break;
    after = page.cursors.after;
  }
  assert.deepEqual(actual, expected);
  assert.equal(hive.listMessages(human, "general", { beforeSeq: 0 }).messages.length, 0);
  const backwards: number[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (let pages = 0; pages < 30; pages++) {
    const page = hive.listMessages(human, "general", { threadId: root.id, beforeSeq: before, limit: 19 });
    backwards.unshift(...page.messages.map(m => m.seq));
    if (!page.hasOlder) break;
    before = page.cursors.before!;
  }
  assert.deepEqual(backwards, expected);
  assert.throws(() => hive.listMessages(human, "general", { afterSeq: 0, beforeSeq: 10 }), /not both/);
  for (const invalid of [NaN, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => hive.listMessages(human, "general", { afterSeq: invalid }), /safe integer/);
  }
  const plan = hive.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM messages WHERE channel_id = ? AND thread_id = ? AND seq > ? LIMIT 1")
    .all("general", root.id, root.seq) as { detail: string }[];
  assert.ok(plan.some(row => row.detail.includes("idx_messages_channel_thread_seq")));
  assert.equal(plan.some(row => /SCAN messages/.test(row.detail)), false);
});
