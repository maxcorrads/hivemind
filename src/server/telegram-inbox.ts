import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError } from "../shared/types.ts";
import { outboxTransaction } from "./telegram-outbox.ts";

export const TELEGRAM_UPDATE_ATTEMPTS = 5;
export const TELEGRAM_UPDATE_CAP = 1000;
export const TELEGRAM_UPDATE_RETRY_CAP = 200;
export const TELEGRAM_UPDATE_BYTES = 64 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type TelegramUpdate = { update_id: number; message?: unknown; message_reaction?: unknown };
export type TelegramUpdateScope = { botKey: string; chatId: number | null; projectId: string | null };
export type TelegramUpdateFailure = TelegramUpdateScope & {
  id: string; updateId: number; payload: string | null; attempts: number; invalidated: number;
  lastError: string; state: string; retryAt: number; updatedAt: number;
};
export class TelegramPermanentUpdateError extends Error {}

export function telegramPollBackoffMs(failures: number, random: () => number = Math.random, terminal = false): number {
  if (terminal) return 30_000;
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(20, Math.max(0, failures - 1)));
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.min(30_000, Math.round(base * (0.75 + jitter * 0.5)));
}
export function isTelegramTerminalPollError(description: string): boolean {
  return /unauthorized|invalid token|not found|forbidden/i.test(description);
}
export function validTelegramUpdateId(id: unknown): id is number {
  return Number.isSafeInteger(id) && Number(id) >= 0 && Number(id) < Number.MAX_SAFE_INTEGER;
}

