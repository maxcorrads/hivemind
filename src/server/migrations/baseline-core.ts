import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG, HUMAN_ID } from "../../shared/types.ts";
import { hasColumn, hasUniqueKey, primaryKey, rebuild, requireKey, requireShape } from "./schema.ts";
import { validateCoreStorage } from "./validate.ts";

// Baseline migrations: every one of them must stay idempotent and state-detecting,
// because legacy databases (user_version 0 or 2) may be in any historical state and
// re-run the whole baseline. They reproduce, in order, what startup used to do ad hoc.

/** The original core tables (created by Hive before versioned migrations existed). */
export function coreTables(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
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
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        control TEXT,
        mentions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS reads (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS bot_events (
        message_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        event_id TEXT NOT NULL,
        metadata TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        UNIQUE (bot_id, channel_id, thread_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_thread_seq ON messages(channel_id, thread_id, seq);
      CREATE TABLE IF NOT EXISTS telegram_topics (
        channel_id TEXT PRIMARY KEY,
        telegram_thread_id INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS telegram_out (
        telegram_message_id INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS telegram_in (
        update_id INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS telegram_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_telegram_out_seq ON telegram_out(seq);
      CREATE TABLE IF NOT EXISTS telegram_pending (
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (seq, kind)
      );
      CREATE TABLE IF NOT EXISTS telegram_delivery_parts (
        seq INTEGER NOT NULL,
        part_key TEXT NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (seq, part_key, telegram_chat_id)
      );
      CREATE TABLE IF NOT EXISTS telegram_failures (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        telegram_chat_id INTEGER,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_failures_open ON telegram_failures(resolved_at, created_at);

      CREATE TABLE IF NOT EXISTS telegram_hold (
        telegram_message_id INTEGER PRIMARY KEY,
        telegram_thread_id INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
}

export function messageEventType(db: DatabaseSync): void {
  if (!hasColumn(db, "messages", "event_type")) db.exec("ALTER TABLE messages ADD COLUMN event_type TEXT");
}

/**
 * Legacy bots have revision 1 and keep their existing token hash. A row is
 * needed only after the first credential change; no raw token is stored.
 */
export function botCredentials(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_credentials (
      bot_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, revoked INTEGER NOT NULL
    )`);
}

export function messageRecipients(db: DatabaseSync): void {
  if (!hasColumn(db, "messages", "recipients")) db.exec("ALTER TABLE messages ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'");
}

/**
 * The atomic-project schema of #56 (formerly `STORAGE_VERSION = 2`): project
 * columns, the projects table, chat-scoped Telegram keys and the seed project.
 */
export function projectStorage(db: DatabaseSync): void {
  for (const table of ["agents", "channels"]) {
    const cols = requireShape(db, table, ["id"]);
    requireKey(cols, table, ["id"]);
    if (!cols.some(col => col.name === "project_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    worktree TEXT, created_at INTEGER NOT NULL
  )`);

  for (const table of ["telegram_hold", "telegram_out"] as const) {
    const hold = table === "telegram_hold";
    const fields = hold
      ? ["telegram_message_id", "telegram_thread_id", "payload"]
      : ["telegram_message_id", "seq", "channel_id", "thread_id"];
    const cols = requireShape(db, table, fields);
    const key = primaryKey(cols);
    requireKey(cols, table, [
      "telegram_message_id",
      "telegram_chat_id,telegram_message_id",
      "bot_key,telegram_chat_id,telegram_message_id",
    ]);
    const hasChat = cols.some(col => col.name === "telegram_chat_id");
    const hasBot = cols.some(col => col.name === "bot_key");
    if (key === "telegram_chat_id,telegram_message_id" || key === "bot_key,telegram_chat_id,telegram_message_id") {
      if (!hasChat) throw new Error(`Invalid storage schema: ${table}.telegram_chat_id is missing`);
      if (key.startsWith("bot_key,") && !hasBot) throw new Error(`Invalid storage schema: ${table}.bot_key is missing`);
      continue;
    }
    const definitions = hold
      ? "telegram_thread_id INTEGER NOT NULL, payload TEXT NOT NULL"
      : "seq INTEGER NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT";
    rebuild(db, table, `telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, ${definitions}, PRIMARY KEY (telegram_chat_id, telegram_message_id)`,
      `${hasChat ? "COALESCE(telegram_chat_id, 0)" : "0"}, ${fields.join(", ")}`);
  }

  const topics = requireShape(db, "telegram_topics", ["channel_id", "telegram_thread_id"]);
  requireKey(topics, "telegram_topics", ["channel_id", "bot_key,channel_id"]);
  const hasChat = topics.some(col => col.name === "telegram_chat_id");
  const hasBot = topics.some(col => col.name === "bot_key");
  if (!hasBot && (!hasChat || hasUniqueKey(db, "telegram_topics", ["telegram_thread_id"]))) {
    rebuild(db, "telegram_topics", "channel_id TEXT PRIMARY KEY, telegram_thread_id INTEGER NOT NULL, telegram_chat_id INTEGER",
      `channel_id, telegram_thread_id, ${hasChat ? "telegram_chat_id" : "NULL"}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_telegram_out_seq ON telegram_out(seq)");

  const seed = db.prepare("SELECT id FROM projects ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  const id = seed?.id ?? randomUUID();
  if (!seed) {
    db.prepare("INSERT INTO projects (id, slug, name, worktree, created_at) VALUES (?, ?, ?, NULL, ?)")
      .run(id, DEFAULT_PROJECT_SLUG, DEFAULT_PROJECT_NAME, Date.now());
  }
  db.prepare("UPDATE agents SET project_id = ? WHERE project_id IS NULL AND id != ?").run(id, HUMAN_ID);
  db.prepare("UPDATE channels SET project_id = ? WHERE project_id IS NULL").run(id);
  validateCoreStorage(db);
}

/** Project columns exist only after the project migration. */
export function projectQueryIndexes(db: DatabaseSync): void {
  db.exec(`
          CREATE INDEX IF NOT EXISTS idx_agents_project_role ON agents(project_id, role);
          CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
          CREATE INDEX IF NOT EXISTS idx_channels_project_type_name ON channels(project_id, type, name);
          CREATE INDEX IF NOT EXISTS idx_channel_members_agent_channel ON channel_members(agent_id, channel_id);
        `);
}
