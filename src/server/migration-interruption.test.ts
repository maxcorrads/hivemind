import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hive } from "./hive.ts";

type FaultPoint = "hold" | "out" | "topics";

function createLegacyFixture(dbPath: string, fault: FaultPoint) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      seniority TEXT,
      focus TEXT,
      token_hash TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      inbox_cursor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE telegram_hold (
      telegram_message_id INTEGER PRIMARY KEY,
      telegram_thread_id INTEGER NOT NULL,
      payload TEXT
    );
    CREATE TABLE telegram_out (
      telegram_message_id INTEGER PRIMARY KEY,
      seq INTEGER,
      channel_id TEXT NOT NULL,
      thread_id TEXT
    );
    CREATE TABLE telegram_topics (
      channel_id TEXT,
      telegram_thread_id INTEGER NOT NULL
    );
  `);

  db.prepare("INSERT INTO telegram_hold VALUES (?, ?, ?)").run(
    7,
    11,
    fault === "hold" ? null : JSON.stringify({ fixture: "hold" }),
  );
  db.prepare("INSERT INTO telegram_out VALUES (?, ?, ?, ?)").run(
    8,
    fault === "out" ? null : 1,
    "general",
    null,
  );
  db.prepare("INSERT INTO telegram_topics VALUES (?, ?)").run("general", 13);
  if (fault === "topics") {
    db.prepare("INSERT INTO telegram_topics VALUES (?, ?)").run("general", 14);
  }
  db.close();
}

function tableSql(db: DatabaseSync, table: string): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { sql: string }
      | undefined
  )?.sql ?? "";
}

for (const fault of ["hold", "out", "topics"] as const) {
  test(`project migration rolls back a controlled ${fault} rebuild failure and is retryable`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `hive-migration-${fault}-`));
    const dbPath = path.join(dir, "hive.db");
    createLegacyFixture(dbPath, fault);

    assert.throws(() => new Hive(dbPath));

    const afterFailure = new DatabaseSync(dbPath);
    try {
      assert.equal(
        (afterFailure.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        0,
      );
      assert.equal(tableSql(afterFailure, "telegram_hold").includes("telegram_chat_id"), false);
      assert.equal(tableSql(afterFailure, "telegram_out").includes("telegram_chat_id"), false);
      assert.equal(tableSql(afterFailure, "telegram_topics").includes("telegram_chat_id"), false);
      assert.equal(
        (afterFailure.prepare("SELECT COUNT(*) AS n FROM telegram_hold").get() as { n: number }).n,
        1,
      );
      assert.equal(
        (afterFailure.prepare("SELECT COUNT(*) AS n FROM telegram_out").get() as { n: number }).n,
        1,
      );
      assert.equal(
        (afterFailure.prepare("SELECT COUNT(*) AS n FROM telegram_topics").get() as { n: number }).n,
        fault === "topics" ? 2 : 1,
      );
      const agentColumns = afterFailure.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
      const channelColumns = afterFailure.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
      assert.equal(agentColumns.some((column) => column.name === "project_id"), false);
      assert.equal(channelColumns.some((column) => column.name === "project_id"), false);

      if (fault === "hold") {
        afterFailure.prepare("UPDATE telegram_hold SET payload = ? WHERE telegram_message_id = 7").run("{}");
      } else if (fault === "out") {
        afterFailure.prepare("UPDATE telegram_out SET seq = 1 WHERE telegram_message_id = 8").run();
      } else {
        afterFailure.prepare(
          "DELETE FROM telegram_topics WHERE rowid NOT IN (SELECT MIN(rowid) FROM telegram_topics GROUP BY channel_id)",
        ).run();
      }
    } finally {
      afterFailure.close();
    }

    const migrated = new Hive(dbPath);
    try {
      assert.equal(
        (migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        2,
      );
      for (const table of ["telegram_hold", "telegram_out", "telegram_topics"]) {
        assert.equal(tableSql(migrated.db, table).includes("telegram_chat_id"), true, table);
      }
      assert.equal(
        (migrated.db.prepare("SELECT COUNT(*) AS n FROM telegram_hold").get() as { n: number }).n,
        1,
      );
      assert.equal(
        (migrated.db.prepare("SELECT COUNT(*) AS n FROM telegram_out").get() as { n: number }).n,
        1,
      );
      assert.equal(
        (migrated.db.prepare("SELECT COUNT(*) AS n FROM telegram_topics").get() as { n: number }).n,
        1,
      );
      assert.equal(
        (migrated.db.prepare("SELECT telegram_chat_id AS id FROM telegram_out").get() as { id: number }).id,
        0,
      );
    } finally {
      migrated.db.close();
    }

    const repeated = new Hive(dbPath);
    repeated.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
