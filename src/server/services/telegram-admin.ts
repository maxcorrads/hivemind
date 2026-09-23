import { HiveError } from "../../shared/types.ts";
import { telegramQuarantine, retryTelegramUpdate, discardTelegramUpdate, type TelegramUpdateScope } from "../telegram-inbox.ts";
import { retryTelegramOutboxFailure, type TelegramDestination } from "../telegram-outbox.ts";
import type { Core } from "./ports.ts";
import { now } from "./rows.ts";

export type TelegramAdminDeps = Core;

export type TelegramFailureView = {
  id: string;
  seq: number;
  kind: string;
  telegramChatId: number | null;
  reason: string;
  attempts: number;
  createdAt: number;
};

/** Telegram health, quarantine and delivery-failure administration (the Human-only API). */
export class TelegramAdminService {
  private healthSignature = "";

  constructor(private readonly deps: TelegramAdminDeps) {}

  private get db() { return this.deps.storage.db; }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  private tableSql(name: string): string {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql: string }
      | undefined;
    return row?.sql ?? "";
  }

  outboxHealth() {
    return {
      failures: this.failureCount(),
      diagnosticsPruned: Number((this.db.prepare("SELECT value FROM telegram_state WHERE key = 'outbox:diagnostics_pruned'").get() as { value: string } | undefined)?.value ?? 0),
    };
  }

  pollHealth() {
    const bot = (this.db.prepare("SELECT value FROM telegram_state WHERE key = 'inbound:active_bot'").get() as { value: string } | undefined)?.value;
    const read = (key: string) => bot && this.hasTable("telegram_bot_state")
      ? (this.db.prepare("SELECT value FROM telegram_bot_state WHERE bot_key = ? AND key = ?").get(bot, key) as { value: string } | undefined)?.value
      : undefined;
    return {
      lastSuccessAt: Number(read("poll:last_success")) || null,
      lastError: (this.db.prepare("SELECT value FROM telegram_state WHERE key = 'inbound:configuration_error'").get() as { value: string } | undefined)?.value || read("poll:last_error") || null,
      quarantined: (this.db.prepare("SELECT COUNT(*) AS n FROM telegram_update_failures WHERE state = 'quarantined'").get() as { n: number }).n,
      retrying: (this.db.prepare("SELECT COUNT(*) AS n FROM telegram_update_failures WHERE state = 'retry'").get() as { n: number }).n,
      inboundDiagnosticsPruned: Number((this.db.prepare("SELECT value FROM telegram_state WHERE key = 'inbound:diagnostics_pruned'").get() as { value: string } | undefined)?.value ?? 0),
    };
  }

  health() {
    const revision = Number((this.db.prepare("SELECT value FROM telegram_state WHERE key = 'health:revision'").get() as { value: string } | undefined)?.value ?? 0);
    return { ...this.outboxHealth(), ...this.pollHealth(), revision };
  }

  publishHealth() {
    const health = this.health();
    // Successful poll timestamps are stored, but do not broadcast an otherwise unchanged status.
    const { lastSuccessAt: _lastSuccessAt, revision: _revision, ...status } = health;
    const signature = JSON.stringify(status);
    if (signature === this.healthSignature) return;
    this.healthSignature = signature;
    const revision = health.revision + 1;
    this.db.prepare("INSERT INTO telegram_state(key, value) VALUES('health:revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(revision));
    this.deps.bus.emit("telegram-health", { ...health, revision });
  }

  quarantine(limit = 50) { return telegramQuarantine(this.db, limit); }

  retryUpdate(id: string, matchesScope: (scope: TelegramUpdateScope) => boolean) {
    retryTelegramUpdate(this.db, id, matchesScope);
    this.deps.bus.emit("telegram-inbox-wake");
    this.publishHealth();
  }

  discardUpdate(id: string) {
    discardTelegramUpdate(this.db, id);
    this.deps.bus.emit("telegram-inbox-wake");
    this.publishHealth();
  }

  failureCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM telegram_failures WHERE resolved_at IS NULL").get() as { n: number }).n;
  }

  failures(limit = 50): TelegramFailureView[] {
    return this.db.prepare(
      `SELECT id, seq, kind, telegram_chat_id AS telegramChatId, reason, attempts, created_at AS createdAt
       FROM telegram_failures WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    ).all(Number.isSafeInteger(limit) ? Math.min(Math.max(1, limit), 200) : 50) as TelegramFailureView[];
  }

  retryFailure(id: string, destination: (seq: number) => TelegramDestination | undefined): void {
    retryTelegramOutboxFailure(this.db, id, destination);
    // Retry is durable before its dispatcher is woken.
    this.deps.bus.emit("telegram-outbox-wake");
    this.publishHealth();
  }

  discardFailure(id: string): void {
    const changed = this.db.prepare(
      "UPDATE telegram_failures SET resolved_at = ?, resolution = 'discarded' WHERE id = ? AND resolved_at IS NULL",
    ).run(now(), id).changes;
    if (!changed) throw new HiveError(404, "Telegram failure not found");
    this.publishHealth();
  }

  forgetChat(chatId: number) {
    if (!Number.isFinite(chatId)) return;
    this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
    this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
    if (this.hasTable("telegram_bot_state")) this.db.prepare("DELETE FROM telegram_bot_state WHERE key = ?").run(`mute:${chatId}`);
  }

  /**
   * Removes every Telegram row tied to a project being deleted: inbound failures, the
   * outbox/topics/pending rows of its channels, and the hold/mute state of every chat
   * that served it (plus `extraChatId`, the chat the Human deleted it from). Runs
   * inside the caller's transaction, before the channels' messages are deleted.
   */
  purgeProject(projectId: string, channelIds: string[], extraChatId?: number | null): void {
    this.db.prepare("DELETE FROM telegram_update_failures WHERE project_id = ?").run(projectId);
    const chatIds = new Set<number>();
    if (extraChatId != null && Number.isFinite(extraChatId)) chatIds.add(Number(extraChatId));
    if (channelIds.length > 0) {
      const ph = channelIds.map(() => "?").join(",");
      const chatRows = this.db.prepare(
        `SELECT telegram_chat_id AS id FROM telegram_out WHERE channel_id IN (${ph})
         UNION
         SELECT telegram_chat_id AS id FROM telegram_topics WHERE channel_id IN (${ph})`,
      ).all(...channelIds, ...channelIds) as { id: number | null }[];
      for (const row of chatRows) {
        if (row.id != null) chatIds.add(row.id);
      }
      this.db.prepare(
        `DELETE FROM telegram_pending WHERE seq IN (SELECT seq FROM messages WHERE channel_id IN (${ph}))`,
      ).run(...channelIds);
      this.db.prepare(`DELETE FROM telegram_out WHERE channel_id IN (${ph})`).run(...channelIds);
      this.db.prepare(`DELETE FROM telegram_topics WHERE channel_id IN (${ph})`).run(...channelIds);
      for (const table of ["telegram_failures", "telegram_delivery_parts"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE seq IN (
          SELECT seq FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE project_id = ?)
        )`).run(projectId);
      }
    }
    const scopedHolds = this.tableSql("telegram_hold").includes("project_id");
    if (scopedHolds) this.db.prepare("DELETE FROM telegram_hold WHERE project_id = ?").run(projectId);
    for (const chatId of chatIds) {
      if (!scopedHolds) this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
      if (this.hasTable("telegram_bot_state")) this.db.prepare("DELETE FROM telegram_bot_state WHERE key = ?").run(`mute:${chatId}`);
    }
  }
}
