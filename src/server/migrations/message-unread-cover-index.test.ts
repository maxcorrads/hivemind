import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, MIGRATIONS } from "./index.ts";

test("the unread cover index keeps the messages and lets the unread walk stay inside it", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(readFileSync(new URL("../fixtures/storage/main-populated-v2.sql", import.meta.url), "utf8"));
  const version = MIGRATIONS.find(m => m.name === "message_unread_cover_index")!.version;
  applyMigrations(db, { target: version - 1 });
  const before = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ["message_unread_cover_index"]);
  assert.deepEqual(db.prepare("SELECT * FROM messages ORDER BY seq").all(), before);
  // ReadState.counts: the unread messages of the visible channels, per channel.
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.channel_id, COUNT(*) FROM messages m
    LEFT JOIN reads r ON r.agent_id = ? AND r.channel_id = m.channel_id
    LEFT JOIN message_reads seen ON seen.agent_id = ? AND seen.message_id = m.id
    WHERE m.channel_id IN (?, ?) AND m.author_id != ? AND m.seq > COALESCE(r.last_read_seq, 0) AND seen.message_id IS NULL
    GROUP BY m.channel_id`).all("human", "human", "general", "brains", "human");
  assert.match(JSON.stringify(plan), /COVERING INDEX idx_messages_unread_cover/);
  assert.deepEqual(applyMigrations(db, { target: version }), []);
});
