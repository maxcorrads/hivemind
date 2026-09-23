import { botMessageSchema, botCredentialSchema, createBotSchema } from "../../shared/bot-message.ts";
import { HiveError, type Agent, type BotCredentialView, type BotEvent, type Message } from "../../shared/types.ts";
import type { RoomStore } from "../rooms.ts";
import type { TimelineStore } from "../timeline.ts";
import type { DeliveryService } from "./delivery.ts";
import type { FileService } from "./files.ts";
import { hashToken, newToken } from "./identity.ts";
import type { AgentDirectory, ChannelAccess, Core, MessageReader, ProjectDirectory } from "./ports.ts";
import { now } from "./rows.ts";

export type BotServiceDeps = Core & {
  readonly projects: Pick<ProjectDirectory, "requireActorProject">;
  readonly identity: AgentDirectory;
  readonly channels: ChannelAccess;
  readonly messageQueries: Pick<MessageReader, "getMessageById">;
  readonly files: Pick<FileService, "validateAttachments" | "bindAttachments">;
  readonly delivery: Pick<DeliveryService, "wakeMembers">;
  readonly rooms: Pick<RoomStore, "peek">;
  readonly timeline: Pick<TimelineStore, "recordMessage">;
};

/** Bot identities (created by Human, with rotatable/revocable credentials) and their idempotent observations. */
export class BotService {
  constructor(private readonly deps: BotServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  /** Human creates a project identity with no channel memberships. Token is returned once. */
  createBot(actor: Agent, projectRef: string, raw: unknown): { bot: Agent; token: string } {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can create bots");
    const project = this.deps.projects.requireActorProject(actor, projectRef);
    const parsed = createBotSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Bot name must be 1–40 letters, digits, underscores or dashes, starting with a letter");
    const { name } = parsed.data;
    if (this.deps.identity.getAgentByName(name)) throw new HiveError(409, "This identity name is already in use");
    const id = crypto.randomUUID();
    const token = newToken();
    const t = now();
    this.db.prepare(`INSERT INTO agents
      (id, name, role, token_hash, online, last_seen_at, created_at, project_id)
      VALUES (?, ?, 'bot', ?, 0, ?, ?, ?)`).run(id, name, hashToken(token), t, t, project.id);
    const bot = this.deps.identity.getAgent(id);
    this.deps.bus.emit("agent", bot);
    return { bot, token };
  }

  botCredential(actor: Agent, projectRef: string, botId: string): BotCredentialView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const project = this.deps.projects.requireActorProject(actor, projectRef), bot = this.deps.identity.getAgent(botId);
    if (bot.role !== 'bot' || bot.projectId !== project.id) throw new HiveError(404, 'Bot not found in this project');
    const row = this.db.prepare('SELECT revision, revoked FROM bot_credentials WHERE bot_id=?').get(bot.id);
    return { bot, credential: { revision: row ? Number(row.revision) : 1, revoked: Boolean(row?.revoked) } };
  }

  changeBotCredential(actor: Agent, projectRef: string, botId: string, raw: unknown): BotCredentialView & { token?: string } {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const parsed = botCredentialSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid credential operation: choose rotate/revoke and a positive expectedRevision');
    return this.deps.storage.transaction(() => {
      const current = this.botCredential(actor, projectRef, botId);
      if (current.credential.revision !== parsed.data.expectedRevision)
        throw new HiveError(409, 'Bot credential changed; reload its state before a new operation');
      const revoked = parsed.data.action === 'revoke', revision = current.credential.revision + 1;
      const token = revoked ? undefined : newToken();
      // No possible SHA-256 token hash equals the empty revocation sentinel.
      this.db.prepare('UPDATE agents SET token_hash=? WHERE id=?').run(token ? hashToken(token) : '', botId);
      this.db.prepare(`INSERT INTO bot_credentials(bot_id,revision,revoked) VALUES(?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision, revoked=excluded.revoked`).run(botId, revision, Number(revoked));
      return { bot: current.bot, credential: { revision, revoked }, ...(token ? { token } : {}) };
    });
  }

  postBotMessage(actor: Agent, channel: string, raw: unknown): { message: Message; duplicate: boolean } {
    if (actor.role !== "bot") throw new HiveError(403, "A bot identity is required");
    const parsed = botMessageSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const input = parsed.data;
    const ch = this.deps.channels.getChannel(channel, actor.projectId);
    if (!this.deps.channels.canSeeChannel(actor, ch) || (ch.type !== "public" && ch.type !== "private")) {
      throw new HiveError(403, "Bot is not linked to this channel");
    }
    if (input.threadId) {
      const root = this.db.prepare("SELECT channel_id, thread_id FROM messages WHERE id = ?").get(input.threadId) as
        { channel_id: string; thread_id: string | null } | undefined;
      if (!root || root.channel_id !== ch.id || root.thread_id) throw new HiveError(400, "Thread must be a root message in this channel");
    }
    const event: BotEvent = { eventId: input.eventId, ...(input.origin ? { origin: input.origin } : {}) };
    const payloadHash = hashToken(JSON.stringify({ body: input.body, attachmentIds: input.attachmentIds, ...event,
      ...(input.eventType ? { eventType: input.eventType } : {}) }));
    const { messageId, duplicate } = this.deps.storage.transaction(() => {
      const previous = this.db.prepare(`SELECT message_id, payload_hash FROM bot_events
        WHERE bot_id = ? AND channel_id = ? AND thread_id = ? AND event_id = ?`)
        .get(actor.id, ch.id, input.threadId ?? "", input.eventId) as { message_id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new HiveError(409, "Event ID already used with different content; use a new revision/event ID");
        return { messageId: previous.message_id, duplicate: true };
      }
      if (this.deps.rooms.peek(ch.id)?.state === 'archived') throw new HiveError(409, 'Channel is archived; suspend this source link. Do not discard undelivered source events.');
      this.deps.files.validateAttachments(actor, input.attachmentIds);
      const messageId = crypto.randomUUID();
      this.db.prepare(`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, mentions, created_at, event_type)
        VALUES (?, ?, ?, ?, ?, 'chat', '[]', ?, ?)`)
        .run(messageId, ch.id, input.threadId ?? null, actor.id, input.body, now(), input.eventType ?? null);
      this.db.prepare(`INSERT INTO bot_events (message_id, bot_id, channel_id, thread_id, event_id, metadata, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, actor.id, ch.id, input.threadId ?? "", input.eventId, JSON.stringify(event), payloadHash);
      this.deps.timeline.recordMessage(messageId, { source: 'bot' });
      this.deps.files.bindAttachments(messageId, input.attachmentIds);
      if (input.threadId) this.db.prepare("INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')")
        .run(input.threadId, ch.id);
      return { messageId, duplicate: false };
    });
    const message = this.deps.messageQueries.getMessageById(messageId);
    if (!duplicate) {
      this.deps.bus.emit("message", message);
      this.deps.delivery.wakeMembers(ch, message);
    }
    return { message, duplicate };
  }
}