export function initTelegramInbox(db: DatabaseSync): void {
  outboxTransaction(db, () => {
    const columns = db.prepare("PRAGMA table_info(telegram_update_failures)").all() as { name: string }[];
    const legacy = columns.length > 0 && !columns.some(c => c.name === "bot_key");
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
          CASE WHEN length(CAST(payload AS BLOB)) <= ${TELEGRAM_UPDATE_BYTES} THEN payload ELSE NULL END,
          attempts, 'legacy_scope_unknown', 'quarantined', 0, updated_at, updated_at, 1
        FROM telegram_update_failures_legacy;
        DROP TABLE telegram_update_failures_legacy;`);
    }
    pruneTelegramUpdates(db);
  });
}

export function pruneTelegramUpdates(db: DatabaseSync, at = Date.now()): void {
  const expired = Number(db.prepare("DELETE FROM telegram_update_failures WHERE updated_at < ?").run(at - RETENTION_MS).changes);
  const excess = Number(db.prepare(`DELETE FROM telegram_update_failures WHERE id IN (
    SELECT id FROM telegram_update_failures
    ORDER BY (state = 'retry') DESC, (state = 'quarantined') DESC, updated_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(TELEGRAM_UPDATE_CAP).changes);
  if (expired + excess) db.prepare(`INSERT INTO telegram_state(key, value) VALUES('inbound:diagnostics_pruned', ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)`).run(String(expired + excess));
}

function acknowledgeInside(db: DatabaseSync, botKey: string, updateId: number): void {
  if (!validTelegramUpdateId(updateId)) throw new HiveError(400, "Invalid Telegram update id");
  db.prepare("INSERT OR IGNORE INTO telegram_in(bot_key, update_id) VALUES(?, ?)").run(botKey, updateId);
  db.prepare(`INSERT INTO telegram_bot_state(bot_key, key, value) VALUES(?, 'offset', ?)
    ON CONFLICT(bot_key, key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
    .run(botKey, String(updateId + 1));
}

/** Failed work is durably owned before Telegram's cursor is advanced. Every statement rolls back together. */
export function recordTelegramUpdateFailure(
  db: DatabaseSync, scope: TelegramUpdateScope, update: TelegramUpdate, error: string,
  options: { permanent?: boolean; retryAt?: number; at?: number } = {},
): void {
  outboxTransaction(db, () => recordFailureInside(db, scope, update, error, options));
}

/** Transfer the entire accepted remainder before a new routing generation can start. */
export function handoffTelegramUpdates(db: DatabaseSync, entries: ReadonlyArray<{ scope: TelegramUpdateScope; update: TelegramUpdate }>): void {
  const at = Date.now();
  outboxTransaction(db, () => {
    for (const { scope, update } of entries) {
      if (db.prepare("SELECT 1 FROM telegram_in WHERE bot_key = ? AND update_id = ?").get(scope.botKey, update.update_id)) continue;
      recordFailureInside(db, scope, update, "bridge_drained_before_completion", { at, retryAt: at + 1_000 });
    }
  });
}

function recordFailureInside(
  db: DatabaseSync, scope: TelegramUpdateScope, update: TelegramUpdate, error: string,
  options: { permanent?: boolean; retryAt?: number; at?: number },
): void {
  const at = options.at ?? Date.now();
  const previous = db.prepare("SELECT attempts FROM telegram_update_failures WHERE bot_key = ? AND update_id = ?")
    .get(scope.botKey, update.update_id) as { attempts: number } | undefined;
  const attempts = (previous?.attempts ?? 0) + 1;
  const json = JSON.stringify(update);
  const payload = Buffer.byteLength(json) <= TELEGRAM_UPDATE_BYTES ? json : null;
  const retryCount = (db.prepare("SELECT COUNT(*) AS n FROM telegram_update_failures WHERE state = 'retry'").get() as { n: number }).n;
  const overflow = !previous && retryCount >= TELEGRAM_UPDATE_RETRY_CAP;
  const quarantined = options.permanent || !payload || overflow || attempts >= TELEGRAM_UPDATE_ATTEMPTS;
  const reason = !payload ? "update_payload_too_large" : overflow ? "inbound_retry_queue_full" : error;
  db.prepare(`INSERT INTO telegram_update_failures
    (id, bot_key, update_id, telegram_chat_id, project_id, payload, attempts, last_error, state, retry_at, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_key, update_id) DO UPDATE SET
      attempts = excluded.attempts, last_error = excluded.last_error, state = excluded.state,
      retry_at = excluded.retry_at, updated_at = excluded.updated_at`)
    .run(randomUUID(), scope.botKey, update.update_id, scope.chatId, scope.projectId, payload, attempts,
      reason.slice(0, 1000), quarantined ? "quarantined" : "retry",
      Math.max(at + 1, options.retryAt ?? at + telegramPollBackoffMs(attempts)), at, at);
  acknowledgeInside(db, scope.botKey, update.update_id);
  pruneTelegramUpdates(db, at);
}

export function acknowledgeTelegramUpdate(db: DatabaseSync, botKey: string, updateId: number): void {
  outboxTransaction(db, () => acknowledgeInside(db, botKey, updateId));
}

export function finishTelegramUpdate(db: DatabaseSync, botKey: string, updateId: number): void {
  outboxTransaction(db, () => {
    db.prepare("UPDATE telegram_update_failures SET state = 'resolved', payload = NULL, updated_at = ? WHERE bot_key = ? AND update_id = ? AND state = 'retry'")
      .run(Date.now(), botKey, updateId);
    acknowledgeInside(db, botKey, updateId);
  });
}

const SELECT_FAILURE = `SELECT id, bot_key AS botKey, update_id AS updateId, telegram_chat_id AS chatId,
  project_id AS projectId, payload, attempts, invalidated, last_error AS lastError, state, retry_at AS retryAt,
  updated_at AS updatedAt FROM telegram_update_failures`;
export function dueTelegramUpdate(db: DatabaseSync, botKey: string, at = Date.now()): TelegramUpdateFailure | undefined {
  return db.prepare(`${SELECT_FAILURE} WHERE bot_key = ? AND state = 'retry' AND retry_at <= ? ORDER BY retry_at, update_id LIMIT 1`)
    .get(botKey, at) as TelegramUpdateFailure | undefined;
}
export function nextTelegramUpdateRetry(db: DatabaseSync, botKey: string): number | undefined {
  return (db.prepare("SELECT MIN(retry_at) AS at FROM telegram_update_failures WHERE bot_key = ? AND state = 'retry'")
    .get(botKey) as { at: number | null }).at ?? undefined;
}
export function telegramQuarantine(db: DatabaseSync, limit = 50) {
  const rows = db.prepare(`${SELECT_FAILURE} WHERE state = 'quarantined' ORDER BY updated_at DESC, id LIMIT ?`)
    .all(Number.isSafeInteger(limit) ? Math.min(200, Math.max(1, limit)) : 50) as TelegramUpdateFailure[];
  return rows.map(({ payload, ...row }) => ({ ...row, replayable: Boolean(payload && row.botKey && row.projectId && !row.invalidated) }));
}
export function retryTelegramUpdate(db: DatabaseSync, id: string, matchesScope: (scope: TelegramUpdateScope) => boolean): void {
  outboxTransaction(db, () => {
    const row = db.prepare(`${SELECT_FAILURE} WHERE id = ? AND state = 'quarantined'`).get(id) as TelegramUpdateFailure | undefined;
    if (!row) throw new HiveError(404, "Quarantined Telegram update not found");
    if (!row.payload || row.invalidated || !matchesScope(row)) throw new HiveError(409, "Telegram update has no replayable payload or its original bot/project/chat changed");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM telegram_update_failures WHERE state = 'retry'").get() as { n: number }).n;
    if (count >= TELEGRAM_UPDATE_RETRY_CAP) throw new HiveError(409, "Telegram inbound retry queue is full");
    db.prepare("UPDATE telegram_update_failures SET state = 'retry', attempts = 0, retry_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), id);
  });
}
export function discardTelegramUpdate(db: DatabaseSync, id: string): void {
  if (!db.prepare("UPDATE telegram_update_failures SET state = 'discarded', payload = NULL, updated_at = ? WHERE id = ? AND state IN ('retry', 'quarantined')")
    .run(Date.now(), id).changes) throw new HiveError(404, "Quarantined Telegram update not found");
}
