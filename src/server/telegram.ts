import { enqueueTelegramPending, failTelegramJob, telegramBotKey, telegramPartDelivered, sameTelegramDestination, type TelegramDestination, type TelegramJob } from "./telegram-outbox.ts";
export { enqueueTelegramPending, recordTelegramFailure, telegramPartDelivered, TELEGRAM_PENDING_CAP } from "./telegram-outbox.ts";
import { CoalescingPump } from "./coalescing-pump.ts";
import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_SLUG, FILE_MAX_BYTES, HiveError, HUMAN_ID, REACTION_EMOJIS, type Channel, type Message } from "../shared/types.ts";
import { parseProjectSlug } from "../shared/project.ts";
import { resolveUploadMime } from "../shared/mime.ts";
import { Hive, channelLabel } from "./hive.ts";
import { hiveHome } from "./paths.ts";
import { filePathForHash, safeFileName } from "./files.ts";

export type TelegramConfig = {
  botToken: string;
  botId?: number;
  allowUserIds: number[];
  groups: Record<string, number>;
};

export type TelegramFile = {
  botToken: string;
  botId?: number;
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
      groupChatId?: number;
      allowUserIds?: Array<number | string>;
      projects?: Record<string, { groupChatId?: number } | number>;
    };
    const botToken = String(raw.botToken ?? "").trim();
    const allowUserIds = (raw.allowUserIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    const projects: Record<string, number> = {};
    if (raw.projects && typeof raw.projects === "object") {
      for (const [slug, value] of Object.entries(raw.projects)) {
        const id = typeof value === "number" || typeof value === "string" ? Number(value) : Number(value?.groupChatId);
        if (slug && Number.isFinite(id)) projects[slug] = id;
      }
    }
    const legacy = Number(raw.groupChatId);
    if (Number.isFinite(legacy)) projects[DEFAULT_PROJECT_SLUG] ??= legacy;
    if (!botToken && allowUserIds.length === 0 && Object.keys(projects).length === 0) return null;
    return { botToken, allowUserIds, projects };
  } catch {
    return null;
  }
}

