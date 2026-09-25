import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROUTINE_BATCH_MS } from "../shared/notifications.ts";
import { AdaptiveTopologyRuntime } from "./adaptive-topology.ts";
import { DecisionStore } from "./decisions.ts";
import { HiveBus } from "./hive-events.ts";
import { InboxDeliveryStore } from "./inbox-delivery.ts";
import { InboxReader } from "./inbox-reader.ts";
import { removeLegacyIdentityDirs } from "./legacy-identities.ts";
import { applyMigrations, assertSupportedVersion } from "./migrations/index.ts";
import { NotificationStore } from "./notifications.ts";
import { hiveHome } from "./paths.ts";
import { preparePrivateDatabase } from "./private-database.ts";
import { ReadState } from "./read-state.ts";
import { RoomStore } from "./rooms.ts";
import { RoutingStore } from "./routing.ts";
import { SendRequests } from "./send-requests.ts";
import { Storage } from "./storage.ts";
import { TaskStore } from "./tasks.ts";
import { pruneTelegramUpdates } from "./telegram-inbox.ts";
import { pruneTelegramFailures } from "./telegram-outbox.ts";
import { TimelineStore } from "./timeline.ts";
import { UploadBudget, type UploadLimits } from "./upload-budget.ts";
import { AgentLifecycle } from "./services/agent-lifecycle.ts";
import { BotService } from "./services/bots.ts";
import { ChannelService } from "./services/channels.ts";
import { DeliveryService } from "./services/delivery.ts";
import { FileService } from "./services/files.ts";
import { IdentityService } from "./services/identity.ts";
import { MessageQueries } from "./services/message-queries.ts";
import { MessageService } from "./services/messages.ts";
import type { Core } from "./services/ports.ts";
import { ProjectService } from "./services/projects.ts";
import { ReadService } from "./services/reads.ts";
import { TelegramAdminService } from "./services/telegram-admin.ts";
import { Waiters } from "./services/waiters.ts";

export { hiveHome } from "./paths.ts";
export { hashToken, newToken, describeAgent } from "./services/identity.ts";
export { channelLabel } from "./services/channels.ts";
// Kept for callers that historically imported the helper from the Hive module.
export { parseMentions } from "../shared/mentions.ts";

/**
 * Every service's dependencies. Hive fills it in construction order and hands the
 * same object to each service, which sees it only through its own narrow `…Deps`
 * type and reads peers at call time (so construction order never matters).
 */
type ServiceRegistry = Core & {
  home: string;
  waiters: Waiters;
  uploads: UploadBudget;
  telegramAdmin: TelegramAdminService;
  files: FileService;
  projects: ProjectService;
  identity: IdentityService;
  lifecycle: AgentLifecycle;
  channels: ChannelService;
  messageQueries: MessageQueries;
  delivery: DeliveryService;
  messages: MessageService;
  readState: ReadState;
  sendRequests: SendRequests;
  inbox: InboxDeliveryStore;
  inboxReader: InboxReader;
  tasks: TaskStore;
  rooms: RoomStore;
  notifications: NotificationStore;
  timeline: TimelineStore;
  decisions: DecisionStore;
  adaptiveTopology: AdaptiveTopologyRuntime;
};

/**
 * The hive: opens and migrates the database, wires the domain services
 * (src/server/services/) and the coordination stores, and closes the database.
 * Callers use the services and stores it exposes (hive.channels, hive.tasks, …).
 */
export class Hive {
  /** The raw handle, for migrations, tests and diagnostics; runtime code goes through a service or store. */
  readonly db: DatabaseSync;
  /** The shared unit of work: every service and store transacts through it. */
  readonly storage: Storage;
  /** Post-commit change notifications; see HiveEvents for every event and payload. */
  readonly bus = new HiveBus();
  readonly home: string;

  readonly telegramAdmin!: TelegramAdminService;
  readonly files!: FileService;
  readonly projects!: ProjectService;
  readonly identity!: IdentityService;
  readonly lifecycle!: AgentLifecycle;
  readonly channels!: ChannelService;
  readonly messageQueries!: MessageQueries;
  readonly messages!: MessageService;
  readonly delivery!: DeliveryService;
  readonly reads!: ReadService;
  readonly bots!: BotService;

