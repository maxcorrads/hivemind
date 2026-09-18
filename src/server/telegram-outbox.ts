import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError } from "../shared/types.ts";

export type TelegramDestination = { botKey: string; chatId: number };
export type TelegramJob = { seq: number; kind: "message" | "reaction"; botKey: string | null; chatId: number | null; attempts?: number; firstAttemptAt?: number; revision?: number };
export const TELEGRAM_PENDING_CAP = 200;
export const TELEGRAM_FAILURE_CAP = 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Without a verified bot ID, credential changes deliberately require reconciliation. */
export function telegramBotKey(token: string, verifiedBotId?: number): string {
  return verifiedBotId !== undefined
    ? `bot:${verifiedBotId}`
    : `credential:${createHash("sha256").update(token).digest("hex")}`;
}

export function outboxTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initTelegramOutbox(db: DatabaseSync): void {
  const has = (table: string, name: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(row => row.name === name);
  outboxTransaction(db, () => {
    for (const table of ["telegram_pending", "telegram_failures"]) {
      if (!has(table, "bot_key")) db.exec(`ALTER TABLE ${table} ADD COLUMN bot_key TEXT`);
    }
    if (!has("telegram_pending", "telegram_chat_id")) db.exec("ALTER TABLE telegram_pending ADD COLUMN telegram_chat_id INTEGER");
    if (!has("telegram_delivery_parts", "bot_key")) {
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
      if (!has("telegram_pending", column)) db.exec(`ALTER TABLE telegram_pending ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    if (!has("telegram_failures", "destination_invalidated")) db.exec("ALTER TABLE telegram_failures ADD COLUMN destination_invalidated INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_telegram_parts_seq ON telegram_delivery_parts(seq)");
  });
}

function validDestination(value: TelegramDestination | null | undefined): value is TelegramDestination {
  return Boolean(value?.botKey && Number.isSafeInteger(value.chatId) && value.chatId !== 0);
}

export function sameTelegramDestination(a: { botKey: string | null; chatId: number | null }, b?: TelegramDestination | null): boolean {
  return validDestination(b) && a.botKey === b.botKey && a.chatId === b.chatId;
}

export function telegramJob(db: DatabaseSync, seq: number, kind: string): TelegramJob | undefined {
  return db.prepare(
    "SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId, attempts, first_attempt_at AS firstAttemptAt, revision FROM telegram_pending WHERE seq = ? AND kind = ?",
  ).get(seq, kind) as TelegramJob | undefined;
}

export function pruneTelegramFailures(db: DatabaseSync, at = Date.now()): void {
  const expired = db.prepare("DELETE FROM telegram_failures WHERE created_at < ?").run(at - RETENTION_MS).changes;
  const excess = db.prepare(`DELETE FROM telegram_failures WHERE id IN (
    SELECT id FROM telegram_failures ORDER BY (resolved_at IS NULL) DESC, created_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(TELEGRAM_FAILURE_CAP).changes;
  const removed = Number(expired) + Number(excess);
  if (removed) db.prepare(`INSERT INTO telegram_state(key, value) VALUES ('outbox:diagnostics_pruned', ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)`).run(String(removed));
}

/** Caller owns the transaction when a failed job is being removed in the same unit. */
export function recordTelegramFailure(
  db: DatabaseSync, seq: number, kind: string, reason: string, attempts = 0,
  telegramChatId?: number, botKey?: string,
): void {
  const existing = telegramJob(db, seq, kind);
  db.prepare(`INSERT INTO telegram_failures
    (id, seq, kind, telegram_chat_id, bot_key, reason, attempts, created_at, resolved_at, resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
    randomUUID(), seq, kind, existing?.chatId ?? telegramChatId ?? null,
    existing?.botKey ?? botKey ?? null, reason.slice(0, 1000), attempts, Date.now(),
  );
  pruneTelegramFailures(db);
}

function enqueueInside(db: DatabaseSync, seq: number, kind: TelegramJob["kind"], cap: number, destination?: TelegramDestination): void {
  const previous = telegramJob(db, seq, kind);
  if (previous && destination && !sameTelegramDestination(previous, destination)) {
    throw new HiveError(409, "Queued Telegram job has another destination; reconcile it explicitly");
  }
  db.prepare(`INSERT OR IGNORE INTO telegram_pending (seq, kind, bot_key, telegram_chat_id) VALUES (?, ?, ?, ?)`)
    .run(seq, kind, destination?.botKey ?? null, destination?.chatId ?? null);
  if (previous && kind === "reaction") db.prepare("UPDATE telegram_pending SET revision = revision + 1 WHERE seq = ? AND kind = ?").run(seq, kind);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM telegram_pending").get() as { n: number }).n;
  if (count <= cap) return;
  const overflow = db.prepare(`SELECT seq, kind FROM telegram_pending
    ORDER BY CASE WHEN kind = 'reaction' THEN 0 ELSE 1 END, seq ASC, kind ASC LIMIT ?`)
    .all(count - cap) as Pick<TelegramJob, "seq" | "kind">[];
  for (const row of overflow) {
    recordTelegramFailure(db, row.seq, row.kind, "queue_overflow");
    db.prepare("DELETE FROM telegram_pending WHERE seq = ? AND kind = ?").run(row.seq, row.kind);
  }
}

export function enqueueTelegramPending(
  db: DatabaseSync, seq: number, kind: TelegramJob["kind"], cap = TELEGRAM_PENDING_CAP, destination?: TelegramDestination,
): void {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > TELEGRAM_PENDING_CAP) throw new HiveError(400, "Invalid Telegram queue capacity");
  if (destination && !validDestination(destination)) throw new HiveError(400, "Invalid Telegram destination");
  outboxTransaction(db, () => enqueueInside(db, seq, kind, cap, destination));
}

export function failTelegramJob(db: DatabaseSync, job: TelegramJob, reason: string, attempts: number): void {
  outboxTransaction(db, () => {
    recordTelegramFailure(db, job.seq, job.kind, reason, attempts, job.chatId ?? undefined, job.botKey ?? undefined);
    db.prepare("DELETE FROM telegram_pending WHERE seq = ? AND kind = ?").run(job.seq, job.kind);
  });
}

export function retryTelegramOutboxFailure(
  db: DatabaseSync, id: string, currentDestination: (seq: number) => TelegramDestination | undefined,
): void {
  outboxTransaction(db, () => {
    const row = db.prepare(`SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_failures
      WHERE id = ? AND resolved_at IS NULL`).get(id) as TelegramJob | undefined;
    if (!row) throw new HiveError(404, "Telegram failure not found");
    if (db.prepare("SELECT 1 FROM telegram_failures WHERE id = ? AND destination_invalidated = 1").get(id)) {
      throw new HiveError(409, "Telegram destination was invalidated; retry cannot revive cancelled historical delivery");
    }
    const current = currentDestination(row.seq);
    if (!sameTelegramDestination(row, current)) throw new HiveError(409, "Telegram destination changed or unknown; retry will not retarget historical content");
    // A user-requested retry must not silently evict itself or another job.
    const count = (db.prepare("SELECT COUNT(*) AS n FROM telegram_pending").get() as { n: number }).n;
    if (count >= TELEGRAM_PENDING_CAP && !telegramJob(db, row.seq, row.kind)) throw new HiveError(409, "Telegram queue is full; retry later");
    enqueueInside(db, row.seq, row.kind, TELEGRAM_PENDING_CAP, current);
    db.prepare("UPDATE telegram_failures SET resolved_at = ?, resolution = 'retried' WHERE id = ?").run(Date.now(), id);
  });
}

export function telegramPartDelivered(db: DatabaseSync, seq: number, partKey: string, chatId: number, botKey = ""): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_delivery_parts
    WHERE seq = ? AND part_key = ? AND telegram_chat_id = ? AND bot_key = ?`).get(seq, partKey, chatId, botKey));
}
