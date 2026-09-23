import type { Storage } from "./storage.ts";
import { initTelegramRouting, namespaceForVerifiedBot } from "./telegram-routing.ts";
import { enqueueTelegramPending, failTelegramJob, telegramPartDelivered, type TelegramDestination, type TelegramJob } from "./telegram-outbox.ts";
import {
  acknowledgeTelegramUpdate, dueTelegramUpdate, finishTelegramUpdate, handoffTelegramUpdates, nextTelegramUpdateRetry,
  recordTelegramUpdateFailure, type TelegramUpdate, type TelegramUpdateFailure, type TelegramUpdateScope,
} from "./telegram-inbox.ts";

type Row = { rowId: number; channelId: string; chatId: number };
export type TelegramOutMapping = { seq: number; channelId: string; threadId: string | null };

/**
 * Every telegram_* statement the Telegram bridge (telegram.ts) issues. The inbox,
 * outbox and routing helpers stay where they are; the store binds them to the
 * hive's storage so the bridge never touches the database handle itself.
 */
export class TelegramStore {
  constructor(private readonly storage: Storage) {}

  private get db() { return this.storage.db; }

  transaction<T>(work: () => T): T { return this.storage.transaction(work); }

  // Global bridge state
  clearConfigurationError() {
    this.db.prepare("DELETE FROM telegram_state WHERE key = 'inbound:configuration_error'").run();
  }
  setConfigurationError(message: string) {
    this.db.prepare("INSERT INTO telegram_state(key, value) VALUES('inbound:configuration_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(message);
  }
  setActiveBot(botKey: string) {
    this.db.prepare("INSERT INTO telegram_state(key, value) VALUES('inbound:active_bot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(botKey);
  }

  // Routing identities
  initRouting(botKey: string) { initTelegramRouting(this.db, botKey); }
  namespaceForVerifiedBot(botId: number, preferred?: string): string { return namespaceForVerifiedBot(this.db, botId, preferred); }

  // Per-bot state
  botState(key: string, botKey: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM telegram_bot_state WHERE key = ? AND bot_key = ?").get(key, botKey) as { value: string } | undefined;
    return row?.value;
  }
  setBotState(key: string, value: string, botKey: string) {
    this.db.prepare(
      "INSERT INTO telegram_bot_state (key, value, bot_key) VALUES (?, ?, ?) ON CONFLICT(bot_key, key) DO UPDATE SET value = excluded.value",
    ).run(key, value, botKey);
  }

  // Route reconciliation
  allPendingJobs(): TelegramJob[] {
    return this.db.prepare("SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_pending").all() as TelegramJob[];
  }
  openFailures(): Array<TelegramJob & { id: string }> {
    return this.db.prepare("SELECT id, seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_failures WHERE resolved_at IS NULL AND destination_invalidated = 0")
      .all() as Array<TelegramJob & { id: string }>;
  }
  invalidateFailureDestination(id: string) {
    this.db.prepare("UPDATE telegram_failures SET destination_invalidated = 1 WHERE id = ?").run(id);
  }
  openUpdateFailures(botKey: string): Array<TelegramUpdateScope & { id: string }> {
    return this.db.prepare("SELECT id, bot_key AS botKey, telegram_chat_id AS chatId, project_id AS projectId FROM telegram_update_failures WHERE bot_key = ? AND state IN ('retry', 'quarantined')")
      .all(botKey) as Array<TelegramUpdateScope & { id: string }>;
  }
  invalidateUpdateFailure(id: string) {
    this.db.prepare(
      "UPDATE telegram_update_failures SET invalidated = 1, state = 'quarantined', last_error = 'destination_changed', updated_at = ? WHERE id = ?",
    ).run(Date.now(), id);
  }
  channelRoutes(table: "telegram_topics" | "telegram_out", botKey: string): Row[] {
    return this.db.prepare(`SELECT rowid AS rowId, channel_id AS channelId, telegram_chat_id AS chatId FROM ${table} WHERE bot_key = ?`).all(botKey) as Row[];
  }
  deleteChannelRoute(table: "telegram_topics" | "telegram_out", rowId: number) {
    this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowId);
  }

  // Topics
  topicFor(channelId: string, botKey: string, chatId: number): number | undefined {
    const row = this.db.prepare("SELECT telegram_thread_id AS id FROM telegram_topics WHERE channel_id = ? AND bot_key = ? AND telegram_chat_id = ?").get(
      channelId, botKey, chatId,
    ) as { id: number } | undefined;
    return row?.id;
  }
  saveTopic(channelId: string, threadId: number, chatId: number, botKey: string) {
    this.db.prepare(
      "INSERT OR REPLACE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id, bot_key) VALUES (?, ?, ?, ?)",
    ).run(channelId, threadId, chatId, botKey);
  }
  channelForTopic(threadId: number, chatId: number, botKey: string): string | undefined {
    const row = this.db.prepare(
      "SELECT channel_id AS id FROM telegram_topics WHERE telegram_thread_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(threadId, chatId, botKey) as { id: string } | undefined;
    return row?.id;
  }

  // Inbound updates
  recordUpdateFailure(scope: TelegramUpdateScope, update: TelegramUpdate, error: string, options: { permanent?: boolean; retryAt?: number }) {
    recordTelegramUpdateFailure(this.db, scope, update, error, options);
  }
  acknowledgeUpdate(botKey: string, updateId: number) { acknowledgeTelegramUpdate(this.db, botKey, updateId); }
  finishUpdate(botKey: string, updateId: number) { finishTelegramUpdate(this.db, botKey, updateId); }
  handoffUpdates(entries: ReadonlyArray<{ scope: TelegramUpdateScope; update: TelegramUpdate }>) { handoffTelegramUpdates(this.db, entries); }
  dueUpdate(botKey: string): TelegramUpdateFailure | undefined { return dueTelegramUpdate(this.db, botKey); }
  nextUpdateRetry(botKey: string): number | undefined { return nextTelegramUpdateRetry(this.db, botKey); }
  isRetryingUpdate(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM telegram_update_failures WHERE id = ? AND state = 'retry'").get(id));
  }
  quarantineChangedUpdate(id: string) {
    this.db.prepare("UPDATE telegram_update_failures SET state = 'quarantined', invalidated = 1, last_error = 'destination_changed', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }
  quarantineInvalidPayload(id: string) {
    this.db.prepare("UPDATE telegram_update_failures SET state = 'quarantined', last_error = 'invalid_stored_payload', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }
  seenUpdate(updateId: number, botKey: string): boolean {
    return Boolean(this.db.prepare("SELECT update_id FROM telegram_in WHERE update_id = ? AND bot_key = ?").get(updateId, botKey));
  }

  // Message mappings (telegram_out)
  inboundSeq(messageId: number, chatId: number, botKey: string): { seq: number } | undefined {
    return this.db.prepare(
      "SELECT seq FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(messageId, chatId, botKey) as { seq: number } | undefined;
  }
  mappedMessage(messageId: number, chatId: number, botKey: string): TelegramOutMapping | undefined {
    return this.db.prepare(
      "SELECT seq, channel_id AS channelId, thread_id AS threadId FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(messageId, chatId, botKey) as TelegramOutMapping | undefined;
  }
  isMapped(botKey: string, chatId: number, messageId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM telegram_out WHERE bot_key = ? AND telegram_chat_id = ? AND telegram_message_id = ?")
      .get(botKey, chatId, messageId));
  }
  saveInboundMapping(chatId: number, messageId: number, seq: number, channelId: string, threadId: string | null, botKey: string) {
    this.db.prepare(`INSERT OR REPLACE INTO telegram_out
        (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id, bot_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chatId, messageId, seq, channelId, threadId, botKey);
  }
  deliveredMessageIds(seq: number, chatId: number, botKey: string): { id: number }[] {
    return this.db.prepare(
      "SELECT telegram_message_id AS id FROM telegram_out WHERE seq = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).all(seq, chatId, botKey) as { id: number }[];
  }
  /** One delivered part: its message mapping and completion marker, atomically. */
  recordDeliveredPart(chatId: number, messageId: number, seq: number, channelId: string, threadId: string | null, partKey: string, botKey: string) {
    this.storage.transaction(() => {
      this.db.prepare(
        `INSERT OR REPLACE INTO telegram_out
          (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id, bot_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(chatId, messageId, seq, channelId, threadId, botKey);
      this.db.prepare(
        `INSERT OR REPLACE INTO telegram_delivery_parts
          (seq, part_key, telegram_chat_id, telegram_message_id, completed_at, bot_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(seq, partKey, chatId, messageId, Date.now(), botKey);
    });
  }

  // Held messages (topic not mapped yet)
  holdMessage(chatId: number, messageId: number, threadId: number, payload: string, botKey: string, projectId: string | null, updateId: number | null) {
    this.db.prepare(
      "INSERT OR REPLACE INTO telegram_hold (telegram_chat_id, telegram_message_id, telegram_thread_id, payload, bot_key, project_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, messageId, threadId, payload, botKey, projectId, updateId);
  }
  heldMessages(threadId: number, chatId: number, botKey: string, projectId: string | null): { payload: string; updateId: number | null; messageId: number }[] {
    return this.db.prepare(
      "SELECT payload, update_id AS updateId, telegram_message_id AS messageId FROM telegram_hold WHERE telegram_thread_id = ? AND telegram_chat_id = ? AND bot_key = ? AND project_id = ?",
    ).all(threadId, chatId, botKey, projectId) as { payload: string; updateId: number | null; messageId: number }[];
  }
  releaseHeld(botKey: string, chatId: number, messageId: number) {
    this.db.prepare("DELETE FROM telegram_hold WHERE bot_key = ? AND telegram_chat_id = ? AND telegram_message_id = ?")
      .run(botKey, chatId, messageId);
  }

  // Outbound queue
  enqueuePending(seq: number, kind: TelegramJob["kind"], destination: TelegramDestination) {
    enqueueTelegramPending(this.db, seq, kind, undefined, destination);
  }
  failJob(job: TelegramJob, reason: string, attempts: number) { failTelegramJob(this.db, job, reason, attempts); }
  pendingJobs(): TelegramJob[] {
    return this.db.prepare(
      "SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId, attempts, first_attempt_at AS firstAttemptAt, revision FROM telegram_pending ORDER BY seq ASC, kind ASC",
    ).all() as TelegramJob[];
  }
  clearPending(job: TelegramJob) {
    this.db.prepare("DELETE FROM telegram_pending WHERE seq = ? AND kind = ? AND revision = ?").run(job.seq, job.kind, job.revision ?? 0);
  }
  pendingRevision(seq: number, kind: TelegramJob["kind"]): { revision: number } | undefined {
    return this.db.prepare("SELECT revision FROM telegram_pending WHERE seq = ? AND kind = ?").get(seq, kind) as { revision: number } | undefined;
  }
  recordAttempt(seq: number, kind: TelegramJob["kind"], attempts: number, firstAttemptAt: number) {
    this.db.prepare("UPDATE telegram_pending SET attempts = ?, first_attempt_at = ? WHERE seq = ? AND kind = ?")
      .run(attempts, firstAttemptAt, seq, kind);
  }
  hasLegacyParts(seq: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM telegram_delivery_parts WHERE seq = ? AND bot_key = '' LIMIT 1").get(seq));
  }
  partDelivered(seq: number, partKey: string, chatId: number, botKey: string): boolean {
    return telegramPartDelivered(this.db, seq, partKey, chatId, botKey);
  }
}
