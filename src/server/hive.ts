import { RoutingStore } from './routing.ts';
import { DecisionStore } from './decisions.ts';
import { TimelineStore } from './timeline.ts';
import { UploadBudget, type UploadLimits } from "./upload-budget.ts";
import { SendRequests } from "./send-requests.ts";
import { pruneTelegramUpdates, type TelegramUpdateScope } from "./telegram-inbox.ts";
import { pruneTelegramFailures, type TelegramDestination } from "./telegram-outbox.ts";
import { TelegramAdminService } from "./services/telegram-admin.ts";
import { FileService } from "./services/files.ts";
import { ProjectService } from "./services/projects.ts";
import { IdentityService, hashToken, newToken, type JoinInput } from "./services/identity.ts";
import { Waiters } from "./services/waiters.ts";
import { ChannelService } from "./services/channels.ts";
import { MessageQueries } from "./services/message-queries.ts";
import { DeliveryService } from "./services/delivery.ts";
import { ReadService } from "./services/reads.ts";
import { MessageService } from "./services/messages.ts";
import type { Core, PostMessageInput } from "./services/ports.ts";
import { Storage } from './storage.ts';
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HiveBus } from "./hive-events.ts";
import {
  HiveError,
  type Agent,
  type BotEvent,
  type BotCredentialView,
  type Channel,
  type Message,
  type ThreadStatus,
  } from "../shared/types.ts";
import { ReadState } from "./read-state.ts";
import { InboxDeliveryStore } from "./inbox-delivery.ts";
import { InboxReader } from "./inbox-reader.ts";
import { hiveHome } from "./paths.ts";
import { preparePrivateDatabase } from "./private-database.ts";
import { removeLegacyIdentityDirs } from "./legacy-identities.ts";
import { botMessageSchema, createBotSchema, botCredentialSchema } from "../shared/bot-message.ts";
import { applyMigrations, assertSupportedVersion } from "./migrations/index.ts";
import { TaskStore } from './tasks.ts';
import { NotificationStore } from './notifications.ts';
import { RoomStore } from './rooms.ts';
import { ROUTINE_BATCH_MS } from '../shared/notifications.ts';
import { AdaptiveTopologyRuntime } from './adaptive-topology.ts';

export { hiveHome } from "./paths.ts";
export { hashToken, newToken, describeAgent } from "./services/identity.ts";
export { channelLabel } from "./services/channels.ts";
import { parseMentions } from "../shared/mentions.ts";
// Kept for callers that historically imported the helper from the Hive module.
export { parseMentions };






function now(): number {
  return Date.now();
}

/** Every service's dependencies; filled in construction order, read by services at call time. */
type ServiceRegistry = Core & {
  home: string;
  uploads: UploadBudget;
  telegram: TelegramAdminService;
  files: FileService;
  projects: ProjectService;
  messages: MessageService;
  sendRequests: SendRequests;
  channels: ChannelService;
  reader: MessageQueries;
  delivery: DeliveryService;
  readState: ReadState;
  deliveries: InboxDeliveryStore;
  inboxReader: InboxReader;
  tasks: TaskStore;
  rooms: RoomStore;
  timeline: TimelineStore;
  decisions: DecisionStore;
  adaptiveTopology: AdaptiveTopologyRuntime;
  agents: IdentityService;
  waiters: Waiters;
};

export class Hive {
  db: DatabaseSync;
  /** Post-commit change notifications; see HiveEvents for every event and payload. */
  readonly bus = new HiveBus();
  readonly home: string;
  readonly inbox!: InboxDeliveryStore;
  private readonly inboxReader!: InboxReader;
  private readonly sendRequests!: SendRequests;
  readonly tasks!: TaskStore;
  readonly routing!: RoutingStore;
  readonly rooms!: RoomStore;
  readonly notifications!: NotificationStore;
  readonly decisions!: DecisionStore;
  readonly timeline!: TimelineStore;
  readonly adaptiveTopology!: AdaptiveTopologyRuntime;
  private readonly waiters = new Waiters();
  readonly uploads!: UploadBudget;
  private readonly readState!: ReadState;
  readonly storage: Storage;
  readonly telegramAdmin!: TelegramAdminService;
  readonly files!: FileService;
  readonly projects!: ProjectService;
  readonly identity!: IdentityService;
  readonly channels!: ChannelService;
  readonly messageQueries!: MessageQueries;
  readonly delivery!: DeliveryService;
  readonly messages!: MessageService;
  readonly reads!: ReadService;
  /** The registry every service receives, typed down to its own dependencies (services/ports.ts). */
  private readonly services: ServiceRegistry;

