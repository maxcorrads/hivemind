import type { DatabaseSync } from "node:sqlite";
import { Storage } from "./storage.ts";

/** Migrate legacy routing once, assigning it to the configuration active at upgrade. */
export function initTelegramRouting(db: DatabaseSync, legacyNamespace: string): void {
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  Storage.for(db).transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_bot_state (
      bot_key TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bot_key, key)
    );
    CREATE TABLE IF NOT EXISTS telegram_bot_identities (
      bot_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS telegram_routing_migrations (version INTEGER PRIMARY KEY);`);
    if (db.prepare("SELECT 1 FROM telegram_routing_migrations WHERE version = 1").get()) {
      if (!columns("telegram_hold").some(c => c.name === "update_id")) db.exec("ALTER TABLE telegram_hold ADD COLUMN update_id INTEGER");
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
      if (columns(table).some(c => c.name === "bot_key")) continue;
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

/** Bind a verified provider identity without moving live state or depending on token spelling. */
export function namespaceForVerifiedBot(db: DatabaseSync, botId: number, preferred?: string): string {
  return Storage.for(db).transaction(() => {
    const found = db.prepare("SELECT namespace FROM telegram_bot_identities WHERE bot_id = ?").get(botId) as { namespace: string } | undefined;
    if (found) return found.namespace;
    const namespace = preferred ?? `bot:${botId}`;
    db.prepare("INSERT INTO telegram_bot_identities(bot_id, namespace) VALUES(?, ?)").run(botId, namespace);
    return namespace;
  });
}