  readonly uploads!: UploadBudget;
  readonly inbox!: InboxDeliveryStore;
  readonly tasks!: TaskStore;
  readonly routing!: RoutingStore;
  readonly rooms!: RoomStore;
  readonly notifications!: NotificationStore;
  readonly decisions!: DecisionStore;
  readonly timeline!: TimelineStore;
  readonly adaptiveTopology!: AdaptiveTopologyRuntime;

  constructor(dbPath = path.join(hiveHome(), "hive.db"), options: { routineBatchMs?: number; uploadLimits?: Partial<UploadLimits> } = {}) {
    this.home = path.dirname(dbPath);
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    preparePrivateDatabase(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.storage = Storage.for(this.db);
    this.bus.bindStorage(this.storage);
    const partial: Partial<ServiceRegistry> = { storage: this.storage, bus: this.bus, home: this.home, waiters: new Waiters() };
    const services = partial as ServiceRegistry;
    try {
      // Refuse a newer or unknown schema before anything (even the journal mode) writes to the file.
      assertSupportedVersion(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Every table, index and trigger comes from the versioned migrations; stores only prepare statements.
      applyMigrations(this.db);
      // Constructing a domain service has no side effects.
      this.uploads = services.uploads = new UploadBudget({ db: this.db, transaction: work => this.storage.transaction(work) }, options.uploadLimits);
      this.telegramAdmin = services.telegramAdmin = new TelegramAdminService(services);
      this.files = services.files = new FileService(services);
      this.projects = services.projects = new ProjectService(services);
      this.identity = services.identity = new IdentityService(services);
      this.lifecycle = services.lifecycle = new AgentLifecycle(services);
      this.channels = services.channels = new ChannelService(services);
      this.messageQueries = services.messageQueries = new MessageQueries(services);
      this.delivery = services.delivery = new DeliveryService(services);
      this.messages = services.messages = new MessageService(services);
      this.reads = new ReadService(services);
      this.bots = new BotService(services);
      this.storage.transaction(() => this.bootstrap());
      this.storage.transaction(() => { pruneTelegramUpdates(this.db); pruneTelegramFailures(this.db); });
      services.readState = new ReadState(this.db);
      services.sendRequests = new SendRequests(this.db);
      // The coordination stores take the same registry, each typed down to its slice (services/ports.ts).
      this.tasks = services.tasks = new TaskStore(services);
      this.rooms = services.rooms = new RoomStore(services);
      this.notifications = services.notifications = new NotificationStore(services);
      this.routing = new RoutingStore(services);
      this.timeline = services.timeline = new TimelineStore(services);
      this.decisions = services.decisions = new DecisionStore(services, work => this.storage.transaction(work));
      this.adaptiveTopology = services.adaptiveTopology = new AdaptiveTopologyRuntime(services);
      this.inbox = services.inbox = new InboxDeliveryStore(this.db);
      services.inboxReader = new InboxReader(this.db, this.inbox, this.notifications, options.routineBatchMs ?? ROUTINE_BATCH_MS);
    } catch (error) {
      try { this.db.close(); } catch { /* preserve the initialization failure */ }
      throw error;
    }
    removeLegacyIdentityDirs(this.home);
  }

  private bootstrap() {
    this.identity.ensureHuman();
    // The test runner sets this so fixtures that join "acme" keep a project.
    // A normal hive starts empty; Human creates the first project.
    const fixture = process.env.HIVEMIND_FIXTURE_PROJECT;
    if (fixture && this.projects.listProjects().length === 0) {
      this.projects.createProject(this.identity.getAgent("human"), { name: fixture, slug: fixture });
    }
    const home = this.projects.listProjects()[0];
    if (home) this.channels.ensureBuiltinChannels(home);
    this.channels.addHumanToAllChannels();
  }

  /** Closes the database. Stop the runtimes that use it (HTTP, Telegram, adaptive routing) first. */
  close() {
    this.db.close();
  }
}
