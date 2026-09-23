import type { DatabaseSync } from "node:sqlite";
import { columns, hasColumn } from "./schema.ts";

// Frozen copy of TELEGRAM_UPDATE_BYTES when this migration shipped: migrations must not drift with runtime limits.
const LEGACY_UPDATE_BYTES = 64 * 1024;

/** Per-bot outbox destinations, retry bookkeeping and invalidation (idempotent). */
export function telegramOutboxDestinations(db: DatabaseSync): void {
  for (const table of ["telegram_pending", "telegram_failures"]) {
    if (!hasColumn(db, table, "bot_key")) db.exec(`ALTER TABLE ${table} ADD COLUMN bot_key TEXT`);
  }
  if (!hasColumn(db, "telegram_pending", "telegram_chat_id")) db.exec("ALTER TABLE telegram_pending ADD COLUMN telegram_chat_id INTEGER");
  if (!hasColumn(db, "telegram_delivery_parts", "bot_key")) {
    db.exec(`
        ALTER TABLE telegram_delivery_parts RENAME TO telegram_delivery_parts_legacy;
        CREATE TABLE telegram_delivery_parts (
          seq INTEGER NOT NULL, part_key TEXT NOT NULL, bot_key TEXT NOT NULL,
          telegram_chat_id INTEGER NOT NULL, telegram_message_id INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          PRIMARY KEY (seq, part_key, bot_key, telegram_chat_id)
        );
        INSERT INTO telegram_delivery_parts
          SELECT seq, part_key, '', telegram_chat_id, telegram_message_id, completed_at FROM telegram_delivery_parts_legacy;
        DROP TABLE telegram_delivery_parts_legacy;
      `);
  }
  for (const column of ["attempts", "first_attempt_at", "revision"]) {
    if (!hasColumn(db, "telegram_pending", column)) db.exec(`ALTER TABLE telegram_pending ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, "telegram_failures", "destination_invalidated")) db.exec("ALTER TABLE telegram_failures ADD COLUMN destination_invalidated INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_telegram_parts_seq ON telegram_delivery_parts(seq)");
}

/** Scoped inbound failure ledger; legacy unscoped rows are quarantined, never replayed. */
export function telegramUpdateFailures(db: DatabaseSync): void {
  const existing = columns(db, "telegram_update_failures");
  const legacy = existing.length > 0 && !existing.some(c => c.name === "bot_key");
  if (legacy) db.exec("ALTER TABLE telegram_update_failures RENAME TO telegram_update_failures_legacy");
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_update_failures (
      id TEXT PRIMARY KEY, bot_key TEXT NOT NULL, update_id INTEGER NOT NULL,
      telegram_chat_id INTEGER, project_id TEXT, payload TEXT,
      attempts INTEGER NOT NULL, last_error TEXT NOT NULL, state TEXT NOT NULL,
      retry_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_key, update_id)
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_update_retry ON telegram_update_failures(bot_key, state, retry_at);`);
  if (legacy) {
    // A legacy payload has no provable bot/project provenance. Keep it visible, never replay it automatically.
    db.exec(`INSERT INTO telegram_update_failures
        SELECT 'legacy:' || update_id, '', update_id, NULL, NULL,
          CASE WHEN length(CAST(payload AS BLOB)) <= ${LEGACY_UPDATE_BYTES} THEN payload ELSE NULL END,
          attempts, 'legacy_scope_unknown', 'quarantined', 0, updated_at, updated_at, 1
        FROM telegram_update_failures_legacy;
        DROP TABLE telegram_update_failures_legacy;`);
  }
}