  constructor(dbPath = path.join(hiveHome(), "hive.db"), options: { routineBatchMs?: number; uploadLimits?: Partial<UploadLimits> } = {}) {
    this.home = path.dirname(dbPath);
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    preparePrivateDatabase(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.storage = Storage.for(this.db);
    // Transitional: domains not yet extracted are served by Hive itself.
    const registry: Partial<ServiceRegistry> = { storage: this.storage, bus: this.bus, home: this.home, waiters: this.waiters };
    this.services = registry as ServiceRegistry;
    this.bus.bindStorage(this.storage);
    try {
      // Refuse a newer or unknown schema before anything (even the journal mode) writes to the file.
      assertSupportedVersion(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Every table, index and trigger comes from the versioned migrations; stores only prepare statements.
      applyMigrations(this.db);
      // Domain services: constructing them has no side effects (see services/ports.ts).
      const services = this.services;
      this.uploads = services.uploads = new UploadBudget({ db: this.db, transaction: work => this.transaction(work) }, options.uploadLimits);
      this.telegramAdmin = services.telegram = new TelegramAdminService(services);
      this.files = services.files = new FileService(services);
      this.projects = services.projects = new ProjectService(services);
      this.identity = services.agents = new IdentityService(services);
      this.channels = services.channels = new ChannelService(services);
      this.messageQueries = services.reader = new MessageQueries(services);
      this.delivery = services.delivery = new DeliveryService(services);
      this.messages = services.messages = new MessageService(services);
      this.reads = new ReadService(services);
      this.transaction(() => this.bootstrap());
      this.transaction(() => { pruneTelegramUpdates(this.db); pruneTelegramFailures(this.db); });
      this.readState = services.readState = new ReadState(this.db);
      this.sendRequests = services.sendRequests = new SendRequests(this.db);
      this.tasks = services.tasks = new TaskStore(this);
      this.rooms = services.rooms = new RoomStore(this);
      this.notifications = new NotificationStore(this);
      this.routing = new RoutingStore(this);
      this.timeline = services.timeline = new TimelineStore(this);
      this.decisions = services.decisions = new DecisionStore(this, work => this.transaction(work));
      this.adaptiveTopology = services.adaptiveTopology = new AdaptiveTopologyRuntime(this);
      this.inbox = services.deliveries = new InboxDeliveryStore(this.db);
      this.inboxReader = services.inboxReader = new InboxReader(this.db, this.inbox, this.notifications, options.routineBatchMs ?? ROUTINE_BATCH_MS);
    } catch (error) {
      try { this.db.close(); } catch { /* preserve the initialization failure */ }
      throw error;
    }
    removeLegacyIdentityDirs(this.home);
  }

  /** The shared unit of work (see storage.ts): savepoints nest, effects wait for the outer commit. */
  private transaction<T>(body: () => T): T {
    return this.storage.transaction(body);
  }

  private afterCommit(effect: () => void): void {
    this.storage.afterCommit(effect);
  }

  listProjects() { return this.projects.listProjects(); }
  getProject(id: string) { return this.projects.getProject(id); }
  getProjectBySlug(slug: string) { return this.projects.getProjectBySlug(slug); }
  findProjectBySlug(slug: string) { return this.projects.findProjectBySlug(slug); }
  createProject(...args: Parameters<ProjectService["createProject"]>) { return this.projects.createProject(...args); }
  updateProject(...args: Parameters<ProjectService["updateProject"]>) { return this.projects.updateProject(...args); }
  deleteProject(...args: Parameters<ProjectService["deleteProject"]>) { this.projects.deleteProject(...args); }

  touch(agentId: string, online?: boolean) { this.identity.touch(agentId, online); }
  setOffline(agentId: string) { this.identity.setOffline(agentId); }
  sweepPresence(maxIdleMs?: number) { this.identity.sweepPresence(maxIdleMs); }
  removeAgent(actor: Agent, name: string) { return this.identity.removeAgent(actor, name); }
  getAgent(id: string) { return this.identity.getAgent(id); }
  getAgentByName(name: string) { return this.identity.getAgentByName(name); }
  agentByToken(token: string) { return this.identity.agentByToken(token); }
  listAgents(viewer?: Agent) { return this.identity.listAgents(viewer); }
  join(input: JoinInput) { return this.identity.join(input); }

  addMember(channelId: string, agentId: string) { this.channels.addMember(channelId, agentId); }
  listChannels(actor: Agent) { return this.channels.listChannels(actor); }
  getChannel(idOrName: string, projectId?: string | null) { return this.channels.getChannel(idOrName, projectId); }
  canSeeChannel(actor: Agent, ch: Channel) { return this.channels.canSeeChannel(actor, ch); }
  canPost(actor: Agent, ch: Channel) { return this.channels.canPost(actor, ch); }
  createChannel(...args: Parameters<ChannelService["createChannel"]>) { return this.channels.createChannel(...args); }
  openDm(actor: Agent, otherName: string) { return this.channels.openDm(actor, otherName); }
  findDm(a: string, b: string) { return this.channels.findDm(a, b); }
  invite(actor: Agent, channelRef: string, memberNames: string[]) { return this.channels.invite(actor, channelRef, memberNames); }
  telegramOutboxHealth() { return this.telegramAdmin.outboxHealth(); }
  telegramPollHealth() { return this.telegramAdmin.pollHealth(); }
  telegramHealth() { return this.telegramAdmin.health(); }
  publishTelegramHealth() { this.telegramAdmin.publishHealth(); }
  telegramQuarantine(limit?: number) { return this.telegramAdmin.quarantine(limit); }
  retryTelegramUpdate(id: string, matchesScope: (scope: TelegramUpdateScope) => boolean) { this.telegramAdmin.retryUpdate(id, matchesScope); }
  discardTelegramUpdate(id: string) { this.telegramAdmin.discardUpdate(id); }
  telegramFailureCount(): number { return this.telegramAdmin.failureCount(); }
  telegramFailures(limit?: number) { return this.telegramAdmin.failures(limit); }
  retryTelegramFailure(id: string, destination: (seq: number) => TelegramDestination | undefined): void { this.telegramAdmin.retryFailure(id, destination); }
  discardTelegramFailure(id: string): void { this.telegramAdmin.discardFailure(id); }
  forgetTelegramChat(chatId: number) { this.telegramAdmin.forgetChat(chatId); }

  private bootstrap() {
    this.identity.ensureHuman();
    const home = this.projects.listProjects()[0];
    if (home) this.channels.ensureBuiltinChannels(home);
    this.channels.addHumanToAllChannels();
  }

  /** Human creates a project identity with no channel memberships. Token is returned once. */
  createBot(actor: Agent, projectRef: string, raw: unknown): { bot: Agent; token: string } {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can create bots");
    const project = this.projects.requireActorProject(actor, projectRef);
    const parsed = createBotSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Bot name must be 1–40 letters, digits, underscores or dashes, starting with a letter");
    const { name } = parsed.data;
    if (this.identity.getAgentByName(name)) throw new HiveError(409, "This identity name is already in use");
    const id = crypto.randomUUID();
    const token = newToken();
    const t = now();
    this.db.prepare(`INSERT INTO agents
      (id, name, role, token_hash, online, last_seen_at, created_at, project_id)
      VALUES (?, ?, 'bot', ?, 0, ?, ?, ?)`).run(id, name, hashToken(token), t, t, project.id);
    const bot = this.identity.getAgent(id);
    this.bus.emit("agent", bot);
    return { bot, token };
  }

  botCredential(actor: Agent, projectRef: string, botId: string): BotCredentialView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const project = this.projects.requireActorProject(actor, projectRef), bot = this.identity.getAgent(botId);
    if (bot.role !== 'bot' || bot.projectId !== project.id) throw new HiveError(404, 'Bot not found in this project');
    const row = this.db.prepare('SELECT revision, revoked FROM bot_credentials WHERE bot_id=?').get(bot.id);
    return { bot, credential: { revision: row ? Number(row.revision) : 1, revoked: Boolean(row?.revoked) } };
  }

  changeBotCredential(actor: Agent, projectRef: string, botId: string, raw: unknown): BotCredentialView & { token?: string } {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const parsed = botCredentialSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid credential operation: choose rotate/revoke and a positive expectedRevision');
    return this.transaction(() => {
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
    const ch = this.channels.getChannel(channel, actor.projectId);
    if (!this.channels.canSeeChannel(actor, ch) || (ch.type !== "public" && ch.type !== "private")) {
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
    const { messageId, duplicate } = this.transaction(() => {
      const previous = this.db.prepare(`SELECT message_id, payload_hash FROM bot_events
        WHERE bot_id = ? AND channel_id = ? AND thread_id = ? AND event_id = ?`)
        .get(actor.id, ch.id, input.threadId ?? "", input.eventId) as { message_id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new HiveError(409, "Event ID already used with different content; use a new revision/event ID");
        return { messageId: previous.message_id, duplicate: true };
      }
      if (this.rooms.peek(ch.id)?.state === 'archived') throw new HiveError(409, 'Channel is archived; suspend this source link. Do not discard undelivered source events.');
      this.files.validateAttachments(actor, input.attachmentIds);
      const messageId = crypto.randomUUID();
      this.db.prepare(`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, mentions, created_at, event_type)
        VALUES (?, ?, ?, ?, ?, 'chat', '[]', ?, ?)`)
        .run(messageId, ch.id, input.threadId ?? null, actor.id, input.body, now(), input.eventType ?? null);
      this.db.prepare(`INSERT INTO bot_events (message_id, bot_id, channel_id, thread_id, event_id, metadata, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, actor.id, ch.id, input.threadId ?? "", input.eventId, JSON.stringify(event), payloadHash);
      this.timeline.recordMessage(messageId, { source: 'bot' });
      this.files.bindAttachments(messageId, input.attachmentIds);
      if (input.threadId) this.db.prepare("INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')")
        .run(input.threadId, ch.id);
      return { messageId, duplicate: false };
    });
    const message = this.messageQueries.getMessageById(messageId);
    if (!duplicate) {
      this.bus.emit("message", message);
      this.delivery.wakeMembers(ch, message);
    }
    return { message, duplicate };
  }

  postMessage(actor: Agent, input: PostMessageInput, persistReceipt?: (message: Message) => void) { return this.messages.postMessage(actor, input, persistReceipt); }
  postAdaptiveRequest(...args: Parameters<MessageService["postAdaptiveRequest"]>) { return this.messages.postAdaptiveRequest(...args); }
  hasActiveSendRequest(actor: Agent, channelRef: string, requestId: string | undefined) { return this.messages.hasActiveSendRequest(actor, channelRef, requestId); }
  fromTelegram(messageId: string) { return this.messages.fromTelegram(messageId); }
  postSystem(channelId: string, body: string) { this.messages.postSystem(channelId, body); }
  publishTaskMessage(message: Message) { this.messages.publishTaskMessage(message); }
  setThreadStatus(actor: Agent, threadId: string, status: ThreadStatus | null) { return this.messages.setThreadStatus(actor, threadId, status); }
  clearContext(actor: Agent, targetName: string) { return this.messages.clearContext(actor, targetName); }
  toggleReaction(actor: Agent, seq: number, emoji: string) { return this.messages.toggleReaction(actor, seq, emoji); }
  setReaction(...args: Parameters<MessageService["setReaction"]>) { return this.messages.setReaction(...args); }
  getVisibleMessage(actor: Agent, seq: number) { return this.messageQueries.getVisibleMessage(actor, seq); }
  getMessageBySeq(seq: number) { return this.messageQueries.getMessageBySeq(seq); }
  getMessageById(id: string) { return this.messageQueries.getMessageById(id); }
  hasReaction(agentId: string, messageId: string, emoji: string) { return this.messageQueries.hasReaction(agentId, messageId, emoji); }
  listMessages(...args: Parameters<MessageQueries["listMessages"]>) { return this.messageQueries.listMessages(...args); }
  expandDigest(actor: Agent, raw: unknown) { return this.messageQueries.expandDigest(actor, raw); }
  searchMessages(...args: Parameters<MessageQueries["searchMessages"]>) { return this.messageQueries.searchMessages(...args); }
  threadsInChannel(channelId: string) { return this.messageQueries.threadsInChannel(channelId); }
  replyCounts(channelId: string) { return this.messageQueries.replyCounts(channelId); }
  latestSeq(channelId: string) { return this.messageQueries.latestSeq(channelId); }
  markRead(actor: Agent, channelId: string, seq: number) { this.reads.markRead(actor, channelId, seq); }
  readsFor(actor: Agent) { return this.reads.readsFor(actor); }
  unreadCounts(actor: Agent) { return this.reads.unreadCounts(actor); }
  markMessagesRead(...args: Parameters<ReadService["markMessagesRead"]>) { this.reads.markMessagesRead(...args); }
  markMentionsSeen(actor: Agent, projectId?: string) { this.reads.markMentionsSeen(actor, projectId); }
  mentionInbox(...args: Parameters<ReadService["mentionInbox"]>) { return this.reads.mentionInbox(...args); }
  readSnapshot(actor: Agent) { return this.reads.readSnapshot(actor); }
  openInboxSession(actor: Agent, sessionId: string) { return this.delivery.openInboxSession(actor, sessionId); }
  acknowledgeInbox(actor: Agent, sessionId: string, deliveryId: string) { return this.delivery.acknowledgeInbox(actor, sessionId, deliveryId); }
  inboxStatuses() { return this.delivery.inboxStatuses(); }
  queuedCounts() { return this.delivery.queuedCounts(); }
  isFor(actor: Agent, msg: Message) { return this.delivery.isFor(actor, msg); }
  wait(...args: Parameters<DeliveryService["wait"]>) { return this.delivery.wait(...args); }
  cancelWaits() { this.delivery.cancelWaits(); }
  createFile(...args: Parameters<FileService["createFile"]>) { return this.files.createFile(...args); }
  createFileFromBytes(...args: Parameters<FileService["createFileFromBytes"]>) { return this.files.createFileFromBytes(...args); }
  getAttachment(actor: Agent, id: string) { return this.files.getAttachment(actor, id); }
  openAttachment(actor: Agent, id: string) { return this.files.openAttachment(actor, id); }
  gcFiles() { return this.files.gcFiles(); }

}
