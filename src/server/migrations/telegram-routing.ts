import type { DatabaseSync } from "node:sqlite";
import { Storage } from "../storage.ts";
import { hasColumn } from "./schema.ts";

/**
 * Deferred, parameterized migration: legacy Telegram routing rows are assigned to
 * the bot namespace that is active when the bridge first starts after the upgrade,
 * which startup cannot know. The Telegram bridge runs it on start; it keeps its own
 * marker table (`telegram_routing_migrations`) and is idempotent. Validation accepts
 * both the unrouted (baseline) and the routed table shapes.
 */
export function initTelegramRouting(db: DatabaseSync, legacyNamespace: string): void {
  Storage.for(db).transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_bot_state (
      bot_key TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bot_key, key)
    );
    CREATE TABLE IF NOT EXISTS telegram_bot_identities (
      bot_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS telegram_routing_migrations (version INTEGER PRIMARY KEY);`);
    if (db.prepare("SELECT 1 FROM telegram_routing_migrations WHERE version = 1").get()) {
      if (!hasColumn(db, "telegram_hold", "update_id")) db.exec("ALTER TABLE telegram_hold ADD COLUMN update_id INTEGER");
      return;
    }
    const shapes = {
      telegram_in: {
        fields: "update_id", sql: "update_id INTEGER NOT NULL, PRIMARY KEY (bot_key, update_id)",
      },
      telegram_topics: {
        fields: "channel_id, telegram_thread_id, telegram_chat_id",
        sql: "channel_id TEXT NOT NULL, telegram_thread_id INTEGER NOT NULL, telegram_chat_id INTEGER, PRIMARY KEY(bot_key, channel_id)",
      },
      telegram_out: {
        fields: "telegram_chat_id, telegram_message_id, seq, channel_id, thread_id",
        sql: "telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, seq INTEGER NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, PRIMARY KEY(bot_key, telegram_chat_id, telegram_message_id)",
      },
      telegram_hold: {
        fields: "telegram_chat_id, telegram_message_id, telegram_thread_id, payload",
        sql: "telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, telegram_thread_id INTEGER NOT NULL, payload TEXT NOT NULL, project_id TEXT, update_id INTEGER, PRIMARY KEY(bot_key, telegram_chat_id, telegram_message_id)",
      },
    };
    for (const [table, shape] of Object.entries(shapes)) {
      if (hasColumn(db, table, "bot_key")) continue;
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy_route;
        CREATE TABLE ${table} (bot_key TEXT NOT NULL, ${shape.sql});`);
      db.prepare(`INSERT INTO ${table} (bot_key, ${shape.fields}) SELECT ?, ${shape.fields} FROM ${table}_legacy_route`).run(legacyNamespace);
      db.exec(`DROP TABLE ${table}_legacy_route`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_telegram_out_seq ON telegram_out(seq)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_telegram_topics_namespace_topic ON telegram_topics(bot_key, telegram_chat_id, telegram_thread_id)");
    db.prepare(`INSERT OR IGNORE INTO telegram_bot_state(bot_key, key, value)
      SELECT ?, key, value FROM telegram_state WHERE key NOT LIKE 'outbox:%'`).run(legacyNamespace);
    db.prepare("INSERT INTO telegram_routing_migrations(version) VALUES(1)").run();
  });
}
