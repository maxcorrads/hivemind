import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG, HUMAN_ID } from "../shared/types.ts";

// Reuse the project-migration version from #56. Other schema owners must extend
// this migration chain deliberately, rather than assigning competing versions.
export const STORAGE_VERSION = 2;
type Column = { name: string; type: string; notnull: number; pk: number };

function columns(db: DatabaseSync, table: string): Column[] {
  return db.prepare("SELECT name, type, [notnull], pk FROM pragma_table_info(?)").all(table) as Column[];
}

function requireShape(db: DatabaseSync, table: string, required: string[]): Column[] {
  const cols = columns(db, table);
  for (const name of required) {
    if (!cols.some((col) => col.name === name)) throw new Error(`Invalid storage schema: ${table}.${name} is missing`);
  }
  return cols;
}

function primaryKey(cols: Column[]): string {
  return cols.filter((col) => col.pk > 0).sort((a, b) => a.pk - b.pk).map((col) => col.name).join(",");
}

function requireKey(cols: Column[], table: string, allowed: string[]) {
  if (!allowed.includes(primaryKey(cols))) throw new Error(`Invalid storage schema: ${table} primary key`);
}

function hasUniqueKey(db: DatabaseSync, table: string, names: string[]): boolean {
  const indexes = db.prepare("SELECT name FROM pragma_index_list(?) WHERE [unique] = 1 AND partial = 0").all(table) as { name: string }[];
  return indexes.some(({ name }) => {
    const cols = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as { name: string | null }[];
    return cols.length === names.length && cols.every((col, i) => col.name === names[i]);
  });
}

export function storageVersion(db: DatabaseSync): number {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  // Shipped databases used version 0; version 2 is the atomic-project schema.
  if (version !== 0 && version !== STORAGE_VERSION) throw new Error(`Unsupported storage schema version ${version}`);
  return version;
}

export function validateCurrentStorage(db: DatabaseSync): void {
  for (const [table, required, key] of [
    ["agents", ["id", "name", "role", "seniority", "focus", "token_hash", "online", "last_seen_at", "created_at", "inbox_cursor", "project_id"], "id"],
    ["channels", ["id", "name", "type", "topic", "created_by", "created_at", "project_id"], "id"],
    ["projects", ["id", "slug", "name", "worktree", "created_at"], "id"],
    ["channel_members", ["channel_id", "agent_id"], "channel_id,agent_id"],
    ["messages", ["seq", "id", "channel_id", "thread_id", "author_id", "body", "kind", "control", "mentions", "created_at"], "seq"],
    ["threads", ["id", "channel_id", "status"], "id"],
    ["reads", ["agent_id", "channel_id", "last_read_seq"], "agent_id,channel_id"],
    ["attachments", ["id", "message_id", "name", "mime", "bytes", "sha256", "created_by", "created_at"], "id"],
    ["reactions", ["message_id", "agent_id", "emoji", "created_at"], "message_id,agent_id,emoji"],
    ["telegram_in", ["update_id"], "update_id"],
    ["telegram_state", ["key", "value"], "key"],
    ["telegram_pending", ["seq", "kind"], "seq,kind"],
    ["telegram_hold", ["telegram_chat_id", "telegram_message_id", "telegram_thread_id", "payload"], "telegram_chat_id,telegram_message_id"],
    ["telegram_out", ["telegram_chat_id", "telegram_message_id", "seq", "channel_id", "thread_id"], "telegram_chat_id,telegram_message_id"],
    ["telegram_topics", ["channel_id", "telegram_thread_id", "telegram_chat_id"], "channel_id"],
  ] as const) {
    requireKey(requireShape(db, table, [...required]), table, [key]);
  }
  for (const table of ["telegram_hold", "telegram_out"]) {
    for (const col of columns(db, table)) {
      if (["telegram_chat_id", "telegram_message_id"].includes(col.name) && !col.notnull) {
        throw new Error(`Invalid storage schema: ${table}.${col.name} must be NOT NULL`);
      }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB '_hive_migrate_*'").get()) {
    throw new Error("Invalid storage schema: leftover migration staging table");
  }
  if (!hasUniqueKey(db, "projects", ["slug"])) throw new Error("Invalid storage schema: projects.slug must be unique");
  if (hasUniqueKey(db, "telegram_topics", ["telegram_thread_id"])) {
    throw new Error("Invalid storage schema: Telegram thread IDs must not be globally unique");
  }
}

/** Called inside the single startup transaction, after the legacy base tables exist. */
export function migrateProjectStorage(db: DatabaseSync): void {
  for (const table of ["agents", "channels"]) {
    const cols = requireShape(db, table, ["id"]);
    requireKey(cols, table, ["id"]);
    if (!cols.some((col) => col.name === "project_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
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
    requireKey(cols, table, ["telegram_message_id", "telegram_chat_id,telegram_message_id"]);
    const hasChat = cols.some((col) => col.name === "telegram_chat_id");
    if (key === "telegram_chat_id,telegram_message_id") {
      if (!hasChat) throw new Error(`Invalid storage schema: ${table}.telegram_chat_id is missing`);
      continue;
    }
    const definitions = hold
      ? "telegram_thread_id INTEGER NOT NULL, payload TEXT NOT NULL"
      : "seq INTEGER NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT";
    rebuild(db, table, `telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL, ${definitions}, PRIMARY KEY (telegram_chat_id, telegram_message_id)`,
      `${hasChat ? "COALESCE(telegram_chat_id, 0)" : "0"}, ${fields.join(", ")}`);
  }

  const topics = requireShape(db, "telegram_topics", ["channel_id", "telegram_thread_id"]);
  requireKey(topics, "telegram_topics", ["channel_id"]);
  const hasChat = topics.some((col) => col.name === "telegram_chat_id");
  if (!hasChat || hasUniqueKey(db, "telegram_topics", ["telegram_thread_id"])) {
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
  validateCurrentStorage(db);
}

function rebuild(db: DatabaseSync, table: string, definition: string, selection: string) {
  const staging = `_hive_migrate_${table}`;
  // Do not silently adopt or erase a leftover/foreign staging table.
  db.exec(`CREATE TABLE ${staging} (${definition})`);
  db.exec(`INSERT INTO ${staging} SELECT ${selection} FROM ${table}`);
  const count = (name: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  if (count(staging) !== count(table)) throw new Error(`Migration row-count mismatch: ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${staging} RENAME TO ${table}`);
}
