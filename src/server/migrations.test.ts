import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hive } from "./hive.ts";

test("legacy Telegram mappings survive atomic project migration and repeated startup", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-migrate-"));
  const dbPath = path.join(dir, "hive.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, seniority TEXT, focus TEXT,
      token_hash TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, inbox_cursor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, topic TEXT,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, channel_id TEXT NOT NULL,
      thread_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat',
      control TEXT, mentions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    CREATE TABLE telegram_hold (
      telegram_message_id INTEGER PRIMARY KEY, telegram_thread_id INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE telegram_out (
      telegram_message_id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT
    );
    CREATE TABLE telegram_topics (
      channel_id TEXT PRIMARY KEY, telegram_thread_id INTEGER NOT NULL UNIQUE
    );
  `);
  db.prepare("INSERT INTO telegram_hold VALUES (?, ?, ?)").run(7, 11, "{}");
  db.prepare("INSERT INTO telegram_out VALUES (?, ?, ?, ?)").run(8, 1, "general", null);
  db.prepare("INSERT INTO telegram_topics VALUES (?, ?)").run("general", 13);
  db.close();

  const first = new Hive(dbPath);
  assert.equal((first.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  assert.equal((first.db.prepare("SELECT COUNT(*) AS n FROM telegram_hold").get() as { n: number }).n, 1);
  assert.equal((first.db.prepare("SELECT COUNT(*) AS n FROM telegram_out").get() as { n: number }).n, 1);
  assert.equal((first.db.prepare("SELECT COUNT(*) AS n FROM telegram_topics").get() as { n: number }).n, 1);
  first.db.close();

  const second = new Hive(dbPath);
  assert.equal((second.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM telegram_hold").get() as { n: number }).n, 1);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM telegram_out").get() as { n: number }).n, 1);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM telegram_topics").get() as { n: number }).n, 1);
  second.db.close();

  rmSync(dir, { recursive: true, force: true });
});