export function loadTelegramConfig(home = hiveHome()): TelegramConfig | null {
  const file = readTelegramFile(home);
  if (!file?.botToken || file.allowUserIds.length === 0 || Object.keys(file.projects).length === 0) return null;
  return { botToken: file.botToken, allowUserIds: file.allowUserIds, groups: file.projects };
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

export function writeTelegramFile(
  input: {
    botToken?: string | null;
    allowUserIds?: Array<number | string>;
    projects?: Record<string, { groupChatId?: number | string | null } | number | string | null>;
  },
  home = hiveHome(),
): TelegramFile {
  const prev = readTelegramFile(home);
  const botToken = String(input.botToken ?? "").trim() || prev?.botToken || "";
  if (!botToken) throw new HiveError(400, "Bot token required");
  const allowUserIds = (input.allowUserIds ?? prev?.allowUserIds ?? [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (allowUserIds.length === 0) throw new HiveError(400, "At least one Telegram user id");
  const projects: Record<string, number> = {};
  for (const [slug, value] of Object.entries(input.projects ?? {})) {
    if (!slug) continue;
    const id = value && typeof value === "object" ? Number(value.groupChatId) : Number(value);
    if (!Number.isFinite(id)) continue;
    projects[slug] = id;
  }
  const disk = {
    botToken,
    allowUserIds,
    projects: Object.fromEntries(Object.entries(projects).map(([slug, groupChatId]) => [slug, { groupChatId }])),
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(telegramConfigPath(home), `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  return { botToken, allowUserIds, projects };
}

export function removeTelegramProjectSlug(slug: string, home = hiveHome()): TelegramFile | null {
  const prev = readTelegramFile(home);
  if (!prev) return null;
  let parsed: string;
  try {
    parsed = parseProjectSlug(slug);
  } catch {
    return prev;
  }
  if (!Object.hasOwn(prev.projects, parsed)) return prev;
  const projects = { ...prev.projects };
  delete projects[parsed];
  const disk = {
    botToken: prev.botToken,
    allowUserIds: prev.allowUserIds,
    projects: Object.fromEntries(Object.entries(projects).map(([key, groupChatId]) => [key, { groupChatId }])),
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(telegramConfigPath(home), `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  return { botToken: prev.botToken, allowUserIds: prev.allowUserIds, projects };
}

export function chatIdForProject(cfg: TelegramConfig, slug: string | null | undefined): number | undefined {
  if (!slug) return undefined;
  return cfg.groups[slug];
}

export function projectSlugForChat(cfg: TelegramConfig, chatId: number): string | undefined {
  return Object.entries(cfg.groups).find(([, id]) => id === chatId)?.[0];
}

export function shouldNotify(msg: Message, ch: Channel, muted: boolean): boolean {
  if (muted) return false;
  if (msg.kind !== "chat") return false;
  if (msg.mentions.includes(HUMAN_ID)) return true;
  if (ch.type === "brains") return true;
  if (ch.type === "dm" && ch.memberIds.includes(HUMAN_ID) && msg.authorRole === "brain") return true;
  return false;
}

export function formatOutbound(msg: Message): string {
  const body = msg.body.slice(0, 4000);
  return `${msg.authorName}\n${body}`.slice(0, 4096);
}

export function reactionIgnoreKey(telegramMessageId: number, emojis: string[]): string {
  return `${telegramMessageId}:${[...emojis].sort().join(",")}`;
}

export function inboundBody(firstName: string | undefined, text: string): string {
  const name = (firstName ?? "Human").replace(/[\[\]]/g, "").slice(0, 40);
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
  if (typeof ch === "string") return ch === "general" || /:general$/.test(ch) ? 1 : null;
  return ch.name === "general" && ch.type === "public" ? 1 : null;
}

export function telegramDestinationForSeq(hive: Hive, seq: number, cfg = loadTelegramConfig(hive.home)): TelegramDestination | undefined {
  if (!cfg) return undefined;
  try {
    const msg = hive.getMessageBySeq(seq);
    const channel = hive.getChannel(msg.channelId);
    const chatId = cfg.groups[channel.project];
    if (!Number.isSafeInteger(chatId) || chatId === 0) return undefined;
    return { botKey: telegramBotKey(cfg.botToken, cfg.botId), chatId: chatId! };
  } catch { return undefined; }
}

export type TelegramHandle = {
  stop: () => Promise<void>;
  running: () => boolean;
  reload: () => Promise<boolean>;
};

export function startTelegram(hive: Hive, enabled = true): TelegramHandle {
  let bridge: TelegramBridge | null = null;
  let lifecycle: Promise<void> = Promise.resolve();

  const boot = () => {
    const cfg = loadTelegramConfig(hive.home);
    if (!cfg) return false;
    bridge = new TelegramBridge(hive, cfg);
    bridge.start();
    return true;
  };
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(op, op);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };

  if (enabled) boot();
  return {
    stop: () =>
      serial(async () => {
        const current = bridge;
        bridge = null;
        await current?.stop();
      }),
    running: () => Boolean(bridge),
    reload: () =>
      serial(async () => {
        const current = bridge;
        bridge = null;
        await current?.stop();
        if (!enabled) return false;
        return boot();
      }),
  };
}

export class TelegramBridge {
  private stopped = false;
  private abort = new AbortController();
  private pumpFails: { key: string; n: number } | null = null;
  private topicRightsHinted = false;
  private topicLocks = new Map<string, Promise<number | null>>();
  private poll: Promise<void> | null = null;
  private readonly outbound: CoalescingPump;
  private ignoreReaction = new Map<string, number>();
  private skipChatUntil = new Map<number, number>();

  constructor(
    private hive: Hive,
    private cfg: TelegramConfig,
  ) {
    this.outbound = new CoalescingPump(() => this.pump(), error => {
      if (!this.stopped) console.error("telegram pump", error instanceof Error ? error.message : error);
    });
  }

  private chatForChannel(ch: Channel): number | undefined {
    return chatIdForProject(this.cfg, ch.project);
  }

  start() {
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
    this.abort.abort(new DOMException("Telegram bridge stopped", "AbortError"));
    this.hive.bus.off("message", this.onHiveMessage);
    this.hive.bus.off("reaction", this.onHiveReaction);
    this.hive.bus.off("telegram-outbox-wake", this.onOutboxWake);
    await Promise.allSettled([this.poll, this.outbound.stop(), ...this.topicLocks.values()]);
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
    const row = this.hive.db.prepare("SELECT telegram_thread_id AS id FROM telegram_topics WHERE channel_id = ?").get(
      ch.id,
    ) as { id: number } | undefined;
    if (row) return row.id;
    const generalThread = telegramGeneralThreadId(ch);
    if (generalThread != null) {
      this.hive.db.prepare(
        "INSERT OR IGNORE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id) VALUES (?, ?, ?)",
      ).run(ch.id, generalThread, chatId);
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
    const again = this.hive.db.prepare("SELECT telegram_thread_id AS id FROM telegram_topics WHERE channel_id = ?").get(
      ch.id,
    ) as { id: number } | undefined;
    if (again) return again.id;
    const chatId = this.chatForChannel(ch);
    if (chatId == null) return null;
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
      "INSERT OR IGNORE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id) VALUES (?, ?, ?)",
    ).run(ch.id, result.message_thread_id, chatId);
    await this.flushHolds(chatId, result.message_thread_id);
    return result.message_thread_id;
  }

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const offset = Number(this.state("offset") ?? "0");
        const data = await this.api("getUpdates", {
          offset: offset || undefined,
          timeout: 25,
          allowed_updates: ["message", "message_reaction"],
        });
        this.ensureActive();
        const updates = (data.result as Array<{
          update_id: number;
          message?: TelegramMessage;
          message_reaction?: TelegramReaction;
        }>) ?? [];
        for (const update of updates) {
          this.ensureActive();
          if (this.seen(update.update_id)) {
            this.setState("offset", String(update.update_id + 1));
            continue;
          }
          try {
            if (update.message) await this.onTelegramMessage(update.message);
            if (update.message_reaction) await this.onTelegramReaction(update.message_reaction);
            this.ensureActive();
            this.markSeen(update.update_id);
            this.setState("offset", String(update.update_id + 1));
          } catch (err) {
            console.error("telegram update", err instanceof Error ? err.message : err);
            break;
          }
        }
      } catch (err) {
        if (this.stopped) return;
        console.error("telegram poll", err instanceof Error ? err.message : err);
        await sleep(2000, this.abort.signal);
      }
    }
  }

  private async onTelegramMessage(message: TelegramMessage) {
    if (!projectSlugForChat(this.cfg, Number(message.chat?.id))) return;
    const chatId = Number(message.chat?.id);
    const already = this.hive.db.prepare(
      "SELECT seq FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ?",
    ).get(message.message_id, chatId);
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
      this.holdMessage(message);
      return;
    }
    const attachmentIds = await this.filesFromMessage(message);
    this.ensureActive();
    if (!text && attachmentIds.length === 0) return;
    let threadId: string | null = null;
    const replyId = message.reply_to_message?.message_id;
    if (replyId) {
      const mapped = this.hive.db.prepare(
        "SELECT thread_id AS id FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ?",
      ).get(replyId, chatId) as { id: string | null } | undefined;
      threadId = mapped?.id ?? null;
    }
    this.ensureActive();
    const posted = this.hive.postMessage(this.hive.getAgent(HUMAN_ID), {
      channel: channelId,
      body: inboundPostBody(message.from?.first_name, text, attachmentIds.length > 0),
      threadId,
      source: "telegram",
      attachmentIds,
    });
    this.hive.db.prepare(
      `INSERT OR REPLACE INTO telegram_out (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(chatId, message.message_id, posted.seq, posted.channelId, posted.threadId);
  }

  private async onTelegramReaction(update: TelegramReaction) {
    if (!projectSlugForChat(this.cfg, Number(update.chat?.id))) return;
    const fromId = Number(update.user?.id);
    if (!Number.isFinite(fromId) || !this.cfg.allowUserIds.includes(fromId)) return;
    if (update.user?.is_bot) return;
    const mapped = this.hive.db.prepare(
      "SELECT seq FROM telegram_out WHERE telegram_message_id = ? AND telegram_chat_id = ?",
    ).get(update.message_id, Number(update.chat?.id)) as { seq: number } | undefined;
    if (!mapped) return;
    const next = new Set(hiveEmojisOf(update.new_reaction));
    const prev = new Set(hiveEmojisOf(update.old_reaction));
    const key = reactionIgnoreKey(update.message_id, telegramEmojisOf(update.new_reaction));
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
    await this.api("sendMessage", {
      chat_id: chatId,
      message_thread_id: message.message_thread_id,
      text,
      disable_notification: true,
    });
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
      "INSERT OR IGNORE INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id) VALUES (?, ?, ?)",
    ).run(ch.id, message.message_thread_id, chatId);
    await this.flushHolds(chatId, message.message_thread_id);
    return ch.id;
  }

  private holdMessage(message: TelegramMessage) {
    const thread = message.message_thread_id;
    const chatId = Number(message.chat?.id);
    if (thread == null || !Number.isFinite(chatId)) return;
    this.hive.db.prepare(
      "INSERT OR REPLACE INTO telegram_hold (telegram_chat_id, telegram_message_id, telegram_thread_id, payload) VALUES (?, ?, ?, ?)",
    ).run(chatId, message.message_id, thread, JSON.stringify(message));
  }

  private async flushHolds(chatId: number, telegramThreadId: number) {
    const rows = this.hive.db.prepare(
      "SELECT payload FROM telegram_hold WHERE telegram_thread_id = ? AND (telegram_chat_id = ? OR telegram_chat_id IS NULL)",
    ).all(telegramThreadId, chatId) as { payload: string }[];
    for (const row of rows) {
      const message = JSON.parse(row.payload) as TelegramMessage;
      if (message.chat?.id != null && Number(message.chat.id) !== chatId) continue;
      await this.onTelegramMessage(message);
    }
    this.ensureActive();
    this.hive.db.prepare(
      "DELETE FROM telegram_hold WHERE telegram_thread_id = ? AND (telegram_chat_id = ? OR telegram_chat_id IS NULL)",
    ).run(telegramThreadId, chatId);
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
      "SELECT channel_id AS id FROM telegram_topics WHERE telegram_thread_id = ? AND (telegram_chat_id = ? OR telegram_chat_id IS NULL)",
    ).get(threadId, chatId) as { id: string } | undefined;
    if (!row) return null;
    try {
      const ch = this.hive.getChannel(row.id);
      return ch.projectId === project.id ? ch.id : null;
    } catch {
      return null;
    }
  }

  private seen(updateId: number): boolean {
    return Boolean(this.hive.db.prepare("SELECT update_id FROM telegram_in WHERE update_id = ?").get(updateId));
  }

  private markSeen(updateId: number) {
    this.hive.db.prepare("INSERT OR IGNORE INTO telegram_in (update_id) VALUES (?)").run(updateId);
  }

  private pruneIgnoreReactions() {
    const cutoff = Date.now() - 120_000;
    for (const [key, at] of this.ignoreReaction) {
      if (at < cutoff) this.ignoreReaction.delete(key);
    }
  }

  private state(key: string): string | undefined {
    const row = this.hive.db.prepare("SELECT value FROM telegram_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setState(key: string, value: string) {
    this.hive.db.prepare(
      "INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
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

  private nextPending(): TelegramJob | undefined {
    const jobs = this.hive.db.prepare(
      "SELECT seq, kind, bot_key AS botKey, telegram_chat_id AS chatId FROM telegram_pending ORDER BY seq ASC, kind ASC",
    ).all() as TelegramJob[];
    const now = Date.now();
    for (const job of jobs) {
      const chat = this.chatForSeq(job.seq);
      if (chat != null && (this.skipChatUntil.get(chat) ?? 0) > now) continue;
      return job;
    }
  }

  private clearPending(seq: number, kind: string) {
    this.hive.db.prepare("DELETE FROM telegram_pending WHERE seq = ? AND kind = ?").run(seq, kind);
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split(this.cfg.botToken).join("[redacted]").slice(0, 1000);
  }

  private async pump() {
    while (!this.stopped) {
      const job = this.nextPending();
      if (!job) break;
      try {
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
        this.clearPending(job.seq, job.kind);
        this.pumpFails = null;
      } catch (err) {
        if (this.stopped || this.abort.signal.aborted) break;
        console.error("telegram out", this.safeError(err));
        const chat = this.chatForSeq(job.seq);
        if (isTelegramPermanentOutError(err)) {
          console.error(`telegram out giving up seq=${job.seq} kind=${job.kind}`);
          failTelegramJob(this.hive.db, job, this.safeError(err), this.pumpFails?.n ?? 1);
          this.hive.publishTelegramHealth();
          this.pumpFails = null;
          continue;
        }
        if (isTelegramTopicRightsError(err)) {
          this.hintTopicRights();
          if (chat != null) this.skipChatUntil.set(chat, Date.now() + 15_000);
          if (!this.nextPending()) await sleep(15_000, this.abort.signal);
          continue;
        }
        if (chat != null && /429|Too Many Requests/i.test(err instanceof Error ? err.message : String(err))) {
          this.skipChatUntil.set(chat, Date.now() + 15_000);
          if (!this.nextPending()) await sleep(15_000, this.abort.signal);
          continue;
        }
        this.pumpFails = nextTelegramFailure(this.pumpFails, job.seq, job.kind);
        if (shouldDropTelegramJob(this.pumpFails.n)) {
          console.error(`telegram out giving up seq=${job.seq} kind=${job.kind}`);
          failTelegramJob(this.hive.db, job, this.safeError(err), this.pumpFails.n);
          this.hive.publishTelegramHealth();
          this.pumpFails = null;
          continue;
        }
        await sleep(2000, this.abort.signal);
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
      if (telegramPartDelivered(this.hive.db, msg.seq, partKey, chatId, telegramBotKey(this.cfg.botToken, this.cfg.botId))) return;
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

    if (text.length > 1000 && !telegramPartDelivered(this.hive.db, msg.seq, "text", chatId, telegramBotKey(this.cfg.botToken, this.cfg.botId))) {
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
      if (telegramPartDelivered(this.hive.db, msg.seq, partKey, chatId, telegramBotKey(this.cfg.botToken, this.cfg.botId))) continue;
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
      "SELECT telegram_message_id AS id FROM telegram_out WHERE seq = ? AND telegram_chat_id = ?",
    ).all(seq, chatId) as { id: number }[];
    if (rows.length === 0) return;
    const reaction = telegramOutboundReactionPayload((msg.reactions ?? []).map((r) => r.emoji));
    const emojis = reaction.map((r) => r.emoji);
    const now = Date.now();
    for (const row of rows) this.ignoreReaction.set(reactionIgnoreKey(row.id, emojis), now);
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
          (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(chatId, messageId, msg.seq, msg.channelId, msg.threadId);
      this.hive.db.prepare(
        `INSERT OR REPLACE INTO telegram_delivery_parts
          (seq, part_key, telegram_chat_id, telegram_message_id, completed_at, bot_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(msg.seq, partKey, chatId, messageId, Date.now(), telegramBotKey(this.cfg.botToken, this.cfg.botId));
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
    if (res.status === 429) {
      await sleep(Number(data.parameters?.retry_after ?? 2) * 1000, this.abort.signal);
      return this.sendFile(chatId, thread, mime, name, filePath, caption, silent);
    }
    return data;
  }

  private async filesFromMessage(message: TelegramMessage): Promise<string[]> {
    const out: string[] = [];
    const photos = message.photo ?? [];
    if (photos.length) {
      const best = photos[photos.length - 1]!;
      const id = await this.ingestTelegramFile(best.file_id, "photo.jpg", "image/jpeg");
      if (id) out.push(id);
    }
    if (message.document) {
      const name = message.document.file_name ?? "file";
      const mime = resolveUploadMime(message.document.mime_type, name);
      if (mime !== "application/octet-stream") {
        const id = await this.ingestTelegramFile(message.document.file_id, name, mime);
        if (id) out.push(id);
      }
    }
    return out;
  }

  private async ingestTelegramFile(fileId: string, name: string, mime: string): Promise<string | null> {
    const meta = await this.api("getFile", { file_id: fileId });
    const file = meta.result as { file_path?: string; file_size?: number } | undefined;
    if (!meta.ok || !file?.file_path) return null;
    if (telegramFileTooLarge(file.file_size)) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`, {
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) return null;
    this.ensureActive();
    try {
      const created = await this.hive.createFile(this.hive.getAgent(HUMAN_ID), {
        name,
        mime,
        body: res.body,
      });
      this.ensureActive();
      return created.id;
    } catch (err) {
      console.error("telegram inbound file", err instanceof Error ? err.message : err);
      return null;
    }
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
    if (res.status === 429) {
      const wait = Number(data.parameters?.retry_after ?? 2);
      await sleep(wait * 1000, this.abort.signal);
      return this.api(method, body);
    }
    return data;
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
