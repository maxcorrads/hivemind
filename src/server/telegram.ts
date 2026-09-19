import { createHash, randomUUID } from "node:crypto";
import { initTelegramRouting, namespaceForVerifiedBot } from "./telegram-routing.ts";
import { TelegramRateLimitError, telegramRetryAfterMs, selectTelegramPendingJob } from "./telegram-rate-limit.ts";
export { TelegramRateLimitError, telegramRetryAfterMs, selectTelegramPendingJob } from "./telegram-rate-limit.ts";
import { enqueueTelegramPending, failTelegramJob, telegramBotKey, telegramPartDelivered, sameTelegramDestination, type TelegramDestination, type TelegramJob } from "./telegram-outbox.ts";
export { enqueueTelegramPending, recordTelegramFailure, telegramPartDelivered, TELEGRAM_PENDING_CAP } from "./telegram-outbox.ts";
import { handoffTelegramUpdates, recordTelegramUpdateFailure, finishTelegramUpdate, acknowledgeTelegramUpdate, dueTelegramUpdate, nextTelegramUpdateRetry,
  telegramPollBackoffMs, isTelegramTerminalPollError, TelegramPermanentUpdateError, validTelegramUpdateId,
  type TelegramUpdate, type TelegramUpdateScope } from "./telegram-inbox.ts";
export { telegramPollBackoffMs, isTelegramTerminalPollError } from "./telegram-inbox.ts";
import { CoalescingPump } from "./coalescing-pump.ts";
import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_SLUG, FILE_MAX_BYTES, HiveError, HUMAN_ID, REACTION_EMOJIS, type Channel, type Message } from "../shared/types.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { isDirectRecipient } from '../shared/message-target.ts';
import { resolveUploadMime } from "../shared/mime.ts";
import { Hive, channelLabel } from "./hive.ts";
import { hiveHome } from "./paths.ts";
import { filePathForHash, safeFileName } from "./files.ts";

export type TelegramConfig = {
  botToken: string;
  botId?: number;
  botNamespace?: string;
  allowUserIds: number[];
  groups: Record<string, number>;
};

export type TelegramFile = {
  botToken: string;
  botId?: number;
  botNamespace?: string;
  allowUserIds: number[];
  projects: Record<string, number>;
};

export function telegramConfigPath(home = hiveHome()): string {
  return path.join(home, "telegram.json");
}

export function maskTelegramToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 8) return "set";
  return `…${trimmed.slice(-4)}`;
}

export function readTelegramFile(home = hiveHome()): TelegramFile | null {
  const file = telegramConfigPath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      botToken?: string;
      botId?: number;
      botNamespace?: string;
      verifiedTokenHash?: string;
      groupChatId?: number;
      allowUserIds?: Array<number | string>;
      projects?: Record<string, { groupChatId?: number } | number>;
    };
    const botToken = String(raw.botToken ?? "").trim();
    if (!Array.isArray(raw.allowUserIds ?? [])) return null;
    const allowUserIds = [...new Set((raw.allowUserIds ?? []).map(n => Number(n)))];
    if (allowUserIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
    const projects: Record<string, number> = {};
    if (raw.projects !== undefined && (!raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects))) return null;
    if (raw.projects && typeof raw.projects === "object") {
      for (const [slug, value] of Object.entries(raw.projects)) {
        const id = typeof value === "number" || typeof value === "string" ? Number(value) : Number(value?.groupChatId);
        if (!slug || parseProjectSlug(slug) !== slug || !Number.isSafeInteger(id) || id === 0 || Object.values(projects).includes(id)) return null;
        projects[slug] = id;
      }
    }
    const legacy = Number(raw.groupChatId);
    if (raw.groupChatId !== undefined && projects[DEFAULT_PROJECT_SLUG] === undefined) {
      if (!Number.isSafeInteger(legacy) || legacy === 0 || Object.values(projects).includes(legacy)) return null;
      projects[DEFAULT_PROJECT_SLUG] = legacy;
    }
    if (!botToken && allowUserIds.length === 0 && Object.keys(projects).length === 0) return null;
    const verified = raw.verifiedTokenHash === tokenFingerprint(botToken) && Number.isSafeInteger(raw.botId) && Number(raw.botId) > 0 &&
      typeof raw.botNamespace === "string" && /^(bot:[0-9]+|credential:[a-f0-9]{64})$/.test(raw.botNamespace);
    return { botToken, allowUserIds, projects, ...(verified ? { botId: raw.botId, botNamespace: raw.botNamespace } : {}) };
  } catch {
    return null;
  }
}

export function loadTelegramConfig(home = hiveHome()): TelegramConfig | null {
  const file = readTelegramFile(home);
  if (!file?.botToken || file.allowUserIds.length === 0 || Object.keys(file.projects).length === 0) return null;
  return { botToken: file.botToken, botId: file.botId, botNamespace: file.botNamespace, allowUserIds: file.allowUserIds, groups: file.projects };
}

export function publicTelegramView(home = hiveHome(), running = false) {
  const file = readTelegramFile(home);
  return {
    running,
    configured: Boolean(loadTelegramConfig(home)),
    tokenSet: Boolean(file?.botToken),
    tokenHint: file?.botToken ? maskTelegramToken(file.botToken) : null,
    allowUserIds: file?.allowUserIds ?? [],
    projects: file?.projects ?? {},
  };
}

export type TelegramFileInput = {
  botToken?: string | null;
  allowUserIds?: Array<number | string>;
  projects?: Record<string, { groupChatId?: number | string | null } | number | string | null>;
};

function tokenFingerprint(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function telegramConfigKey(config: Pick<TelegramConfig, "botToken" | "botId" | "botNamespace">): string {
  return config.botNamespace ?? telegramBotKey(config.botToken, config.botId);
}

export function prepareTelegramFile(input: TelegramFileInput, home = hiveHome()): TelegramFile {
  const prev = readTelegramFile(home);
  if (input.botToken != null && typeof input.botToken !== "string") throw new HiveError(400, "Invalid bot token");
  const botToken = input.botToken?.trim() || prev?.botToken || "";
  if (!botToken) throw new HiveError(400, "Bot token required");
  if (input.allowUserIds !== undefined && !Array.isArray(input.allowUserIds)) throw new HiveError(400, "Invalid Telegram users");
  const allowUserIds = [...new Set((input.allowUserIds ?? prev?.allowUserIds ?? []).map(raw => {
    const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HiveError(400, "Invalid Telegram user id");
    return n;
  }))];
  if (!allowUserIds.length) throw new HiveError(400, "At least one Telegram user id");
  const projects: Record<string, number> = {};
  const owners = new Map<number, string>();
  if (input.projects !== undefined && (!input.projects || typeof input.projects !== "object" || Array.isArray(input.projects))) throw new HiveError(400, "Invalid project routes");
  for (const [rawSlug, value] of Object.entries(input.projects ?? {})) {
    const slug = parseProjectSlug(rawSlug);
    if (Object.hasOwn(projects, slug)) throw new HiveError(400, "Duplicate project route");
    const raw = value && typeof value === "object" ? value.groupChatId : value;
    const id = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id === 0) throw new HiveError(400, `Invalid Telegram group id for ${slug}`);
    if (owners.has(id)) throw new HiveError(400, `Telegram group ${id} is already assigned to project ${owners.get(id)}`);
    owners.set(id, slug); projects[slug] = id;
  }
  return { botToken, allowUserIds, projects, ...(prev?.botToken === botToken ? { botId: prev.botId, botNamespace: prev.botNamespace } : {}) };
}

