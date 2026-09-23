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
import { IdentityService, type JoinInput } from "./services/identity.ts";
import { Waiters } from "./services/waiters.ts";
import { ChannelService } from "./services/channels.ts";
import { MessageQueries } from "./services/message-queries.ts";
import { DeliveryService } from "./services/delivery.ts";
import { ReadService } from "./services/reads.ts";
import { MessageService } from "./services/messages.ts";
import { BotService } from "./services/bots.ts";
import type { Core, PostMessageInput } from "./services/ports.ts";
import { Storage } from './storage.ts';
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HiveBus } from "./hive-events.ts";
import {
  type Agent,
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
  readonly bots!: BotService;
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
      this.bots = new BotService(services);
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

  createBot(actor: Agent, projectRef: string, raw: unknown) { return this.bots.createBot(actor, projectRef, raw); }
  botCredential(actor: Agent, projectRef: string, botId: string) { return this.bots.botCredential(actor, projectRef, botId); }
  changeBotCredential(...args: Parameters<BotService["changeBotCredential"]>) { return this.bots.changeBotCredential(...args); }
  postBotMessage(actor: Agent, channel: string, raw: unknown) { return this.bots.postBotMessage(actor, channel, raw); }
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
