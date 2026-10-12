import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, MIGRATIONS } from "./index.ts";

test("the thread-author index keeps the messages and answers For you's thread reason with one seek", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(readFileSync(new URL("../fixtures/storage/main-populated-v2.sql", import.meta.url), "utf8"));
  const version = MIGRATIONS.find(m => m.name === "message_thread_author_index")!.version;
  applyMigrations(db, { target: version - 1 });
  const before = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ["message_thread_author_index"]);
  assert.deepEqual(db.prepare("SELECT * FROM messages ORDER BY seq").all(), before);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM messages m WHERE m.thread_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM messages p WHERE p.thread_id = m.thread_id AND p.author_id = ? AND p.seq < m.seq)`).all("human");
  assert.match(JSON.stringify(plan), /COVERING INDEX idx_messages_thread_author_seq \(thread_id=\? AND author_id=\? AND seq<\?\)/);
  assert.deepEqual(applyMigrations(db, { target: version }), []);
});