/** Publish one private, complete configuration. Interrupted writes leave the previous file intact. */
function persistTelegramFile(file: TelegramFile, home: string): void {
  mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `.telegram-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ ...file, verifiedTokenHash: file.botId ? tokenFingerprint(file.botToken) : undefined }, null, 2) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, telegramConfigPath(home));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function writeTelegramFile(input: TelegramFileInput, home = hiveHome()): TelegramFile {
  const next = prepareTelegramFile(input, home);
  persistTelegramFile(next, home);
  return next;
}

export function removeTelegramProjectSlug(slug: string, home = hiveHome()): TelegramFile | null {
  const prev = readTelegramFile(home);
  if (!prev) return null;
  let parsed: string;
  try { parsed = parseProjectSlug(slug); } catch { return prev; }
  if (!Object.hasOwn(prev.projects, parsed)) return prev;
  const next = { ...prev, projects: { ...prev.projects } };
  delete next.projects[parsed];
  persistTelegramFile(next, home);
  return next;
}

async function verifyBot(token: string, signal: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Telegram identity verification timed out")), 10_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const result = await response.json() as { ok?: boolean; result?: { id?: number; is_bot?: boolean } };
    if (!response.ok || !result.ok || result.result?.is_bot !== true || !Number.isSafeInteger(result.result.id) || Number(result.result.id) <= 0) throw new Error("Invalid bot identity");
    return result.result.id!;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new HiveError(400, "Unable to verify Telegram bot identity; previous configuration unchanged");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export function chatIdForProject(cfg: TelegramConfig, slug: string | null | undefined): number | undefined {
  if (!slug) return undefined;
  return cfg.groups[slug];
}

export function projectSlugForChat(cfg: TelegramConfig, chatId: number): string | undefined {
  const matches = Object.entries(cfg.groups).filter(([, id]) => id === chatId);
  return matches.length === 1 ? matches[0]![0] : undefined;
}

export function shouldNotify(msg: Message, ch: Channel, muted: boolean): boolean {
  if (muted) return false;
  if (msg.kind !== "chat") return false;
  if (isDirectRecipient(msg, HUMAN_ID)) return true;
  if (ch.type === "brains") return true;
  if (ch.type === "dm" && ch.memberIds.includes(HUMAN_ID) && msg.authorRole === "brain") return true;
  return false;
}

export function formatOutbound(msg: Message): string {
  const body = msg.body.slice(0, 4000);
  return `${msg.authorName}\n${body}`.slice(0, 4096);
}

export function reactionIgnoreKey(chatId: number, telegramMessageId: number, emojis: string[]): string {
  return `${chatId}:${telegramMessageId}:${[...emojis].sort().join(",")}`;
}

export function telegramReplyThreadId(
  mapped: { channelId: string; threadId: string | null } | null | undefined,
  original: Pick<Message, "id" | "channelId" | "threadId"> | null | undefined,
  inboundChannelId: string,
): string | null {
  if (!mapped || !original) return null;
  if (mapped.channelId !== inboundChannelId || original.channelId !== inboundChannelId) return null;
  return original.threadId ?? original.id;
}

export function inboundBody(firstName: string | undefined, text: string): string {
  const name = (firstName ?? "Human").replaceAll("[", "").replaceAll("]", "").slice(0, 40);
  const trimmed = text.trim();
  return (trimmed ? `[${name}] ${trimmed}` : `[${name}]`).slice(0, 4000);
}

export function inboundPostBody(firstName: string | undefined, text: string, hasFiles: boolean): string {
  const trimmed = text.trim();
  if (!trimmed && hasFiles) return "";
  return inboundBody(firstName, trimmed);
}

type ApiResult = {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: unknown;
};

export function requireTelegramOk(sent: ApiResult, what: string): ApiResult {
  if (!sent.ok) throw new Error(sent.description ?? `telegram ${what} failed`);
  return sent;
}

export const TELEGRAM_PENDING_GIVE_UP = 5;

export function telegramJobKey(seq: number, kind: string): string {
  return `${seq}:${kind}`;
}

export function nextTelegramFailure(
  prev: { key: string; n: number } | null,
  seq: number,
  kind: string,
): { key: string; n: number } {
  const key = telegramJobKey(seq, kind);
  if (prev?.key === key) return { key, n: prev.n + 1 };
  return { key, n: 1 };
}

export function shouldDropTelegramJob(failures: number, giveUp = TELEGRAM_PENDING_GIVE_UP): boolean {
  return failures >= giveUp;
}

export function isTelegramTopicRightsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not enough rights|bot needs Manage Topics/i.test(msg);
}

/** Telegram's setMessageReaction allow-list is not the hive set. These stand-ins stay 1:1. */
export const TELEGRAM_REACTION_OUT: Record<(typeof REACTION_EMOJIS)[number], string> = {
  "👍": "👍",
  "👎": "👎",
  "👀": "👀",
  "🚩": "⚡",
  "✅": "💯",
  "❓": "🤔",
};

export const TELEGRAM_REACTION_IN: Record<string, string> = Object.fromEntries(
  Object.entries(TELEGRAM_REACTION_OUT).map(([hive, tg]) => [tg, hive]),
);

export function telegramOutboundReactionPayload(
  emojis: Iterable<string>,
): Array<{ type: "emoji"; emoji: string }> {
  const present = new Set(emojis);
  const hive = REACTION_EMOJIS.find((emoji) => present.has(emoji));
  if (!hive) return [];
  return [{ type: "emoji", emoji: TELEGRAM_REACTION_OUT[hive] }];
}

export function hiveEmojiFromTelegram(emoji: string): string | undefined {
  return TELEGRAM_REACTION_IN[emoji];
}

export function isTelegramPermanentOutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /REACTION_INVALID|MESSAGE_ID_INVALID|message to react not found|chat not found/i.test(msg);
}

export function telegramFileTooLarge(fileSize: number | undefined, cap = FILE_MAX_BYTES): boolean {
  return fileSize != null && fileSize > cap;
}

export function telegramMessageHasFiles(message: { photo?: unknown[]; document?: unknown }): boolean {
  return Boolean((message.photo && message.photo.length > 0) || message.document);
}

export function telegramGeneralThreadId(ch: Channel | string): number | null {
  if (typeof ch === "string") return ch === "general" || ch.endsWith(":general") ? 1 : null;
  return ch.name === "general" && ch.type === "public" ? 1 : null;
}

export function telegramDestinationForSeq(hive: Hive, seq: number, cfg = loadTelegramConfig(hive.home)): TelegramDestination | undefined {
  if (!cfg) return undefined;
  try {
    const msg = hive.getMessageBySeq(seq);
    const channel = hive.getChannel(msg.channelId);
    const chatId = cfg.groups[channel.project];
    if (!Number.isSafeInteger(chatId) || chatId === 0) return undefined;
    return { botKey: telegramConfigKey(cfg), chatId: chatId! };
  } catch { return undefined; }
}

export type TelegramHandle = {
  stop: () => Promise<void>;
  running: () => boolean;
  reload: () => Promise<boolean>;
  configure: (input: TelegramFileInput) => Promise<boolean>;
};

export function startTelegram(hive: Hive, enabled = true): TelegramHandle {
  let bridge: TelegramBridge | null = null;
  let lifecycle: Promise<void> = Promise.resolve();
  const stopped = new AbortController();
  const boot = () => {
    if (!enabled || stopped.signal.aborted) return false;
    const cfg = loadTelegramConfig(hive.home);
    if (!cfg) return false;
    try {
      bridge = new TelegramBridge(hive, cfg);
      hive.db.prepare("DELETE FROM telegram_state WHERE key = 'inbound:configuration_error'").run();
      bridge.start(); return true;
    } catch (error) {
      bridge = null;
      if (!(error instanceof HiveError)) throw error;
      hive.db.prepare("INSERT INTO telegram_state(key, value) VALUES('inbound:configuration_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run("Invalid Telegram project configuration; edit Telegram settings to recover");
      hive.publishTelegramHealth();
      return false;
    }
  };
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(op, op);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };
  boot();
  return {
    stop: () => {
      stopped.abort(new Error("Telegram handle stopped"));
      return serial(async () => { const current = bridge; bridge = null; await current?.stop(); });
    },
    running: () => Boolean(bridge),
    reload: () => serial(async () => {
      const current = bridge; bridge = null;
      const detach = current?.captureDuringDrain();
      try { await current?.stop(); } finally { detach?.(); }
      return boot();
    }),
    configure: input => serial(async () => {
      stopped.signal.throwIfAborted();
      // Validate and verify before stopping the existing healthy bridge or publishing anything.
      const next = prepareTelegramFile(input, hive.home);
      for (const slug of Object.keys(next.projects)) if (!hive.findProjectBySlug(slug)) throw new HiveError(404, `No project named ${slug}`);
      const botId = await verifyBot(next.botToken, stopped.signal);
      stopped.signal.throwIfAborted();
      const previous = loadTelegramConfig(hive.home);
      initTelegramRouting(hive.db, previous ? telegramConfigKey(previous) : `bot:${botId}`);
      const current = bridge; bridge = null;
      const detach = current?.captureDuringDrain();
      const draining = current?.stop(); // removes old event admission synchronously
      try {
        await draining;
        stopped.signal.throwIfAborted();
        // Registering the verified ID is additive: failure before file publication cannot invalidate old jobs.
        const preferred = previous?.botToken === next.botToken || previous?.botId === botId ? telegramConfigKey(previous!) : undefined;
        next.botId = botId;
        next.botNamespace = namespaceForVerifiedBot(hive.db, botId, preferred);
        persistTelegramFile(next, hive.home);
      } finally {
        detach?.();
        boot(); // On publication failure the intact old file restarts; after publication the new file wins.
        hive.publishTelegramHealth();
      }
      return Boolean(bridge);
    }),
  };
}

export class TelegramBridge {
  private stopped = false;
  private handoffError: Error | undefined;
  private started = false;
  private incoming: Promise<void> = Promise.resolve();
  private readonly inboundRetries: CoalescingPump;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryWakeAt: number | undefined;
  private abort = new AbortController();
  private lastServedChat: number | undefined;
  private topicRightsHinted = false;
  private topicLocks = new Map<string, Promise<number | null>>();
  private poll: Promise<void> | null = null;
  private readonly outbound: CoalescingPump;
  private ignoreReaction = new Map<string, number>();
  private skipChatUntil = new Map<number, number>();
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownWakeAt: number | undefined;

  constructor(
    private hive: Hive,
    private cfg: TelegramConfig,
  ) {
    if (!cfg.botToken || !cfg.allowUserIds.length || cfg.allowUserIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        Object.values(cfg.groups).some(id => !Number.isSafeInteger(id) || id === 0) ||
        new Set(Object.values(cfg.groups)).size !== Object.keys(cfg.groups).length ||
        Object.keys(cfg.groups).some(slug => !hive.findProjectBySlug(slug))) {
      throw new HiveError(400, "Invalid or ambiguous Telegram configuration");
    }
    this.cfg = { ...cfg, groups: { ...cfg.groups }, allowUserIds: [...cfg.allowUserIds] };
    initTelegramRouting(hive.db, telegramConfigKey(cfg));
    this.reconcileRoutes();
    this.inboundRetries = new CoalescingPump(() => this.replayFailedUpdates(), error => {
      if (!this.stopped) { console.error("telegram replay", this.safeError(error)); this.scheduleRetry(Date.now() + 2_000); }
    });
    this.outbound = new CoalescingPump(() => this.pump(), error => {
      if (!this.stopped) console.error("telegram pump", error instanceof Error ? error.message : error);
    });
  }

  private reconcileRoutes() {
    // Cancel stale work at the transition, not only when a later pump happens to visit it.
    // Cancellation is sticky: A -> B -> A must not revive old historical jobs.
    const jobs = this.hive.db.prepare("SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_pending").all() as TelegramJob[];
    for (const job of jobs) if (!sameTelegramDestination(job, telegramDestinationForSeq(this.hive, job.seq, this.cfg))) {
      failTelegramJob(this.hive.db, job, "destination_changed_or_unknown", 0);
    }
    const failures = this.hive.db.prepare("SELECT id, seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_failures WHERE resolved_at IS NULL AND destination_invalidated = 0")
      .all() as Array<TelegramJob & { id: string }>;
    for (const row of failures) if (!sameTelegramDestination(row, telegramDestinationForSeq(this.hive, row.seq, this.cfg))) {
      this.hive.db.prepare("UPDATE telegram_failures SET destination_invalidated = 1 WHERE id = ?").run(row.id);
    }
    const botKey = telegramConfigKey(this.cfg);
    const inbound = this.hive.db.prepare("SELECT id, bot_key AS botKey, telegram_chat_id AS chatId, project_id AS projectId FROM telegram_update_failures WHERE bot_key = ? AND state IN ('retry', 'quarantined')")
      .all(botKey) as Array<TelegramUpdateScope & { id: string }>;
    for (const row of inbound) if (!this.scopeMatches(row)) this.hive.db.prepare(
      "UPDATE telegram_update_failures SET invalidated = 1, state = 'quarantined', last_error = 'destination_changed', updated_at = ? WHERE id = ?",
    ).run(Date.now(), row.id);
    for (const table of ["telegram_topics", "telegram_out"]) {
      const rows = this.hive.db.prepare(`SELECT rowid AS rowId, channel_id AS channelId, telegram_chat_id AS chatId FROM ${table} WHERE bot_key = ?`).all(botKey) as { rowId: number; channelId: string; chatId: number }[];
      for (const row of rows) {
        let matches = false;
        try { matches = this.cfg.groups[this.hive.getChannel(row.channelId).project] === row.chatId; } catch { /* deleted channel */ }
        if (!matches) this.hive.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(row.rowId);
      }
    }
  }

  captureDuringDrain(): () => void {
    const capture = (seq: number, kind: "message" | "reaction") => {
      const destination = telegramDestinationForSeq(this.hive, seq, this.cfg);
      if (destination) enqueueTelegramPending(this.hive.db, seq, kind, undefined, destination);
    };
    const message = (msg: Message) => {
      if (msg.kind === "chat" && !this.hive.fromTelegram(msg.id)) capture(msg.seq, "message");
    };
    const reaction = (body: { seq?: number; message?: Message }) => {
      const seq = body.message?.seq ?? body.seq;
      if (seq !== undefined) capture(seq, "reaction");
    };
    this.hive.bus.on("message", message);
    this.hive.bus.on("reaction", reaction);
    return () => { this.hive.bus.off("message", message); this.hive.bus.off("reaction", reaction); };
  }

  private chatForChannel(ch: Channel): number | undefined {
    return chatIdForProject(this.cfg, ch.project);
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.hive.db.prepare("INSERT INTO telegram_state(key, value) VALUES('inbound:active_bot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(telegramConfigKey(this.cfg));
    this.hive.bus.on("telegram-inbox-wake", this.onInboxWake);
    this.inboundRetries.wake();
    this.hive.bus.on("message", this.onHiveMessage);
    this.hive.bus.on("reaction", this.onHiveReaction);
    this.hive.bus.on("telegram-outbox-wake", this.onOutboxWake);
    this.poll = this.pollLoop().catch(error => {
      if (!this.stopped) console.error("telegram poll stopped", error instanceof Error ? error.message : error);
    });
    this.kickPump();
    console.error("hivemind telegram bridge on");
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.cooldownTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryWakeAt = undefined;
    this.hive.bus.off("telegram-inbox-wake", this.onInboxWake);
    this.cooldownTimer = undefined;
    this.cooldownWakeAt = undefined;
    this.abort.abort(new DOMException("Telegram bridge stopped", "AbortError"));
    this.hive.bus.off("message", this.onHiveMessage);
    this.hive.bus.off("reaction", this.onHiveReaction);
    this.hive.bus.off("telegram-outbox-wake", this.onOutboxWake);
    await Promise.allSettled([this.poll, this.outbound.stop(), this.inboundRetries.stop(), this.incoming, ...this.topicLocks.values()]);
    if (this.handoffError) throw this.handoffError;
  }

  private ensureActive() {
    if (this.stopped || this.abort.signal.aborted) {
      throw this.abort.signal.reason ?? new DOMException("Telegram bridge stopped", "AbortError");
    }
  }

  private kickPump() {
    this.outbound.wake();
  }

  private onOutboxWake = () => this.kickPump();

  private onHiveMessage = (payload: unknown) => {
    const msg = payload as Message;
    if (!msg?.id || this.hive.fromTelegram(msg.id)) return;
    if (msg.kind !== "chat") return;
    this.queuePending(msg.seq, "message");
  };

  private onHiveReaction = (payload: unknown) => {
    const body = payload as { message?: Message; seq?: number };
    const seq = body.message?.seq ?? body.seq;
    if (seq == null) return;
    this.queuePending(seq, "reaction");
  };

  private async ensureTopic(ch: Channel): Promise<number | null> {
    const chatId = this.chatForChannel(ch);
    if (chatId == null) return null;
    const row = this.hive.db.prepare("SELECT telegram_thread_id AS id FROM telegram_topics WHERE channel_id = ? AND bot_key = ? AND telegram_chat_id = ?").get(
      ch.id, telegramConfigKey(this.cfg), chatId,
    ) as { id: number } | undefined;
    if (row) return row.id;
    const generalThread = telegramGeneralThreadId(ch);
    if (generalThread != null) {
      this.hive.db.prepare(
        "INSERT OR REPLACE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id, bot_key) VALUES (?, ?, ?, ?)",
      ).run(ch.id, generalThread, chatId, telegramConfigKey(this.cfg));
      await this.flushHolds(chatId, generalThread);
      return generalThread;
    }
    const pending = this.topicLocks.get(ch.id);
    if (pending) return pending;
    const work = this.createTopic(ch);
    this.topicLocks.set(ch.id, work);
    try {
      return await work;
    } finally {
      this.topicLocks.delete(ch.id);
    }
  }

  private hintTopicRights() {
    if (this.topicRightsHinted) return;
    this.topicRightsHinted = true;
    console.error(
      "telegram: the bot is admin but Manage Topics is off. In the forum group: Administrators → the bot → enable Manage Topics.",
    );
  }

  private async createTopic(ch: Channel): Promise<number | null> {
    const chatId = this.chatForChannel(ch);
    if (chatId == null) return null;
    const again = this.hive.db.prepare("SELECT telegram_thread_id AS id FROM telegram_topics WHERE channel_id = ? AND bot_key = ? AND telegram_chat_id = ?").get(
      ch.id, telegramConfigKey(this.cfg), chatId,
    ) as { id: number } | undefined;
    if (again) return again.id;
    const name = channelLabel(ch).slice(0, 128);
    const created = await this.api("createForumTopic", { chat_id: chatId, name });
    this.ensureActive();
    const result = created.result as { message_thread_id?: number } | undefined;
    if (!created.ok || !result?.message_thread_id) {
      const description = created.description ?? "";
      console.error("telegram createForumTopic failed", description);
      if (/not enough rights/i.test(description)) {
        this.hintTopicRights();
        throw new Error("telegram topic not ready: bot needs Manage Topics");
      }
      return null;
    }
    if (!this.hive.db.prepare("SELECT id FROM channels WHERE id = ?").get(ch.id)) return null;
    this.hive.db.prepare(
      "INSERT OR REPLACE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id, bot_key) VALUES (?, ?, ?, ?)",
    ).run(ch.id, result.message_thread_id, chatId, telegramConfigKey(this.cfg));
    await this.flushHolds(chatId, result.message_thread_id);
    return result.message_thread_id;
  }

  private serializeInbound(op: () => Promise<void>): Promise<void> {
    const next = this.incoming.then(async () => { this.ensureActive(); await op(); });
    this.incoming = next.catch(() => undefined);
    return next;
  }

  private updateScope(update: TelegramUpdate): TelegramUpdateScope {
    const value = (update.message ?? update.message_reaction) as { chat?: { id?: number } } | undefined;
    const chatId = Number(value?.chat?.id);
    const slug = projectSlugForChat(this.cfg, chatId);
    return { botKey: telegramConfigKey(this.cfg), chatId: Number.isSafeInteger(chatId) ? chatId : null,
      projectId: slug ? this.hive.findProjectBySlug(slug)?.id ?? null : null };
  }

  private scopeMatches(scope: TelegramUpdateScope): boolean {
    if (scope.botKey !== telegramConfigKey(this.cfg) || scope.chatId === null || !scope.projectId) return false;
    const slug = projectSlugForChat(this.cfg, scope.chatId);
    return Boolean(slug && this.hive.findProjectBySlug(slug)?.id === scope.projectId);
  }

  private async processUpdate(update: TelegramUpdate, allowed: () => boolean = () => true) {
    if (update.message !== undefined) {
      const message = update.message as TelegramMessage;
      if (!message || typeof message !== "object" || !Number.isSafeInteger(message.message_id) ||
          !Number.isSafeInteger(message.chat?.id) ||
          (message.photo !== undefined && (!Array.isArray(message.photo) || message.photo.some(p => !p || typeof p.file_id !== "string"))) ||
          (message.document !== undefined && (!message.document || typeof message.document.file_id !== "string"))) {
        throw new TelegramPermanentUpdateError("Malformed Telegram message");
      }
      await this.onTelegramMessage(message, allowed, update.update_id);
    }
    if (update.message_reaction !== undefined) {
      const reaction = update.message_reaction as TelegramReaction;
      if (!reaction || !Number.isSafeInteger(reaction.message_id) || !Number.isSafeInteger(reaction.chat?.id) ||
          (reaction.new_reaction !== undefined && !Array.isArray(reaction.new_reaction)) ||
          (reaction.old_reaction !== undefined && !Array.isArray(reaction.old_reaction))) {
        throw new TelegramPermanentUpdateError("Malformed Telegram reaction");
      }
      if (allowed()) await this.onTelegramReaction(reaction);
    }
  }

  private recordUpdateError(scope: TelegramUpdateScope, update: TelegramUpdate, error: unknown) {
    this.ensureActive();
    if (error instanceof TelegramRateLimitError && scope.chatId !== null) this.coolDown(scope.chatId, error.retryAt);
    recordTelegramUpdateFailure(this.hive.db, scope, update, this.safeError(error), {
      permanent: error instanceof TelegramPermanentUpdateError,
      retryAt: error instanceof TelegramRateLimitError ? error.retryAt : undefined,
    });
    this.hive.publishTelegramHealth();
    this.inboundRetries.wake();
  }

  private async pollLoop() {
    let failures = 0;
    while (!this.stopped) {
      try {
        const offset = Number(this.state("offset") ?? "0");
        const data = await this.api("getUpdates", { offset: offset || undefined, timeout: 25, allowed_updates: ["message", "message_reaction"] });
        this.ensureActive();
        if (!data.ok || !Array.isArray(data.result)) {
          throw new Error(data.description ?? "Invalid Telegram getUpdates response");
        }
        failures = 0;
        this.setState("poll:last_success", String(Date.now()));
        this.setState("poll:last_error", "");
        this.hive.publishTelegramHealth();
        let malformedEnvelope = false;
        // Freeze all original project identities before the first processing await.
        const accepted: Array<{ update: TelegramUpdate; scope: TelegramUpdateScope }> = [];
        for (const raw of data.result) {
          if (!raw || !validTelegramUpdateId(raw.update_id)) { malformedEnvelope = true; continue; }
          const update = raw as TelegramUpdate;
          accepted.push({ update, scope: this.updateScope(update) });
        }
        accepted.sort((a, b) => a.update.update_id - b.update.update_id);
        let index = 0;
        try {
          for (; index < accepted.length; index++) {
            const { update, scope } = accepted[index]!;
            await this.serializeInbound(async () => {
              if (this.seen(update.update_id)) { acknowledgeTelegramUpdate(this.hive.db, scope.botKey, update.update_id); return; }
              const allowed = () => scope.projectId === null || this.scopeMatches(scope);
              try {
                if (!allowed()) throw new TelegramPermanentUpdateError("destination_changed");
                await this.processUpdate(update, allowed);
                this.ensureActive();
                if (!allowed()) throw new TelegramPermanentUpdateError("destination_changed");
                finishTelegramUpdate(this.hive.db, scope.botKey, update.update_id);
              } catch (error) {
                if (this.stopped) throw error;
                this.recordUpdateError(scope, update, error);
              }
            });
          }
        } finally {
          if (this.stopped && index < accepted.length) {
            try { handoffTelegramUpdates(this.hive.db, accepted.slice(index)); }
            catch (error) {
              // A failed handoff must prevent configure() from publishing a new audience.
              this.handoffError = new Error(`Telegram drain could not persist accepted updates: ${this.safeError(error)}`);
            }
          }
        }
        if (malformedEnvelope) throw new Error("Telegram returned an update without a valid update_id");
        // A broken proxy returning immediate empty successes must not create an unbounded polling loop.
        if (data.result.length === 0 || Number(this.state("offset") ?? "0") <= offset) await sleep(250, this.abort.signal);
      } catch (error) {
        if (this.stopped) return;
        failures++;
        const description = this.safeError(error);
        this.setState("poll:last_error", description);
        this.hive.publishTelegramHealth();
        console.error("telegram poll", description);
        if (error instanceof TelegramRateLimitError) await this.waitForRateLimit(error);
        else await sleep(telegramPollBackoffMs(failures, Math.random, isTelegramTerminalPollError(description)), this.abort.signal);
      }
    }
  }

  private onInboxWake = () => this.inboundRetries.wake();

  private scheduleRetry(at: number) {
    if (this.stopped || (this.retryTimer && this.retryWakeAt !== undefined && this.retryWakeAt <= at)) return;
    clearTimeout(this.retryTimer);
    this.retryWakeAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryWakeAt = undefined;
      this.inboundRetries.wake();
    }, Math.min(2_147_483_647, Math.max(1, at - Date.now())));
    this.retryTimer.unref();
  }

  private async replayFailedUpdates() {
    while (!this.stopped) {
      const row = dueTelegramUpdate(this.hive.db, telegramConfigKey(this.cfg));
      if (!row) {
        const at = nextTelegramUpdateRetry(this.hive.db, telegramConfigKey(this.cfg));
        if (at !== undefined) this.scheduleRetry(at);
        return;
      }
      await this.serializeInbound(async () => {
        const allowed = () => Boolean(this.hive.db.prepare("SELECT 1 FROM telegram_update_failures WHERE id = ? AND state = 'retry'").get(row.id));
        if (!allowed()) return;
        if (row.invalidated || !this.scopeMatches(row)) {
          this.hive.db.prepare("UPDATE telegram_update_failures SET state = 'quarantined', invalidated = 1, last_error = 'destination_changed', updated_at = ? WHERE id = ?")
            .run(Date.now(), row.id);
          this.hive.publishTelegramHealth();
          return;
        }
        let update: TelegramUpdate;
        try {
          update = JSON.parse(row.payload ?? "null") as TelegramUpdate;
          if (!update || update.update_id !== row.updateId) throw new Error("Invalid stored update");
        } catch {
          this.hive.db.prepare("UPDATE telegram_update_failures SET state = 'quarantined', last_error = 'invalid_stored_payload', updated_at = ? WHERE id = ?")
            .run(Date.now(), row.id);
          this.hive.publishTelegramHealth();
          return;
        }
        try {
          await this.processUpdate(update, allowed);
          this.ensureActive();
          if (allowed()) finishTelegramUpdate(this.hive.db, row.botKey, row.updateId);
        } catch (error) {
          if (this.stopped) throw error;
          if (allowed()) this.recordUpdateError(row, update, error);
        }
        this.hive.publishTelegramHealth();
      });
    }
  }

  private async onTelegramMessage(message: TelegramMessage, allowed: () => boolean = () => true, updateId?: number) {
    if (!projectSlugForChat(this.cfg, Number(message.chat?.id))) return;
    const chatId = Number(message.chat?.id);
    const already = this.hive.db.prepare(
      "SELECT seq FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(message.message_id, chatId, telegramConfigKey(this.cfg));
    if (already) return;
    const fromId = Number(message.from?.id);
    if (!Number.isFinite(fromId) || !this.cfg.allowUserIds.includes(fromId)) return;
    if (message.from?.is_bot) return;
    const text = String(message.text ?? message.caption ?? "").trim();
    if (text.startsWith("/")) {
      await this.onCommand(text, message);
      return;
    }
    if (!text && !telegramMessageHasFiles(message)) return;
    const channelId = await this.resolveInboundChannel(message);
    this.ensureActive();
    if (!channelId) {
      const slug = projectSlugForChat(this.cfg, chatId);
      if (slug && !this.hive.findProjectBySlug(slug)) return;
      this.holdMessage(message, updateId);
      return;
    }
    if (!allowed()) return;
    const attachmentIds = await this.filesFromMessage(message);
    try { this.ensureActive(); } catch (error) { this.discardUnboundAttachments(attachmentIds); throw error; }
    if (!allowed()) { this.discardUnboundAttachments(attachmentIds); return; }
    if (!text && attachmentIds.length === 0) return;
    let threadId: string | null = null;
    const replyId = message.reply_to_message?.message_id;
    if (replyId) {
      const mapped = this.hive.db.prepare(
        "SELECT seq, channel_id AS channelId, thread_id AS threadId FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ? AND bot_key = ?",
      ).get(replyId, chatId, telegramConfigKey(this.cfg)) as { seq: number; channelId: string; threadId: string | null } | undefined;
      let original: Message | null = null;
      if (mapped) {
        try { original = this.hive.getMessageBySeq(mapped.seq); } catch { /* stale mapping */ }
      }
      threadId = telegramReplyThreadId(mapped, original, channelId);
      if (threadId && !this.hive.db.prepare("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?").get(threadId, channelId)) threadId = null;
    }
    this.ensureActive();
    if (this.hive.db.prepare("SELECT 1 FROM telegram_out WHERE bot_key = ? AND telegram_chat_id = ? AND telegram_message_id = ?")
      .get(telegramConfigKey(this.cfg), chatId, message.message_id)) {
      this.discardUnboundAttachments(attachmentIds);
      return;
    }
    const replyUnavailable = Boolean(replyId && !threadId);
    const body = inboundPostBody(message.from?.first_name,
      replyUnavailable ? `[Original reply unavailable] ${text}`.slice(0, 3900) : text, attachmentIds.length > 0);
    try {
      this.hive.postMessage(this.hive.getAgent(HUMAN_ID), {
        channel: channelId, body, threadId, source: "telegram", attachmentIds,
      }, posted => {
        this.hive.db.prepare(`INSERT OR REPLACE INTO telegram_out
          (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id, bot_key) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(chatId, message.message_id, posted.seq, posted.channelId, posted.threadId, telegramConfigKey(this.cfg));
      });
    } catch (error) { this.discardUnboundAttachments(attachmentIds); throw error; }
  }

  private async onTelegramReaction(update: TelegramReaction) {
    if (!projectSlugForChat(this.cfg, Number(update.chat?.id))) return;
    const fromId = Number(update.user?.id);
    if (!Number.isFinite(fromId) || !this.cfg.allowUserIds.includes(fromId)) return;
    if (update.user?.is_bot) return;
    const mapped = this.hive.db.prepare(
      "SELECT seq FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(update.message_id, Number(update.chat?.id), telegramConfigKey(this.cfg)) as { seq: number } | undefined;
    if (!mapped) return;
    try {
      const original = this.hive.getMessageBySeq(mapped.seq);
      const channel = this.hive.getChannel(original.channelId);
      if (channel.project !== projectSlugForChat(this.cfg, Number(update.chat?.id))) return;
    } catch { return; }
    const next = new Set(hiveEmojisOf(update.new_reaction));
    const prev = new Set(hiveEmojisOf(update.old_reaction));
    const key = reactionIgnoreKey(Number(update.chat?.id), update.message_id, telegramEmojisOf(update.new_reaction));
    const ignoredAt = this.ignoreReaction.get(key);
    if (ignoredAt != null && Date.now() - ignoredAt < 120_000) return;
    this.pruneIgnoreReactions();
    const human = this.hive.getAgent(HUMAN_ID);
    for (const emoji of REACTION_EMOJIS) {
      const nowOn = next.has(emoji);
      const wasOn = prev.has(emoji);
      if (nowOn === wasOn) continue;
      const current = this.hive.getMessageBySeq(mapped.seq);
      const mine = this.hive.hasReaction(HUMAN_ID, current.id, emoji);
      if (nowOn && !mine) this.hive.toggleReaction(human, mapped.seq, emoji);
      if (!nowOn && mine) this.hive.toggleReaction(human, mapped.seq, emoji);
    }
  }

  private async onCommand(text: string, message: TelegramMessage) {
    const cmd = text.split(/\s+/)[0]?.replace(/@\w+$/, "") ?? "";
    const chatId = Number(message.chat?.id);
    if (cmd === "/mute") {
      if (Number.isFinite(chatId)) this.setState(`mute:${chatId}`, "1");
      await this.reply(message, "pings muted");
      return;
    }
    if (cmd === "/unmute") {
      if (Number.isFinite(chatId)) this.setState(`mute:${chatId}`, "0");
      await this.reply(message, "pings on");
      return;
    }
    if (cmd === "/who") {
      const slug = projectSlugForChat(this.cfg, Number(message.chat?.id));
      const project = slug ? this.hive.findProjectBySlug(slug) : null;
      const lines = this.hive.listAgents().filter((a) => {
        if (a.role === "human") return true;
        return project ? a.projectId === project.id : false;
      }).map((a) => `${a.online ? "•" : "○"} ${a.name} ${a.role}`);
      await this.reply(message, lines.join("\n") || "empty");
    }
  }

  private async reply(message: TelegramMessage, text: string) {
    const chatId = Number(message.chat?.id);
    if (!Number.isFinite(chatId)) return;
    requireTelegramOk(await this.api("sendMessage", {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
      text,
      disable_notification: true,
    }), "command reply");
  }

  private async resolveInboundChannel(message: TelegramMessage): Promise<string | null> {
    const chatId = Number(message.chat?.id);
    const mapped = this.channelForTopic(chatId, message.message_thread_id);
    if (mapped) return mapped;
    const slug = projectSlugForChat(this.cfg, chatId);
    if (!slug) return null;
    const project = this.hive.findProjectBySlug(slug);
    if (!project) return null;
    const name =
      message.forum_topic_created?.name ?? message.reply_to_message?.forum_topic_created?.name ?? null;
    if (!name || message.message_thread_id == null) return null;
    const human = this.hive.getAgent(HUMAN_ID);
    const ch = this.hive.listChannels(human).find(
      (c) =>
        c.projectId === project.id &&
        (channelLabel(c) === name || c.name === name || `#${c.name}` === name),
    );
    if (!ch) return null;
    if (!this.hive.db.prepare("SELECT id FROM channels WHERE id = ?").get(ch.id)) return null;
    this.hive.db.prepare(
      "INSERT OR REPLACE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id, bot_key) VALUES (?, ?, ?, ?)",
    ).run(ch.id, message.message_thread_id, chatId, telegramConfigKey(this.cfg));
    await this.flushHolds(chatId, message.message_thread_id);
    return ch.id;
  }

  private holdMessage(message: TelegramMessage, updateId?: number) {
    const thread = message.message_thread_id;
    const chatId = Number(message.chat?.id);
    if (thread == null || !Number.isFinite(chatId)) return;
    this.hive.db.prepare(
      "INSERT OR REPLACE INTO telegram_hold (telegram_chat_id, telegram_message_id, telegram_thread_id, payload, bot_key, project_id, update_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, message.message_id, thread, JSON.stringify(message), telegramConfigKey(this.cfg), this.hive.findProjectBySlug(projectSlugForChat(this.cfg, chatId) ?? "")?.id ?? null, updateId ?? null);
  }

  private async flushHolds(chatId: number, telegramThreadId: number) {
    const rows = this.hive.db.prepare(
      "SELECT payload, update_id AS updateId, telegram_message_id AS messageId FROM telegram_hold WHERE telegram_thread_id = ? AND telegram_chat_id = ? AND bot_key = ? AND project_id = ?",
    ).all(telegramThreadId, chatId, telegramConfigKey(this.cfg), this.hive.findProjectBySlug(projectSlugForChat(this.cfg, chatId) ?? "")?.id ?? null) as { payload: string; updateId: number | null; messageId: number }[];
    for (const row of rows) {
      try {
        const message = JSON.parse(row.payload) as TelegramMessage;
        if (message.chat?.id != null && Number(message.chat.id) !== chatId) continue;
        await this.onTelegramMessage(message, () => true, row.updateId ?? undefined);
      } catch (error) {
        this.ensureActive();
        if (row.updateId !== null) {
          let message: unknown;
          try { message = JSON.parse(row.payload); } catch { message = null; }
          const update = { update_id: row.updateId, message };
          this.recordUpdateError(this.updateScope(update), update, error);
        } else {
          // Older held messages lack update provenance: retain them rather than silently acknowledging loss.
          this.setState("poll:last_error", "Legacy held Telegram message failed; manual reconciliation required");
          this.hive.publishTelegramHealth();
          continue;
        }
      }
      this.ensureActive();
      this.hive.db.prepare("DELETE FROM telegram_hold WHERE bot_key = ? AND telegram_chat_id = ? AND telegram_message_id = ?")
        .run(telegramConfigKey(this.cfg), chatId, row.messageId);
    }

  }

  private channelForTopic(chatId: number, threadId: number | undefined): string | null {
    const slug = projectSlugForChat(this.cfg, chatId);
    if (!slug) return null;
    const project = this.hive.findProjectBySlug(slug);
    if (!project) return null;
    if (threadId == null || threadId === 1) {
      const general = this.hive.listChannels(this.hive.getAgent(HUMAN_ID)).find(
        (c) => c.projectId === project.id && c.name === "general" && c.type === "public",
      );
      return general?.id ?? null;
    }
    const row = this.hive.db.prepare(
      "SELECT channel_id AS id FROM telegram_topics WHERE telegram_thread_id = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).get(threadId, chatId, telegramConfigKey(this.cfg)) as { id: string } | undefined;
    if (!row) return null;
    try {
      const ch = this.hive.getChannel(row.id);
      return ch.projectId === project.id ? ch.id : null;
    } catch {
      return null;
    }
  }

  private seen(updateId: number): boolean {
    return Boolean(this.hive.db.prepare("SELECT update_id FROM telegram_in WHERE update_id = ? AND bot_key = ?").get(updateId, telegramConfigKey(this.cfg)));
  }

  private pruneIgnoreReactions() {
    const cutoff = Date.now() - 120_000;
    for (const [key, at] of this.ignoreReaction) {
      if (at < cutoff) this.ignoreReaction.delete(key);
    }
  }

  private state(key: string): string | undefined {
    const row = this.hive.db.prepare("SELECT value FROM telegram_bot_state WHERE key = ? AND bot_key = ?").get(key, telegramConfigKey(this.cfg)) as { value: string } | undefined;
    return row?.value;
  }

  private setState(key: string, value: string) {
    this.hive.db.prepare(
      "INSERT INTO telegram_bot_state (key, value, bot_key) VALUES (?, ?, ?) ON CONFLICT(bot_key, key) DO UPDATE SET value = excluded.value",
    ).run(key, value, telegramConfigKey(this.cfg));
  }

  private queuePending(seq: number, kind: "message" | "reaction") {
    if (this.stopped) return;
    const destination = telegramDestinationForSeq(this.hive, seq, this.cfg);
    if (!destination) return;
    enqueueTelegramPending(this.hive.db, seq, kind, undefined, destination);
    this.hive.publishTelegramHealth();
    this.kickPump();
  }

  private chatForSeq(seq: number): number | undefined {
    try {
      return this.chatForChannel(this.hive.getChannel(this.hive.getMessageBySeq(seq).channelId));
    } catch {
      return undefined;
    }
  }

  private pendingSelection() {
    const jobs = this.hive.db.prepare(
      "SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId, attempts, first_attempt_at AS firstAttemptAt, revision FROM telegram_pending ORDER BY seq ASC, kind ASC",
    ).all() as TelegramJob[];
    const expiredOrStale = jobs.find(job =>
      !sameTelegramDestination(job, telegramDestinationForSeq(this.hive, job.seq, this.cfg)) ||
      Boolean(job.firstAttemptAt && Date.now() >= job.firstAttemptAt + 86_400_000));
    if (expiredOrStale) return { job: expiredOrStale };
    const result = selectTelegramPendingJob(jobs, seq => this.chatForSeq(seq), chat =>
      Math.max(this.skipChatUntil.get(chat) ?? 0, Number(this.state(`outbound:cooldown:${chat}`) ?? 0)), Date.now(), this.lastServedChat);
    if (!result.job) {
      for (const job of jobs) if (job.firstAttemptAt) result.wakeAt = Math.min(result.wakeAt ?? Infinity, job.firstAttemptAt + 86_400_000);
    }
    return result;
  }

  private scheduleCooldown(at: number) {
    if (this.stopped) return;
    if (this.cooldownTimer && this.cooldownWakeAt !== undefined && this.cooldownWakeAt <= at) return;
    clearTimeout(this.cooldownTimer);
    this.cooldownWakeAt = at;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      this.cooldownWakeAt = undefined;
      if (Date.now() < at) this.scheduleCooldown(at);
      else this.kickPump();
    }, Math.min(2_147_483_647, Math.max(1, at - Date.now())));
    this.cooldownTimer.unref();
  }

  private coolDown(chat: number, until: number) {
    const deadline = Math.max(until, this.skipChatUntil.get(chat) ?? 0, Number(this.state(`outbound:cooldown:${chat}`) ?? 0));
    this.skipChatUntil.set(chat, deadline);
    this.setState(`outbound:cooldown:${chat}`, String(deadline));
  }

  private async waitForRateLimit(error: TelegramRateLimitError) {
    while (Date.now() < error.retryAt) {
      await sleep(Math.min(2_147_483_647, error.retryAt - Date.now()), this.abort.signal);
    }
    this.ensureActive();
  }

  private clearPending(job: TelegramJob) {
    this.hive.db.prepare("DELETE FROM telegram_pending WHERE seq = ? AND kind = ? AND revision = ?").run(job.seq, job.kind, job.revision ?? 0);
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split(this.cfg.botToken).join("[redacted]").slice(0, 1000);
  }

  private async pump() {
    while (!this.stopped) {
      const selection = this.pendingSelection();
      const job = selection.job;
      if (!job) {
        if (selection.wakeAt !== undefined) this.scheduleCooldown(selection.wakeAt);
        break;
      }
      this.lastServedChat = this.chatForSeq(job.seq);
      try {
        if (job.firstAttemptAt && Date.now() >= job.firstAttemptAt + 86_400_000) {
          failTelegramJob(this.hive.db, job, "delivery_retry_age_exhausted", job.attempts ?? 0);
          this.hive.publishTelegramHealth();
          continue;
        }
        const destination = telegramDestinationForSeq(this.hive, job.seq, this.cfg);
        if (!sameTelegramDestination(job, destination)) {
          failTelegramJob(this.hive.db, job, "destination_changed_or_unknown", 0);
          this.hive.publishTelegramHealth();
          continue;
        }
        const legacyParts = this.hive.db.prepare("SELECT 1 FROM telegram_delivery_parts WHERE seq = ? AND bot_key = '' LIMIT 1").get(job.seq);
        if (legacyParts) {
          failTelegramJob(this.hive.db, job, "legacy_part_destination_unknown", 0);
          this.hive.publishTelegramHealth();
          continue;
        }
        if (job.kind === "reaction") await this.sendPendingReaction(job.seq);
        else await this.sendPendingMessage(job.seq);
        this.ensureActive();
        this.clearPending(job);
      } catch (err) {
        if (this.stopped || this.abort.signal.aborted) break;
        console.error("telegram out", this.safeError(err));
        const chat = this.chatForSeq(job.seq);
        const current = this.hive.db.prepare("SELECT revision FROM telegram_pending WHERE seq = ? AND kind = ?").get(job.seq, job.kind) as { revision: number } | undefined;
        if (!current) continue;
        if (err instanceof TelegramRateLimitError && chat !== undefined) this.coolDown(chat, err.retryAt);
        // A newer desired reaction supersedes the failed old request; never delete the new job.
        if (current.revision !== (job.revision ?? 0)) continue;
        const attempts = (job.attempts ?? 0) + 1;
        const firstAttemptAt = job.firstAttemptAt || Date.now();
        this.hive.db.prepare("UPDATE telegram_pending SET attempts = ?, first_attempt_at = ? WHERE seq = ? AND kind = ?")
          .run(attempts, firstAttemptAt, job.seq, job.kind);
        const limit = err instanceof TelegramRateLimitError ? 20 : TELEGRAM_PENDING_GIVE_UP;
        if (isTelegramPermanentOutError(err) || attempts >= limit) {
          failTelegramJob(this.hive.db, job, this.safeError(err), attempts);
          this.hive.publishTelegramHealth();
          continue;
        }
        if (isTelegramTopicRightsError(err)) this.hintTopicRights();
        const until = err instanceof TelegramRateLimitError ? err.retryAt
          : Date.now() + (isTelegramTopicRightsError(err) ? 15_000 : Math.min(30_000, 2_000 * 2 ** (attempts - 1)));
        if (chat !== undefined) this.coolDown(chat, until);
        else await sleep(Math.min(30_000, Math.max(1, until - Date.now())), this.abort.signal);
        continue;
      }
      await sleep(1000, this.abort.signal);
    }
  }

  private async sendPendingMessage(seq: number) {
    let msg: Message;
    let ch: Channel;
    try {
      msg = this.hive.getMessageBySeq(seq);
      ch = this.hive.getChannel(msg.channelId);
    } catch {
      return;
    }
    if (msg.kind !== "chat" || this.hive.fromTelegram(msg.id)) return;
    const chatId = this.chatForChannel(ch);
    if (chatId == null) return;
    const thread = await this.ensureTopic(ch);
    if (thread == null) throw new Error("telegram topic not ready");
    const muted = this.state(`mute:${chatId}`) === "1" || this.state("mute") === "1";
    const silent = !shouldNotify(msg, ch, muted);
    const atts = msg.attachments ?? [];
    const text = formatOutbound(msg);

    if (atts.length === 0) {
      const partKey = "text";
      if (telegramPartDelivered(this.hive.db, msg.seq, partKey, chatId, telegramConfigKey(this.cfg))) return;
      const sent = requireTelegramOk(
        await this.api("sendMessage", {
          chat_id: chatId,
          message_thread_id: thread,
          text,
          disable_notification: silent,
        }),
        "sendMessage",
      );
      this.recordOut(sent, msg, chatId, partKey);
      return;
    }

    if (text.length > 1000 && !telegramPartDelivered(this.hive.db, msg.seq, "text", chatId, telegramConfigKey(this.cfg))) {
      const sent = requireTelegramOk(
        await this.api("sendMessage", {
          chat_id: chatId,
          message_thread_id: thread,
          text,
          disable_notification: silent,
        }),
        "sendMessage",
      );
      this.recordOut(sent, msg, chatId, "text");
    }

    const human = this.hive.getAgent(HUMAN_ID);
    for (let i = 0; i < atts.length; i += 1) {
      const att = atts[i]!;
      const partKey = `attachment:${att.id}`;
      if (telegramPartDelivered(this.hive.db, msg.seq, partKey, chatId, telegramConfigKey(this.cfg))) continue;
      const opened = this.hive.getAttachment(human, att.id);
      const disk = filePathForHash(opened.sha256, this.hive.home);
      const caption = text.length <= 1000 && i === 0 ? text : `${msg.authorName} · ${att.name}`;
      const sent = requireTelegramOk(
        await this.sendFile(chatId, thread, att.mime, att.name, disk, caption, silent),
        "sendFile",
      );
      this.recordOut(sent, msg, chatId, partKey);
    }
  }

  private async sendPendingReaction(seq: number) {
    let msg: Message;
    let ch: Channel;
    try {
      msg = this.hive.getMessageBySeq(seq);
      ch = this.hive.getChannel(msg.channelId);
    } catch {
      return;
    }
    const chatId = this.chatForChannel(ch);
    if (chatId == null) return;
    const rows = this.hive.db.prepare(
      "SELECT telegram_message_id AS id FROM telegram_out WHERE seq = ? AND telegram_chat_id = ? AND bot_key = ?",
    ).all(seq, chatId, telegramConfigKey(this.cfg)) as { id: number }[];
    if (rows.length === 0) return;
    const reaction = telegramOutboundReactionPayload((msg.reactions ?? []).map((r) => r.emoji));
    const emojis = reaction.map((r) => r.emoji);
    const now = Date.now();
    for (const row of rows) this.ignoreReaction.set(reactionIgnoreKey(chatId, row.id, emojis), now);
    for (const row of rows) {
      requireTelegramOk(
        await this.api("setMessageReaction", {
          chat_id: chatId,
          message_id: row.id,
          reaction,
        }),
        "setMessageReaction",
      );
    }
  }

  private recordOut(sent: ApiResult, msg: Message, chatId: number, partKey: string) {
    this.ensureActive();
    const result = sent.result as { message_id?: number } | undefined;
    if (!sent.ok || !Number.isSafeInteger(result?.message_id)) throw new Error("Telegram response has no message ID; delivery outcome is unknown");
    const messageId = result!.message_id!;
    try {
      this.hive.db.exec("BEGIN IMMEDIATE");
      this.hive.db.prepare(
        `INSERT OR REPLACE INTO telegram_out
          (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id, bot_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(chatId, messageId, msg.seq, msg.channelId, msg.threadId, telegramConfigKey(this.cfg));
      this.hive.db.prepare(
        `INSERT OR REPLACE INTO telegram_delivery_parts
          (seq, part_key, telegram_chat_id, telegram_message_id, completed_at, bot_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(msg.seq, partKey, chatId, messageId, Date.now(), telegramConfigKey(this.cfg));
      this.hive.db.exec("COMMIT");
    } catch (err) {
      try {
        this.hive.db.exec("ROLLBACK");
      } catch {
        /* no open transaction */
      }
      throw err;
    }
  }

  private async sendFile(
    chatId: number,
    thread: number,
    mime: string,
    name: string,
    filePath: string,
    caption: string,
    silent: boolean,
  ): Promise<ApiResult> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("message_thread_id", String(thread));
    form.set("caption", caption.slice(0, 1024));
    form.set("disable_notification", silent ? "true" : "false");
    const blob = await openAsBlob(filePath, { type: mime });
    const field = mime.startsWith("image/") ? "photo" : "document";
    form.set(field, blob, safeFileName(name));
    const method = mime.startsWith("image/") ? "sendPhoto" : "sendDocument";
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: this.abort.signal,
    });
    const data = (await res.json().catch(() => ({}))) as ApiResult;
    this.ensureActive();
    const retryAfterMs = telegramRetryAfterMs(res.status, data, 2000, res.headers.get("retry-after"));
    if (retryAfterMs !== null) throw new TelegramRateLimitError(retryAfterMs);
    return res.ok ? data : { ...data, ok: false, description: data.description ?? `Telegram HTTP ${res.status}`, error_code: res.status };
  }

  private discardUnboundAttachments(ids: string[]) {
    for (const id of ids) this.hive.db.prepare("DELETE FROM attachments WHERE id = ? AND message_id IS NULL").run(id);
  }

  private async filesFromMessage(message: TelegramMessage): Promise<string[]> {
    const out: string[] = [];
    try {
      const photos = message.photo ?? [];
      if (photos.length) out.push(await this.ingestTelegramFile(photos[photos.length - 1]!.file_id, "photo.jpg", "image/jpeg"));
      if (message.document) {
        const name = message.document.file_name ?? "file";
        const mime = resolveUploadMime(message.document.mime_type, name);
        if (mime === "application/octet-stream") throw new TelegramPermanentUpdateError("Unsupported Telegram attachment type");
        out.push(await this.ingestTelegramFile(message.document.file_id, name, mime));
      }
      return out;
    } catch (error) { this.discardUnboundAttachments(out); throw error; }
  }

  private async ingestTelegramFile(fileId: string, name: string, mime: string): Promise<string> {
    const meta = requireTelegramOk(await this.api("getFile", { file_id: fileId }), "getFile");
    const file = meta.result as { file_path?: string; file_size?: number } | undefined;
    if (!file?.file_path) throw new Error("Telegram file metadata is unavailable");
    if (telegramFileTooLarge(file.file_size)) throw new TelegramPermanentUpdateError("Telegram attachment exceeds the local size limit");
    const res = await fetch(`https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`, {
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      const retry = telegramRetryAfterMs(res.status, {}, 2000, res.headers.get("retry-after"));
      if (retry !== null) throw new TelegramRateLimitError(retry);
      throw new Error("Telegram attachment download failed");
    }
    this.ensureActive();
    const created = await this.hive.createFile(this.hive.getAgent(HUMAN_ID), { name, mime, body: res.body });
    if (this.stopped) { this.discardUnboundAttachments([created.id]); this.ensureActive(); }
    return created.id;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<ApiResult> {
    this.ensureActive();
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    const data = (await res.json().catch(() => ({}))) as ApiResult;
    this.ensureActive();
    const retryAfterMs = telegramRetryAfterMs(res.status, data, 2000, res.headers.get("retry-after"));
    if (retryAfterMs !== null) throw new TelegramRateLimitError(retryAfterMs);
    return res.ok ? data : { ...data, ok: false, description: data.description ?? `Telegram HTTP ${res.status}`, error_code: res.status };
  }
}

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  chat?: { id: number };
  from?: { id: number; first_name?: string; is_bot?: boolean };
  reply_to_message?: { message_id: number; forum_topic_created?: { name: string } };
  forum_topic_created?: { name: string };
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
};

type TelegramReaction = {
  chat?: { id: number };
  message_id: number;
  user?: { id: number; is_bot?: boolean };
  new_reaction?: Array<{ type?: string; emoji?: string }>;
  old_reaction?: Array<{ type?: string; emoji?: string }>;
};

function telegramEmojisOf(list: Array<{ type?: string; emoji?: string }> | undefined): string[] {
  return (list ?? []).map((r) => r.emoji).filter((e): e is string => Boolean(e));
}

function hiveEmojisOf(list: Array<{ type?: string; emoji?: string }> | undefined): string[] {
  return telegramEmojisOf(list)
    .map((emoji) => hiveEmojiFromTelegram(emoji))
    .filter((e): e is string => Boolean(e) && REACTION_EMOJIS.includes(e as (typeof REACTION_EMOJIS)[number]));
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
