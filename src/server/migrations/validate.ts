import type { DatabaseSync } from "node:sqlite";
import { columns, hasUniqueKey, requireKey, requireShape } from "./schema.ts";

/**
 * The invariants of the core and Telegram tables that migrations never repair by
 * data loss: required columns, primary keys (either the unrouted or the per-bot
 * routed Telegram shape), NOT NULL keys and no leftover staging tables.
 */
export function validateCoreStorage(db: DatabaseSync): void {
  for (const [table, required, keys] of [
    ["agents", ["id", "name", "role", "seniority", "focus", "token_hash", "online", "last_seen_at", "created_at", "inbox_cursor", "project_id"], ["id"]],
    ["channels", ["id", "name", "type", "topic", "created_by", "created_at", "project_id"], ["id"]],
    ["projects", ["id", "slug", "name", "worktree", "created_at"], ["id"]],
    ["channel_members", ["channel_id", "agent_id"], ["channel_id,agent_id"]],
    ["messages", ["seq", "id", "channel_id", "thread_id", "author_id", "body", "kind", "control", "mentions", "created_at"], ["seq"]],
    ["threads", ["id", "channel_id", "status"], ["id"]],
    ["reads", ["agent_id", "channel_id", "last_read_seq"], ["agent_id,channel_id"]],
    ["attachments", ["id", "message_id", "name", "mime", "bytes", "sha256", "created_by", "created_at"], ["id"]],
    ["reactions", ["message_id", "agent_id", "emoji", "created_at"], ["message_id,agent_id,emoji"]],
    ["telegram_in", ["update_id"], ["update_id", "bot_key,update_id"]],
    ["telegram_state", ["key", "value"], ["key"]],
    ["telegram_pending", ["seq", "kind"], ["seq,kind"]],
    ["telegram_hold", ["telegram_chat_id", "telegram_message_id", "telegram_thread_id", "payload"],
      ["telegram_chat_id,telegram_message_id", "bot_key,telegram_chat_id,telegram_message_id"]],
    ["telegram_out", ["telegram_chat_id", "telegram_message_id", "seq", "channel_id", "thread_id"],
      ["telegram_chat_id,telegram_message_id", "bot_key,telegram_chat_id,telegram_message_id"]],
    ["telegram_topics", ["channel_id", "telegram_thread_id", "telegram_chat_id"], ["channel_id", "bot_key,channel_id"]],
  ] as const) {
    requireKey(requireShape(db, table, [...required]), table, [...keys]);
  }
  for (const table of ["telegram_hold", "telegram_out"]) {
    for (const col of columns(db, table)) {
      if (["telegram_chat_id", "telegram_message_id"].includes(col.name) && !col.notnull) {
        throw new Error(`Invalid storage schema: ${table}.${col.name} must be NOT NULL`);
      }
    }
  }
  for (const table of ["telegram_in", "telegram_hold", "telegram_out", "telegram_topics"]) {
    const botKey = columns(db, table).find(col => col.name === "bot_key");
    if (botKey && !botKey.notnull) throw new Error(`Invalid storage schema: ${table}.bot_key must be NOT NULL`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB '_hive_migrate_*'").get()) {
    throw new Error("Invalid storage schema: leftover migration staging table");
  }
  if (!hasUniqueKey(db, "projects", ["slug"])) throw new Error("Invalid storage schema: projects.slug must be unique");
  if (hasUniqueKey(db, "telegram_topics", ["telegram_thread_id"])) {
    throw new Error("Invalid storage schema: Telegram thread IDs must not be globally unique");
  }
}

export type SchemaShape = {
  tables: Map<string, string[]>;
  indexes: string[];
  triggers: string[];
};

export function schemaShape(db: DatabaseSync): SchemaShape {
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as
    { type: string; name: string }[];
  const tables = new Map<string, string[]>();
  for (const { type, name } of objects) if (type === "table") tables.set(name, columns(db, name).map(column => column.name));
  return {
    tables,
    indexes: objects.filter(object => object.type === "index").map(object => object.name),
    triggers: objects.filter(object => object.type === "trigger").map(object => object.name),
  };
}

/**
 * A database at the current version must contain every table (with every column),
 * index and trigger that the migrations create on a fresh database. Extra objects
 * and columns are allowed: the deferred Telegram routing migration adds some.
 */
export function validateSchema(db: DatabaseSync, reference: SchemaShape): void {
  validateCoreStorage(db);
  const actual = schemaShape(db);
  for (const [table, names] of reference.tables) {
    const present = actual.tables.get(table);
    if (!present) throw new Error(`Invalid storage schema: table ${table} is missing`);
    for (const name of names) if (!present.includes(name)) throw new Error(`Invalid storage schema: ${table}.${name} is missing`);
  }
  for (const [kind, names, have] of [["index", reference.indexes, actual.indexes], ["trigger", reference.triggers, actual.triggers]] as const) {
    for (const name of names) if (!have.includes(name)) throw new Error(`Invalid storage schema: ${kind} ${name} is missing`);
  }
}
