import { RoutingStore } from './routing.ts';
import { DecisionStore } from './decisions.ts';
import { TimelineStore } from './timeline.ts';
import { UploadBudget, type UploadLimits } from "./upload-budget.ts";
import { joinInputSchema, validated, waitDurationSchema, cursorSchema, limitSchema, channelInputSchema, attachmentIdsSchema, memberNamesSchema } from "../shared/api-contract.ts";
import { SendRequests } from "./send-requests.ts";
import { initTelegramInbox, telegramQuarantine, retryTelegramUpdate, discardTelegramUpdate, type TelegramUpdateScope } from "./telegram-inbox.ts";
import { initTelegramOutbox, retryTelegramOutboxFailure, pruneTelegramFailures, type TelegramDestination } from "./telegram-outbox.ts";
import { immediateTransaction } from './transaction.ts';
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  BODY_MAX,
  DEFAULT_WAIT_MS,
  FILES_PER_MESSAGE,
  MESSAGE_EVENT_TYPES,
  WAIT_MAX_BYTES,
  PRESENCE_IDLE_MS,
  REACTION_EMOJIS,
  HiveError,
  DEFAULT_PROJECT_SLUG,
  HUMAN_ID,
  HUMAN_NAME,
  WAIT_SCAN_MAX,
  type Agent,
  type BotEvent,
  type BotCredentialView,
  type AttachmentMeta,
  type Channel,
  type ChannelType,
  type ControlAction,
  type Message,
  type Project,
  type SearchHit,
  type ReactionCount,
  type Role,
  type Seniority,
  type Thread,
  type ThreadStatus,
  type WaitResult,
  type InboxStatus,
  type QueueEstimate,
  type DigestExpansionResult,
} from "../shared/types.ts";
import { canonicalWorktree, parseProjectSlug, resolveJoinProject } from "../shared/project.ts";
import { clampSearchLimit, likeNeedle, parseSearchQuery, snippetAround } from "../shared/search-query.ts";
import { pickName } from "./names.ts";
import { ReadState } from "./read-state.ts";
import { InboxDeliveryStore } from "./inbox-delivery.ts";
import { InboxReader } from "./inbox-reader.ts";
import type { MentionPage, ReadSnapshot } from "../shared/read-state.ts";
import { hiveHome } from "./paths.ts";
import { preparePrivateDatabase } from "./private-database.ts";
import { packWait } from "./wait-format.ts";
import { digestExpansionSchema } from "../shared/digest.ts";
import { botMessageSchema, createBotSchema, botCredentialSchema } from "../shared/bot-message.ts";
import { STORAGE_VERSION, storageVersion, validateCurrentStorage, migrateProjectStorage } from "./storage-migrations.ts";
import { assertAllowedMime, commitUpload, openBlob, removeOrphanBlobs, removeUploadTemp, streamUpload } from "./files.ts";
import { TaskStore } from './tasks.ts';
import { NotificationStore } from './notifications.ts';
import { RoomStore } from './rooms.ts';
import { ROUTINE_BATCH_MS } from '../shared/notifications.ts';
import { AdaptiveTopologyRuntime } from './adaptive-topology.ts';
import type { TaskEnvelope } from '../shared/tasks.ts';

export { hiveHome } from "./paths.ts";

type AgentRow = {
  id: string;
  name: string;
  role: Role;
  seniority: Seniority | null;
  focus: string | null;
  token_hash: string;
  online: number;
  last_seen_at: number;
  created_at: number;
  inbox_cursor: number;
  project_id: string | null;
};

type ChannelRow = {
  id: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  created_by: string;
  created_at: number;
  project_id: string;
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  worktree: string | null;
  created_at: number;
};

type MessageRow = {
  seq: number;
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  body: string | Uint8Array;
  kind: "chat" | "system" | "control";
  control: ControlAction | null;
  event_type?: Message["eventType"] | null;
  mentions: string;
  recipients?: string;
  created_at: number;
};


export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `hm_${randomBytes(24).toString("hex")}`;
}

const HYDRATION_BATCH = 400;
function* batches<T>(items: T[]): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += HYDRATION_BATCH) {
    yield items.slice(offset, offset + HYDRATION_BATCH);
  }
}

function now(): number {
  return Date.now();
}

type Waiter = {
  wake: () => void;
  supersede: () => void;
};

export class Hive {
  db: DatabaseSync;
  bus = new EventEmitter();
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
  private waiters = new Map<string, Waiter>();
  private telegramOrigin = new Set<string>();
  readonly uploads!: UploadBudget;
  private readonly readState!: ReadState;
  private transactionDepth = 0;
  private committedEffects: Array<() => void> = [];

  constructor(dbPath = path.join(hiveHome(), "hive.db"), options: { routineBatchMs?: number; uploadLimits?: Partial<UploadLimits> } = {}) {
    this.home = path.dirname(dbPath);
    this.bus.setMaxListeners(200);
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    preparePrivateDatabase(dbPath);
    this.db = new DatabaseSync(dbPath);
    try {
      storageVersion(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.transaction(() => {
        const version = storageVersion(this.db);
        // A versioned but partial schema must not be silently bootstrapped.
        if (version === STORAGE_VERSION) validateCurrentStorage(this.db);
        this.migrate();
        migrateProjectStorage(this.db);
        // Project columns exist only after migration; keep indexes in the same transaction.
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_agents_project_role ON agents(project_id, role);
          CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
          CREATE INDEX IF NOT EXISTS idx_channels_project_type_name ON channels(project_id, type, name);
          CREATE INDEX IF NOT EXISTS idx_channel_members_agent_channel ON channel_members(agent_id, channel_id);
        `);
        this.bootstrap();
        this.db.exec(`PRAGMA user_version = ${STORAGE_VERSION}`);
      });
      initTelegramOutbox(this.db);
      initTelegramInbox(this.db);
      pruneTelegramFailures(this.db);
      this.readState = new ReadState(this.db);
      this.sendRequests = new SendRequests(this.db);
      this.uploads = new UploadBudget({ db: this.db, transaction: work => this.transaction(work) }, options.uploadLimits);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_credentials (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, revoked INTEGER NOT NULL);`);
      this.tasks = new TaskStore(this);
      this.rooms = new RoomStore(this);
      this.notifications = new NotificationStore(this);
      this.routing = new RoutingStore(this);
      this.timeline = new TimelineStore(this);
      this.decisions = new DecisionStore(this, work => this.transaction(work));
      this.adaptiveTopology = new AdaptiveTopologyRuntime(this);
      this.inbox = new InboxDeliveryStore(this.db);
      this.inboxReader = new InboxReader(this.db, this.inbox, this.notifications, options.routineBatchMs ?? ROUTINE_BATCH_MS);
    } catch (error) {
      try { this.db.close(); } catch { /* preserve the initialization failure */ }
      throw error;
    }
  }

  /** Synchronous transactions compose through savepoints. Effects wait for the outer commit. */
  private transaction<T>(body: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `hive_${depth}`;
    const effectCount = this.committedEffects.length;
    this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    let result: T;
    try {
      result = body();
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    } catch (error) {
      this.committedEffects.length = effectCount;
      try {
        this.db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // Preserve the original failure, including a failed COMMIT.
      }
      throw error;
    } finally {
      this.transactionDepth = depth;
    }
    if (depth === 0) {
      const effects = this.committedEffects.splice(0);
      for (const effect of effects) effect();
    }
    return result;
  }

  private afterCommit(effect: () => void): void {
    if (this.transactionDepth > 0) this.committedEffects.push(effect);
    else effect();
  }

  private tableSql(name: string): string {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql: string }
      | undefined;
    return row?.sql ?? "";
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        seniority TEXT,
        focus TEXT,
        token_hash TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        inbox_cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        control TEXT,
        mentions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS reads (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS bot_events (
        message_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        event_id TEXT NOT NULL,
        metadata TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        UNIQUE (bot_id, channel_id, thread_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);\n      CREATE INDEX IF NOT EXISTS idx_messages_channel_thread_seq ON messages(channel_id, thread_id, seq);
      CREATE TABLE IF NOT EXISTS telegram_topics (
        channel_id TEXT PRIMARY KEY,
        telegram_thread_id INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS telegram_out (
        telegram_message_id INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS telegram_in (
        update_id INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS telegram_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_telegram_out_seq ON telegram_out(seq);
      CREATE TABLE IF NOT EXISTS telegram_pending (
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (seq, kind)
      );
      CREATE TABLE IF NOT EXISTS telegram_delivery_parts (
        seq INTEGER NOT NULL,
        part_key TEXT NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (seq, part_key, telegram_chat_id)
      );
      CREATE TABLE IF NOT EXISTS telegram_failures (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        telegram_chat_id INTEGER,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_failures_open ON telegram_failures(resolved_at, created_at);

      CREATE TABLE IF NOT EXISTS telegram_hold (
        telegram_message_id INTEGER PRIMARY KEY,
        telegram_thread_id INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    if (!this.db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "event_type")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN event_type TEXT");
    }
    // Legacy bots have revision 1 and keep their existing token hash. A row is
    // needed only after the first credential change; no raw token is stored.
    this.db.exec(`CREATE TABLE IF NOT EXISTS bot_credentials (
      bot_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, revoked INTEGER NOT NULL
    )`);
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'recipients')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private mapProject(row: ProjectRow): Project {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      worktree: row.worktree,
      createdAt: row.created_at,
    };
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC, slug ASC").all() as ProjectRow[]).map(
      (r) => this.mapProject(r),
    );
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new HiveError(404, "Project not found");
    return this.mapProject(row);
  }

  getProjectBySlug(slug: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(parseProjectSlug(slug)) as
      | ProjectRow
      | undefined;
    if (!row) throw new HiveError(404, `No project named ${slug}`);
    return this.mapProject(row);
  }

  findProjectBySlug(slug: string): Project | null {
    try {
      return this.getProjectBySlug(slug);
    } catch (err) {
      if (err instanceof HiveError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  private requireActorProject(actor: Agent, projectRef?: string | null): Project {
    if (actor.role === "human") {
      if (projectRef) {
        const byId = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectRef) as ProjectRow | undefined;
        if (byId) return this.mapProject(byId);
        return this.getProjectBySlug(projectRef);
      }
      throw new HiveError(400, "Pass project");
    }
    if (!actor.projectId) throw new HiveError(409, `${actor.name} has no project`);
    if (projectRef) {
      const wanted = (() => {
        const byId = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectRef) as ProjectRow | undefined;
        if (byId) return this.mapProject(byId);
        return this.getProjectBySlug(projectRef);
      })();
      if (wanted.id !== actor.projectId) {
        throw new HiveError(403, `${actor.name} cannot use project ${wanted.slug}`);
      }
      return wanted;
    }
    return this.getProject(actor.projectId);
  }

  createProject(
    actor: Agent,
    input: { name: string; slug?: string; worktree?: string | null },
  ): Project {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can create projects");
    const name = input.name.trim();
    if (!name) throw new HiveError(400, "Project name required");
    const slug = parseProjectSlug(input.slug?.trim() || name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
    const id = crypto.randomUUID();
    return this.transaction(() => {
      const exists = this.db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
      if (exists) throw new HiveError(409, `Project ${slug} already exists`);
      this.db.prepare("INSERT INTO projects (id, slug, name, worktree, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        slug,
        name.slice(0, 80),
        canonicalWorktree(input.worktree),
        now(),
      );
      const project = this.getProject(id);
      this.ensureBuiltinChannel(project, "general", "public", "Town square");
      this.ensureBuiltinChannel(project, "brains", "brains", "Human and brains only");
      this.addHumanToAllChannels();
      return this.getProject(id);
    });
  }

  updateProject(
    actor: Agent,
    slug: string,
    input: { name?: string; worktree?: string | null },
  ): Project {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can edit projects");
    const project = this.getProjectBySlug(slug);
    const name = input.name != null ? input.name.trim().slice(0, 80) : project.name;
    if (!name) throw new HiveError(400, "Project name required");
    const worktree = input.worktree === undefined ? project.worktree : canonicalWorktree(input.worktree);
    this.db.prepare("UPDATE projects SET name = ?, worktree = ? WHERE id = ?").run(name, worktree, project.id);
    return this.getProject(project.id);
  }

  private projectBusyAgents(projectId: string): Agent[] {
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND id != ? AND role != 'human'",
    ).all(projectId, HUMAN_ID) as AgentRow[];
    return rows.map((row) => this.mapAgent(row)).filter((agent) => agent.online || this.waiters.has(agent.id));
  }

  deleteProject(actor: Agent, slug: string, opts: { telegramChatId?: number | null } = {}): void {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can delete projects");
    const project = this.getProjectBySlug(slug);

    try {
      this.db.exec("BEGIN IMMEDIATE");
      const busy = this.projectBusyAgents(project.id);
      if (busy.length > 0) {
        const names = busy.map((agent) => agent.name).join(", ");
        const verb = busy.length === 1 ? "is" : "are";
        throw new HiveError(409, `Cannot delete ${project.slug}: ${names} ${verb} still online or waiting`);
      }

      this.db.prepare("DELETE FROM telegram_update_failures WHERE project_id = ?").run(project.id);
      this.db.prepare("DELETE FROM telegram_update_failures WHERE project_id = ?").run(project.id);
      const channels = this.db.prepare("SELECT id FROM channels WHERE project_id = ?").all(project.id) as { id: string }[];
      const channelIds = channels.map((row) => row.id);
      const goneAgents = this.db.prepare("SELECT id FROM agents WHERE project_id = ? AND id != ?").all(
        project.id,
        HUMAN_ID,
      ) as { id: string }[];
      const chatIds = new Set<number>();
      if (opts.telegramChatId != null && Number.isFinite(opts.telegramChatId)) chatIds.add(Number(opts.telegramChatId));

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
          `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (${ph}))`,
        ).run(...channelIds);
        this.db.prepare(
          `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (${ph}))`,
        ).run(...channelIds);
        this.db.prepare(
          `DELETE FROM telegram_pending WHERE seq IN (SELECT seq FROM messages WHERE channel_id IN (${ph}))`,
        ).run(...channelIds);
        this.db.prepare(`DELETE FROM telegram_out WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM telegram_topics WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM task_records WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM notification_subscriptions WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM threads WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM bot_events WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM reads WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM channel_members WHERE channel_id IN (${ph})`).run(...channelIds);
        for (const table of ["telegram_failures", "telegram_delivery_parts"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE seq IN (
            SELECT seq FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE project_id = ?)
          )`).run(project.id);
        }
        this.db.prepare(`DELETE FROM messages WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM channels WHERE id IN (${ph})`).run(...channelIds);
      }

      const scopedHolds = this.tableSql("telegram_hold").includes("project_id");
      if (scopedHolds) this.db.prepare("DELETE FROM telegram_hold WHERE project_id = ?").run(project.id);
      for (const chatId of chatIds) {
        if (!scopedHolds) this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
        this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
        if (this.tableSql("telegram_bot_state")) this.db.prepare("DELETE FROM telegram_bot_state WHERE key = ?").run(`mute:${chatId}`);
      }

      for (const agent of goneAgents) {
        this.db.prepare("DELETE FROM channel_members WHERE agent_id = ?").run(agent.id);
        this.db.prepare("DELETE FROM reads WHERE agent_id = ?").run(agent.id);
        this.db.prepare("DELETE FROM reactions WHERE agent_id = ?").run(agent.id);
        this.db.prepare("DELETE FROM attachments WHERE created_by = ? AND message_id IS NULL").run(agent.id);
        this.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
      }

      this.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* no open transaction */
      }
      throw err;
    }

    try {
      this.collectUnusedBlobs();
    } catch {
      /* sweep can drop leftover blobs later */
    }
    this.bus.emit("project", { deleted: project.slug });
  }

  private telegramHealthSignature = "";

  telegramOutboxHealth() {
    return {
      failures: this.telegramFailureCount(),
      diagnosticsPruned: Number((this.db.prepare("SELECT value FROM telegram_state WHERE key = 'outbox:diagnostics_pruned'").get() as { value: string } | undefined)?.value ?? 0),
    };
  }

  telegramPollHealth() {
    const bot = (this.db.prepare("SELECT value FROM telegram_state WHERE key = 'inbound:active_bot'").get() as { value: string } | undefined)?.value;
    const read = (key: string) => bot && this.tableSql("telegram_bot_state")
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

  telegramHealth() {
    const revision = Number((this.db.prepare("SELECT value FROM telegram_state WHERE key = 'health:revision'").get() as { value: string } | undefined)?.value ?? 0);
    return { ...this.telegramOutboxHealth(), ...this.telegramPollHealth(), revision };
  }

  publishTelegramHealth() {
    const health = this.telegramHealth();
    // Successful poll timestamps are stored, but do not broadcast an otherwise unchanged status.
    const { lastSuccessAt: _lastSuccessAt, revision: _revision, ...status } = health;
    const signature = JSON.stringify(status);
    if (signature === this.telegramHealthSignature) return;
    this.telegramHealthSignature = signature;
    const revision = health.revision + 1;
    this.db.prepare("INSERT INTO telegram_state(key, value) VALUES('health:revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(revision));
    this.bus.emit("telegram-health", { ...health, revision });
  }

  telegramQuarantine(limit = 50) { return telegramQuarantine(this.db, limit); }
  retryTelegramUpdate(id: string, matchesScope: (scope: TelegramUpdateScope) => boolean) {
    retryTelegramUpdate(this.db, id, matchesScope);
    this.bus.emit("telegram-inbox-wake");
    this.publishTelegramHealth();
  }
  discardTelegramUpdate(id: string) {
    discardTelegramUpdate(this.db, id);
    this.bus.emit("telegram-inbox-wake");
    this.publishTelegramHealth();
  }

  telegramFailureCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM telegram_failures WHERE resolved_at IS NULL").get() as { n: number }).n;
  }

  telegramFailures(limit = 50): Array<{
    id: string;
    seq: number;
    kind: string;
    telegramChatId: number | null;
    reason: string;
    attempts: number;
    createdAt: number;
  }> {
    const rows = this.db.prepare(
      `SELECT id, seq, kind, telegram_chat_id AS telegramChatId, reason, attempts, created_at AS createdAt
       FROM telegram_failures WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    ).all(Number.isSafeInteger(limit) ? Math.min(Math.max(1, limit), 200) : 50) as Array<{
      id: string;
      seq: number;
      kind: string;
      telegramChatId: number | null;
      reason: string;
      attempts: number;
      createdAt: number;
    }>;
    return rows;
  }

  retryTelegramFailure(id: string, destination: (seq: number) => TelegramDestination | undefined): void {
    retryTelegramOutboxFailure(this.db, id, destination);
    // Retry is durable before its dispatcher is woken.
    this.bus.emit("telegram-outbox-wake");
    this.publishTelegramHealth();
  }

  discardTelegramFailure(id: string): void {
    const changed = this.db.prepare(
      "UPDATE telegram_failures SET resolved_at = ?, resolution = 'discarded' WHERE id = ? AND resolved_at IS NULL",
    ).run(now(), id).changes;
    if (!changed) throw new HiveError(404, "Telegram failure not found");
    this.publishTelegramHealth();
  }

  forgetTelegramChat(chatId: number) {
    if (!Number.isFinite(chatId)) return;
    this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
    this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
        if (this.tableSql("telegram_bot_state")) this.db.prepare("DELETE FROM telegram_bot_state WHERE key = ?").run(`mute:${chatId}`);
  }

  private bootstrap() {
    const existing = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(HUMAN_ID);
    if (!existing) {
      const t = now();
      this.db.prepare(
        `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor)
         VALUES (?, ?, 'human', NULL, NULL, ?, 1, ?, ?, 0)`,
      ).run(HUMAN_ID, HUMAN_NAME, hashToken("human-local"), t, t);
    }

    const home = this.listProjects()[0];
    if (home) {
      this.ensureBuiltinChannel(home, "general", "public", "Town square");
      this.ensureBuiltinChannel(home, "brains", "brains", "Human and brains only");
    }
    this.addHumanToAllChannels();
  }

  private ensureBuiltinChannel(project: Project, name: string, type: ChannelType, topic: string) {
    const existing = this.db.prepare("SELECT * FROM channels WHERE project_id = ? AND lower(name) = ?").get(
      project.id,
      name,
    ) as ChannelRow | undefined;
    if (existing) {
      this.addMember(existing.id, HUMAN_ID);
      return;
    }
    const legacy = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(name) as ChannelRow | undefined;
    if (legacy && (!legacy.project_id || legacy.project_id === project.id)) {
      if (!legacy.project_id) {
        this.db.prepare("UPDATE channels SET project_id = ? WHERE id = ?").run(project.id, name);
      }
      this.addMember(name, HUMAN_ID);
      return;
    }
    const taken = this.db.prepare("SELECT id FROM channels WHERE id = ?").get(name);
    const id = taken ? `${project.id}:${name}` : name;
    this.db.prepare(
      `INSERT INTO channels (id, name, type, topic, created_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, type, topic, HUMAN_ID, now(), project.id);
    this.addMember(id, HUMAN_ID);
  }

  private addHumanToAllChannels() {
    const channels = this.db.prepare("SELECT id FROM channels WHERE type != 'dm'").all() as { id: string }[];
    for (const c of channels) this.addMember(c.id, HUMAN_ID);
  }

  addMember(channelId: string, agentId: string) {
    this.db.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, agent_id) VALUES (?, ?)`,
    ).run(channelId, agentId);
  }

  touch(agentId: string, online = true) {
    const current = this.db.prepare(
      "SELECT online, last_seen_at AS lastSeenAt FROM agents WHERE id = ?",
    ).get(agentId) as { online: number; lastSeenAt: number } | undefined;
    if (!current) return;
    const wanted = online ? 1 : 0;
    const at = now();
    const stateChanged = current.online !== wanted;
    const needsHeartbeatWrite = online && at - current.lastSeenAt >= 15_000;
    if (!stateChanged && !needsHeartbeatWrite) return;

    this.db.prepare(
      `UPDATE agents SET last_seen_at = ?, online = ? WHERE id = ?`,
    ).run(at, wanted, agentId);
    if (stateChanged) this.afterCommit(() => this.bus.emit("agent", this.getAgent(agentId)));
  }

  setOffline(agentId: string) {
    if (agentId === HUMAN_ID) return;
    this.touch(agentId, false);
  }

  removeAgent(actor: Agent, name: string): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can remove agents");
    const target = this.getAgentByName(name);
    if (!target) throw new HiveError(404, `No agent named ${name}`);
    if (target.id === HUMAN_ID || target.role === "human") {
      throw new HiveError(403, "Cannot remove Human");
    }
    const waiter = this.waiters.get(target.id);
    if (waiter) waiter.supersede();
    this.waiters.delete(target.id);
    this.db.prepare("DELETE FROM channel_members WHERE agent_id = ?").run(target.id);
    this.db.prepare("DELETE FROM reads WHERE agent_id = ?").run(target.id);
    this.db.prepare("DELETE FROM reactions WHERE agent_id = ?").run(target.id);
    this.db.prepare("DELETE FROM attachments WHERE created_by = ? AND message_id IS NULL").run(target.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(target.id);
    this.forgetIdentityFiles(target.name);
    if (target.projectId) {
      const general = this.db.prepare(
        "SELECT id FROM channels WHERE project_id = ? AND lower(name) = 'general'",
      ).get(target.projectId) as { id: string } | undefined;
      if (general) this.postSystem(general.id, `${actor.name} removed ${target.name} from the hive.`);
    }
    this.bus.emit("project", { removed: target.name });
    return target;
  }

  private forgetIdentityFiles(name: string) {
    const idFile = path.join(this.home, "identities", `${name}.json`);
    try {
      if (existsSync(idFile)) unlinkSync(idFile);
    } catch {
      /* leave the roster delete in place */
    }
    const last = path.join(this.home, "last-join.json");
    try {
      if (!existsSync(last)) return;
      const raw = JSON.parse(readFileSync(last, "utf8")) as { name?: string };
      if (raw.name && raw.name.toLowerCase() === name.toLowerCase()) unlinkSync(last);
    } catch {
      /* last-join is best-effort */
    }
  }

  getAgent(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) throw new HiveError(404, "Agent not found");
    return this.mapAgent(row);
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE lower(name) = lower(?)").get(name) as
      | AgentRow
      | undefined;
    return row ? this.mapAgent(row) : null;
  }

  agentByToken(token: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hashToken(token)) as
      | AgentRow
      | undefined;
    if (!row) throw new HiveError(401, "Invalid token");
    return this.mapAgent(row);
  }

  private agentFromRow(row: AgentRow, projectSlug: string | null): Agent {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      seniority: row.seniority,
      focus: row.focus,
      online: row.id === HUMAN_ID ? true : Boolean(row.online),
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      projectId: row.project_id,
      project: projectSlug,
    };
  }

  private mapAgent(row: AgentRow): Agent {
    const project = row.project_id
      ? this.db.prepare("SELECT slug FROM projects WHERE id = ?").get(row.project_id) as { slug: string } | undefined
      : undefined;
    return this.agentFromRow(row, project?.slug ?? null);
  }

  listAgents(viewer?: Agent): Agent[] {
    type Joined = AgentRow & { project_slug: string | null };
    const scoped = viewer && viewer.role !== "human";
    // Both OR arms have indexes. Without idx_agents_role SQLite scans all projects.
    const rows = this.db.prepare(`
      SELECT a.*, p.slug AS project_slug FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      ${scoped ? "WHERE a.role = 'human' OR a.project_id = ?" : ""}
      ORDER BY a.role, a.seniority, a.name
    `).all(...(scoped ? [viewer.projectId] : [])) as Joined[];
    return rows.map((row) => this.agentFromRow(row, row.project_slug));
  }

  private assertSameProject(agent: Agent, project: Project) {
    if (agent.role === "human") return;
    if (agent.project && agent.project !== project.slug) {
      throw new HiveError(409, `${agent.name} is in ${agent.project}; project cannot change`);
    }
  }

  join(input: {
    role: "brain" | "worker";
    seniority?: Seniority | null;
    focus?: string | null;
    token?: string | null;
    resumeName?: string | null;
    project?: string | null;
    cwd?: string | null;
  }): { agent: Agent; token: string; created: boolean } {
    validated(joinInputSchema, input);
    if (input.role !== "brain" && input.role !== "worker") {
      throw new HiveError(400, "role must be brain or worker");
    }
    if (input.token) {
      const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hashToken(input.token)) as
        | AgentRow
        | undefined;
      if (row) {
        const agent = this.mapAgent(row);
        if (input.resumeName && agent.name.toLowerCase() !== input.resumeName.toLowerCase()) {
          throw new HiveError(403, `Token is for ${agent.name}, not ${input.resumeName}`);
        }
        if (agent.role !== input.role) {
          throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
        }
        if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
          throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
        }
        if (input.project) this.assertSameProject(agent, this.getProjectBySlug(input.project));
        else if (input.cwd) {
          const cwd = canonicalWorktree(input.cwd);
          const worktree = this.listProjects().find(project => project.worktree && canonicalWorktree(project.worktree) === cwd);
          if (worktree) this.assertSameProject(agent, worktree);
        }
        this.touch(agent.id, true);
        return { agent, token: input.token, created: false };
      }
      throw new HiveError(401, "Invalid token. Lost credentials require Human-authorized recovery.");
    }

    if (input.resumeName) throw new HiveError(401, "Resume requires a valid token. Recover lost credentials through Human in the local UI.");

    if (input.role === "worker" && !input.seniority) {
      throw new HiveError(400, "Workers need --seniority junior|mid|senior");
    }
    if (input.role === "brain" && input.seniority) {
      throw new HiveError(400, "Brains have no seniority; only workers do");
    }

    const project = resolveJoinProject(this.listProjects(), { project: input.project, cwd: input.cwd });
    return this.transaction(() => {
      const taken = new Set(
        (this.db.prepare("SELECT lower(name) AS n FROM agents").all() as { n: string }[]).map((r) => r.n),
      );
      const name = pickName(input.role, taken);
      const id = crypto.randomUUID();
      const token = newToken();
      const t = now();
      this.db.prepare(
        `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor, project_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)`,
      ).run(
        id,
        name,
        input.role,
        input.role === "worker" ? (input.seniority ?? null) : null,
        input.focus ?? null,
        hashToken(token),
        t,
        t,
        project.id,
      );

      for (const ch of this.db.prepare("SELECT id, type FROM channels WHERE project_id = ?").all(project.id) as {
        id: string;
        type: ChannelType;
      }[]) {
        if (ch.type === "public") this.addMember(ch.id, id);
        if (ch.type === "brains" && input.role === "brain") this.addMember(ch.id, id);
      }

      const agent = this.getAgent(id);
      const general = this.db.prepare(
        "SELECT id FROM channels WHERE project_id = ? AND lower(name) = 'general'",
      ).get(project.id) as { id: string } | undefined;
      if (general) {
        this.postMessage(this.getAgent(HUMAN_ID), { channel: general.id, body: `${agent.name} has joined as ${describeAgent(agent)}.`, kind: "system" });
      }
      const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get() as { n: number };
      this.db.prepare("UPDATE agents SET inbox_cursor = ? WHERE id = ?").run(maxSeq.n, id);
      this.afterCommit(() => this.bus.emit("agent", agent));
      return { agent: this.getAgent(id), token, created: true };
    });
  }

  agentCredential(actor: Agent, projectRef: string, agentId: string) {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can recover agent credentials");
    const project = this.requireActorProject(actor, projectRef), agent = this.getAgent(agentId);
    if (!["brain", "worker"].includes(agent.role) || agent.projectId !== project.id) throw new HiveError(404, "Agent not found in this project");
    const row = this.db.prepare("SELECT revision, revoked FROM agent_credentials WHERE agent_id=?").get(agent.id);
    return { agent, credential: { revision: row ? Number(row.revision) : 1, revoked: Boolean(row?.revoked) } };
  }

  changeAgentCredential(actor: Agent, projectRef: string, agentId: string, raw: unknown) {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can recover agent credentials");
    const parsed = botCredentialSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Expected rotate/revoke and positive expectedRevision");
    return this.transaction(() => {
      const current = this.agentCredential(actor, projectRef, agentId);
      if (current.credential.revision !== parsed.data.expectedRevision) throw new HiveError(409, "Credential changed; reload before retrying");
      const revoked = parsed.data.action === "revoke", revision = current.credential.revision + 1;
      const token = revoked ? undefined : newToken();
      this.db.prepare("UPDATE agents SET token_hash=? WHERE id=?").run(token ? hashToken(token) : "", agentId);
      this.db.prepare(`INSERT INTO agent_credentials(agent_id,revision,revoked) VALUES(?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision,revoked=excluded.revoked`).run(agentId, revision, Number(revoked));
      // Fence pending authenticated waits and old receipts in the SAME commit.
      // Do not call the inbox store's top-level transaction from this transaction.
      this.db.prepare(`INSERT INTO inbox_sessions(agent_id,session_id,generation)
        SELECT ?,?,COALESCE(MAX(generation),0)+1 FROM inbox_sessions WHERE agent_id=?`).run(agentId, crypto.randomUUID(), agentId);
      this.afterCommit(() => this.waiters.get(agentId)?.supersede());
      return { agent: current.agent, credential: { revision, revoked }, ...(token ? { token } : {}) };
    });
  }

  /** Constant-parameter authorization scope, shared by lists and inbox reads. */
  private visibleChannelScope(actor: Agent): { sql: string; args: SQLInputValue[] } {
    if (actor.role === "human") return { sql: "SELECT id FROM channels", args: [] };
    return {
      sql: `SELECT c.id FROM channel_members mine
            JOIN channels c ON c.id = mine.channel_id
            WHERE mine.agent_id = ? AND c.project_id = ?
              AND (c.type != 'brains' OR ? = 'brain')`,
      args: [actor.id, actor.projectId, actor.role],
    };
  }

  listChannels(actor: Agent): Channel[] {
    const scope = this.visibleChannelScope(actor);
    type Joined = ChannelRow & { project_slug: string | null };
    const rows = this.db.prepare(`
      SELECT c.*, p.slug AS project_slug FROM channels c
      LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.id IN (${scope.sql}) ORDER BY c.type, c.name
    `).all(...scope.args) as Joined[];
    if (rows.length === 0) return [];
    // A relational subquery avoids both N+1 and an IN placeholder per channel.
    const memberships = this.db.prepare(`
      SELECT channel_id, agent_id FROM channel_members
      WHERE channel_id IN (${scope.sql}) ORDER BY channel_id, agent_id
    `).all(...scope.args) as Array<{ channel_id: string; agent_id: string }>;
    const members = new Map<string, string[]>();
    for (const row of memberships) {
      const ids = members.get(row.channel_id) ?? [];
      ids.push(row.agent_id);
      members.set(row.channel_id, ids);
    }
    return rows.map((row) => ({
      id: row.id, name: row.name, type: row.type, topic: row.topic,
      createdBy: row.created_by, createdAt: row.created_at,
      memberIds: members.get(row.id) ?? [], projectId: row.project_id,
      project: row.project_slug ?? DEFAULT_PROJECT_SLUG,
    }));
  }

  getChannel(idOrName: string, projectId?: string | null): Channel {
    if (projectId) {
      const scoped = this.db.prepare(
        `SELECT * FROM channels WHERE project_id = ? AND (id = ? OR lower(name) = lower(?))`,
      ).get(projectId, idOrName, idOrName) as ChannelRow | undefined;
      if (!scoped) throw new HiveError(404, "Channel not found");
      return this.mapChannel(scoped);
    }
    const byId = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(idOrName) as ChannelRow | undefined;
    if (byId) return this.mapChannel(byId);
    const rows = this.db.prepare("SELECT * FROM channels WHERE lower(name) = lower(?)").all(idOrName) as ChannelRow[];
    if (rows.length === 1) return this.mapChannel(rows[0]!);
    throw new HiveError(404, "Channel not found");
  }

  private mapChannel(row: ChannelRow): Channel {
    const members = this.db.prepare(
      "SELECT agent_id FROM channel_members WHERE channel_id = ?",
    ).all(row.id) as { agent_id: string }[];
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(row.project_id) as
      | ProjectRow
      | undefined;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      topic: row.topic,
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberIds: members.map((m) => m.agent_id),
      projectId: row.project_id,
      project: project?.slug ?? DEFAULT_PROJECT_SLUG,
    };
  }

  canSeeChannel(actor: Agent, ch: Channel): boolean {
    if (actor.role === "human") return true;
    if (!actor.projectId || actor.projectId !== ch.projectId) return false;
    if (ch.type === "brains" && actor.role !== "brain") return false;
    return ch.memberIds.includes(actor.id);
  }

  canPost(actor: Agent, ch: Channel): boolean {
    if (actor.role === "bot") return false; // Bots use the observation-only ingress.
    if (actor.role === "human") return true;
    if (!actor.projectId || actor.projectId !== ch.projectId) return false;
    if (ch.type === "brains") return actor.role === "brain";
    if (ch.type === "dm") return ch.memberIds.includes(actor.id);
    if (ch.type === "public") return true;
    return ch.memberIds.includes(actor.id);
  }

  createChannel(
    actor: Agent,
    input: {
      name: string;
      type: "public" | "brains" | "private";
      topic?: string;
      memberNames?: string[];
      project?: string | null;
    },
  ): Channel {
    validated(channelInputSchema, input);
    if (actor.role === "worker" || actor.role === "bot") throw new HiveError(403, "Workers and bots cannot create channels");
    if (input.type !== "public" && input.type !== "private" && input.type !== "brains") {
      throw new HiveError(400, "Channel type must be public, private, or brains");
    }
    if (input.type === "brains" && actor.role !== "human") {
      throw new HiveError(403, "Only Human can create brains channels");
    }
    const project = this.requireActorProject(actor, input.project);
    const slug = slugify(input.name);
    if (!slug) throw new HiveError(400, "Invalid channel name");
    return this.transaction(() => {
      const exists = this.db.prepare(
        "SELECT id FROM channels WHERE project_id = ? AND lower(name) = ?",
      ).get(project.id, slug);
      if (exists) throw new HiveError(409, `#${slug} already exists`);
      const id = crypto.randomUUID();
      this.db.prepare(
        `INSERT INTO channels (id, name, type, topic, created_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, slug, input.type, input.topic ?? null, actor.id, now(), project.id);
      this.addMember(id, HUMAN_ID);
      const roster = this.listAgents().filter((a) => a.role === "human" || a.projectId === project.id);
      if (input.type === "public") {
        for (const a of roster) {
          if (a.role !== "human" && a.role !== "bot") this.addMember(id, a.id);
        }
      } else if (input.type === "brains") {
        for (const a of roster) {
          if (a.role === "brain") this.addMember(id, a.id);
        }
      } else {
        this.addMember(id, actor.id);
        for (const name of input.memberNames ?? []) {
          const m = this.getAgentByName(name);
          if (m && (m.role === "human" || m.projectId === project.id)) this.addMember(id, m.id);
        }
      }
      const ch = this.getChannel(id);
      this.afterCommit(() => this.bus.emit("channel", ch));
      this.postMessage(this.getAgent(HUMAN_ID), { channel: id, body: `${actor.name} created #${slug}`, kind: "system" });
      return this.getChannel(id);
    });
  }

  openDm(actor: Agent, otherName: string, silent = false): Channel {
    const other = this.getAgentByName(otherName);
    if (!other) throw new HiveError(404, `No agent named ${otherName}`);
    if (actor.role === "bot" || other.role === "bot") throw new HiveError(403, "Bots publish observations to explicitly linked channels, not DMs");
    if (other.id === actor.id) throw new HiveError(400, "Cannot DM yourself");
    if (actor.role !== "human" && other.role !== "human" && actor.projectId !== other.projectId) {
      throw new HiveError(403, `${other.name} is not in your project`);
    }
    if (actor.role === "worker" && other.role === "human") {
      const existing = this.findDm(actor.id, other.id);
      if (existing) return existing;
      throw new HiveError(403, "Workers cannot open a DM with Human. Ask a brain.");
    }
    if (actor.role === "worker" && other.role === "worker") {
      throw new HiveError(403, "Workers cannot DM other workers. Talk to a brain.");
    }
    const create = () => {
      const found = this.findDm(actor.id, other.id);
      if (found) return found;
      const projectId = actor.role === "human" ? other.projectId : actor.projectId;
      if (!projectId) throw new HiveError(400, "DM needs a project");
      const [a, b] = [actor.id, other.id].sort();
      const id = `dm:${a}:${b}`;
      this.db.prepare(
        `INSERT INTO channels (id, name, type, topic, created_by, created_at, project_id) VALUES (?, ?, 'dm', NULL, ?, ?, ?)`,
      ).run(id, dmLabel(actor, other), actor.id, now(), projectId);
      this.addMember(id, actor.id);
      this.addMember(id, other.id);
      const ch = this.getChannel(id);
      if (!silent) this.afterCommit(() => this.bus.emit("channel", ch));
      return ch;
    };
    // TaskStore owns the surrounding transaction when silent is requested.
    return silent ? create() : this.transaction(create);
  }

  findDm(a: string, b: string): Channel | null {
    const [x, y] = [a, b].sort();
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(`dm:${x}:${y}`) as
      | ChannelRow
      | undefined;
    return row ? this.mapChannel(row) : null;
  }

  /** Human creates a project identity with no channel memberships. Token is returned once. */
  createBot(actor: Agent, projectRef: string, raw: unknown): { bot: Agent; token: string } {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can create bots");
    const project = this.requireActorProject(actor, projectRef);
    const parsed = createBotSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Bot name must be 1–40 letters, digits, underscores or dashes, starting with a letter");
    const { name } = parsed.data;
    if (this.getAgentByName(name)) throw new HiveError(409, "This identity name is already in use");
    const id = crypto.randomUUID();
    const token = newToken();
    const t = now();
    this.db.prepare(`INSERT INTO agents
      (id, name, role, token_hash, online, last_seen_at, created_at, project_id)
      VALUES (?, ?, 'bot', ?, 0, ?, ?, ?)`).run(id, name, hashToken(token), t, t, project.id);
    const bot = this.getAgent(id);
    this.bus.emit("agent", bot);
    return { bot, token };
  }

  botCredential(actor: Agent, projectRef: string, botId: string): BotCredentialView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const project = this.requireActorProject(actor, projectRef), bot = this.getAgent(botId);
    if (bot.role !== 'bot' || bot.projectId !== project.id) throw new HiveError(404, 'Bot not found in this project');
    const row = this.db.prepare('SELECT revision, revoked FROM bot_credentials WHERE bot_id=?').get(bot.id);
    return { bot, credential: { revision: row ? Number(row.revision) : 1, revoked: Boolean(row?.revoked) } };
  }

  changeBotCredential(actor: Agent, projectRef: string, botId: string, raw: unknown): BotCredentialView & { token?: string } {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human can manage bot credentials');
    const parsed = botCredentialSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid credential operation: choose rotate/revoke and a positive expectedRevision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.botCredential(actor, projectRef, botId);
      if (current.credential.revision !== parsed.data.expectedRevision)
        throw new HiveError(409, 'Bot credential changed; reload its state before a new operation');
      const revoked = parsed.data.action === 'revoke', revision = current.credential.revision + 1;
      const token = revoked ? undefined : newToken();
      // No possible SHA-256 token hash equals the empty revocation sentinel.
      this.db.prepare('UPDATE agents SET token_hash=? WHERE id=?').run(token ? hashToken(token) : '', botId);
      this.db.prepare(`INSERT INTO bot_credentials(bot_id,revision,revoked) VALUES(?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision, revoked=excluded.revoked`).run(botId, revision, Number(revoked));
      this.db.exec('COMMIT');
      return { bot: current.bot, credential: { revision, revoked }, ...(token ? { token } : {}) };
    } catch (error) {
      // isTransaction was added after our minimum supported Node 22.13.0.
      // BEGIN succeeded before entering this try; SQLite can also auto-rollback.
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  postBotMessage(actor: Agent, channel: string, raw: unknown): { message: Message; duplicate: boolean } {
    if (actor.role !== "bot") throw new HiveError(403, "A bot identity is required");
    const parsed = botMessageSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const input = parsed.data;
    const ch = this.getChannel(channel, actor.projectId);
    if (!this.canSeeChannel(actor, ch) || (ch.type !== "public" && ch.type !== "private")) {
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
    const { messageId, duplicate } = immediateTransaction(this.db, () => {
      const previous = this.db.prepare(`SELECT message_id, payload_hash FROM bot_events
        WHERE bot_id = ? AND channel_id = ? AND thread_id = ? AND event_id = ?`)
        .get(actor.id, ch.id, input.threadId ?? "", input.eventId) as { message_id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new HiveError(409, "Event ID already used with different content; use a new revision/event ID");
        return { messageId: previous.message_id, duplicate: true };
      }
      if (this.rooms.peek(ch.id)?.state === 'archived') throw new HiveError(409, 'Channel is archived; suspend this source link. Do not discard undelivered source events.');
      this.validateAttachments(actor, input.attachmentIds);
      const messageId = crypto.randomUUID();
      this.db.prepare(`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, mentions, created_at, event_type)
        VALUES (?, ?, ?, ?, ?, 'chat', '[]', ?, ?)`)
        .run(messageId, ch.id, input.threadId ?? null, actor.id, input.body, now(), input.eventType ?? null);
      this.db.prepare(`INSERT INTO bot_events (message_id, bot_id, channel_id, thread_id, event_id, metadata, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, actor.id, ch.id, input.threadId ?? "", input.eventId, JSON.stringify(event), payloadHash);
      this.timeline.recordMessage(messageId, { source: 'bot' });
      this.bindAttachments(messageId, input.attachmentIds);
      if (input.threadId) this.db.prepare("INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')")
        .run(input.threadId, ch.id);
      return { messageId, duplicate: false };
    });
    const message = this.getMessageById(messageId);
    if (!duplicate) {
      this.bus.emit("message", message);
      this.wakeMembers(ch, message);
    }
    return { message, duplicate };
  }

  postMessage(
    actor: Agent,
    input: {
      channel: string;
      body: string;
      requestId?: string;
      threadId?: string | null;
      kind?: Message["kind"];
      eventType?: Message["eventType"];
      control?: ControlAction | null;
      source?: "hive" | "telegram";
      traceId?: string;
      causeMessageId?: string;
      attachmentIds?: string[];
      recipients?: string[];
    },
    persistReceipt?: (message: Message) => void,
  ): Message {
    if (input.attachmentIds !== undefined) validated(attachmentIdsSchema, input.attachmentIds);
    const decisionRecipients = actor.role === 'human' ? this.decisions?.replyRecipientNames(input.threadId ?? null) ?? [] : [];
    const recipientNames = [...new Set([...(input.recipients ?? []), ...decisionRecipients])];
    if (recipientNames.length) validated(memberNamesSchema.min(1), recipientNames);
    if (input.eventType !== undefined && !MESSAGE_EVENT_TYPES.includes(input.eventType))
      throw new HiveError(400, "Unknown message eventType");
    const ch = this.getChannel(input.channel, actor.projectId);
    if (!this.canSeeChannel(actor, ch) || !this.canPost(actor, ch)) {
      throw new HiveError(403, `You cannot post to ${channelLabel(ch)}`);
    }
    if (actor.role !== 'human' && this.rooms.peek(ch.id)?.state === 'archived' &&
      (!input.threadId || !this.tasks.has(input.threadId)))
      throw new HiveError(409, 'Archived room: no new work or root messages; use an existing task thread for closure');
    if (recipientNames.length > 32 || recipientNames.some(name => typeof name !== 'string')) throw new HiveError(400, 'Provide 1–32 recipient names');
    const recipients = [...new Set(recipientNames.map(name => {
      const target = this.getAgentByName(name);
      if (!target || target.role === 'bot' || !this.canSeeChannel(target, ch) ||
        (actor.role === 'worker' && target.role === 'human')) throw new HiveError(403, 'Recipient must be an accessible permitted person');
      return target.id;
    }))];
    if (typeof input.body !== "string") throw new HiveError(400, "Expected a string body");
    const body = input.body.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > FILES_PER_MESSAGE) {
      throw new HiveError(400, `At most ${FILES_PER_MESSAGE} files per message`);
    }
    if (!body && input.kind !== "control" && attachmentIds.length === 0) {
      throw new HiveError(400, "Empty message");
    }
    if (input.kind !== "control" && body.length > BODY_MAX) {
      throw new HiveError(400, `Message too long (${body.length} > ${BODY_MAX}). Split or use a thread.`);
    }
    const mentions = parseMentions(body, this.listAgents(actor));
    if (actor.role === "worker" && mentions.some((id) => id === HUMAN_ID)) {
      throw new HiveError(403, "Workers cannot mention @Human. Ask a brain.");
    }
    if (input.threadId) {
      const root = this.db.prepare("SELECT id, channel_id FROM messages WHERE id = ?").get(input.threadId) as
        | { id: string; channel_id: string }
        | undefined;
      if (!root || root.channel_id !== ch.id) throw new HiveError(400, "Thread not in this channel");
    }
    const trace = this.timeline.prepare(actor, ch, { traceId: input.traceId, causeMessageId: input.causeMessageId }, input.threadId ?? null);
    const id = crypto.randomUUID();
    const t = now();
    const kind = input.kind ?? "chat";
    if (kind === "system" && actor.role !== "human") {
      throw new HiveError(403, "Only Human can post system messages");
    }
    if (kind === "control") {
      if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can send control");
      if (input.control && input.control !== "clear_context") {
        throw new HiveError(400, "Unknown control action");
      }
    }

    // Validate the complete attachment set before any mutation. The transaction
    // below then owns every remaining database write caused by the send.
    return this.transaction(() => {
      if (input.requestId !== undefined) return this.sendRequests.run(actor.id, ch.projectId, input.requestId,
        [ch.id, body, input.threadId ?? null, kind, input.control ?? null, input.source ?? "hive",
          input.eventType ?? null, attachmentIds, [...recipients].sort(), trace.traceId, trace.causeMessageId],
        () => this.postMessage(actor, { ...input, requestId: undefined }, persistReceipt), id => this.getMessageById(id));
      if (attachmentIds.length) this.validateAttachments(actor, attachmentIds);
      if (actor.role === "human" && !ch.memberIds.includes(actor.id)) {
        this.addMember(ch.id, actor.id);
        ch.memberIds.push(actor.id);
      }
      this.db.prepare(
        `INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at, event_type, recipients)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ch.id, input.threadId ?? null, actor.id, body, kind,
        input.control ?? null, JSON.stringify(mentions), t, input.eventType ?? null, JSON.stringify(recipients));
      this.timeline.recordMessage(id, { source: input.source ?? 'hive', traceId: trace.traceId, causeMessageId: trace.causeMessageId });
      if (input.threadId) {
        this.db.prepare(
          `INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')`,
        ).run(input.threadId, ch.id);
      }
      if (attachmentIds.length) this.bindAttachments(id, attachmentIds);
      // Transport receipts participate in the same message/attachment transaction.
      persistReceipt?.(this.getMessageById(id));
      this.touch(actor.id, true);
      const msg = this.getMessageById(id);
      const decision = actor.role === 'human' ? this.decisions?.captureHumanReply(actor, msg, input.source ?? 'hive') ?? null : null;
      this.afterCommit(() => {
        if (input.source === "telegram") this.telegramOrigin.add(msg.id);
        this.adaptiveTopology?.humanMessageCommitted(msg);
        this.bus.emit("message", msg);
        this.wakeMembers(ch, msg);
        if (decision) this.bus.emit('decision', decision);
      });
      return msg;
    });
  }

  hasActiveSendRequest(actor: Agent, channelRef: string, requestId: string | undefined): boolean {
    if (!requestId) return false;
    const channel = this.getChannel(channelRef, actor.projectId);
    const row = this.db.prepare(`SELECT 1 AS found FROM send_requests
      WHERE actor_id=? AND project_id=? AND request_id=? AND expires_at>?`)
      .get(actor.id, channel.projectId, requestId, Date.now()) as { found: number } | undefined;
    return Boolean(row?.found);
  }

  postAdaptiveRequest(
    actor: Agent,
    input: {
      channel: string;
      body: string;
      requestId?: string;
      threadId?: string | null;
      eventType?: Message["eventType"];
      traceId?: string;
      causeMessageId?: string;
      attachmentIds?: string[];
      recipients?: string[];
      source?: "hive" | "telegram";
    },
    directives: Array<{ body: string; requestId: string; recipients?: string[] }>,
    persistReceipt?: (message: Message) => void,
    persistRouting?: (message: Message) => void,
  ): { message: Message; routingMessages: Message[] } {
    return this.transaction(() => {
      // One directive per owning brain, in the request's thread, immediately before the request.
      const routingMessages = directives.map(directive => this.postMessage(actor, {
        channel: input.channel,
        body: directive.body,
        requestId: directive.requestId,
        threadId: input.threadId ?? null,
        recipients: directive.recipients,
        eventType: "assignment",
      }));
      const message = this.postMessage(actor, input, persistReceipt);
      persistRouting?.(message);
      return { message, routingMessages };
    });
  }

  fromTelegram(messageId: string): boolean {
    return this.telegramOrigin.has(messageId) || this.timeline.source(messageId) === 'telegram';
  }

  postSystem(channelId: string, body: string) {
    const human = this.getAgent(HUMAN_ID);
    try {
      this.postMessage(human, { channel: channelId, body, kind: "system" });
    } catch {
      // bootstrap edge
    }
  }

  getVisibleMessage(actor: Agent, seq: number): Message {
    const msg = this.getMessageBySeq(seq);
    const ch = this.getChannel(msg.channelId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this message");
    return this.decorate([msg], actor.id)[0]!;
  }

  getMessageBySeq(seq: number): Message {
    const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE seq = ?").get(seq) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  getMessageById(id: string): Message {
    const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  private mapMessages(rows: MessageRow[]): Message[] {
    type Author = { id: string; name: string; role: Role };
    const authors = new Map<string, Author>();
    const botEvents = new Map<string, BotEvent>();
    const taskEvents = new Map<string, TaskEnvelope>();
    const sources = new Map<string, Message["source"]>();
    for (const ids of batches(rows.map(row => row.id))) {
      const found = this.db.prepare(`SELECT message_id, envelope FROM task_events WHERE message_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ message_id: string; envelope: string }>;
      for (const event of found) taskEvents.set(event.message_id, JSON.parse(event.envelope) as TaskEnvelope);
    }
    for (const ids of batches(rows.map(row => row.id))) {
      const found = this.db.prepare(`SELECT message_id, source FROM message_provenance WHERE message_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ message_id: string; source: "hive" | "telegram" | "bot" }>;
      for (const item of found) if (item.source !== "hive") sources.set(item.message_id, item.source);
    }
    for (const ids of batches([...new Set(rows.map((row) => row.author_id))])) {
      const found = this.db.prepare(
        `SELECT id, name, role FROM agents WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as Author[];
      for (const author of found) authors.set(author.id, author);
    }
    const botMessageIds = [...new Set(
      rows.filter((row) => authors.get(row.author_id)?.role === "bot").map((row) => row.id),
    )];
    for (const ids of batches(botMessageIds)) {
      const found = this.db.prepare(
        `SELECT message_id, metadata FROM bot_events WHERE message_id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as Array<{ message_id: string; metadata: string }>;
      for (const event of found) botEvents.set(event.message_id, JSON.parse(event.metadata) as BotEvent);
    }
    return rows.map((row) => ({
      id: row.id, seq: row.seq, channelId: row.channel_id, threadId: row.thread_id,
      authorId: row.author_id,
      authorName: authors.get(row.author_id)?.name ?? "unknown",
      authorRole: authors.get(row.author_id)?.role ?? "worker",
      // Read message bodies through a BLOB projection: older Node SQLite TEXT
      // conversion truncates at embedded NUL even though the stored value is intact.
      body: typeof row.body === "string" ? row.body : Buffer.from(row.body).toString("utf8"),
      kind: row.kind, control: row.control,
      ...(row.event_type ? { eventType: row.event_type } : {}),
      mentions: JSON.parse(row.mentions) as string[], createdAt: row.created_at,
      ...(row.recipients && row.recipients !== '[]' ? { recipientIds: JSON.parse(row.recipients) as string[] } : {}),
      ...(taskEvents.has(row.id) ? { taskEvent: taskEvents.get(row.id)! } : {}),
      ...(sources.has(row.id) ? { source: sources.get(row.id)! } : {}),
      ...(botEvents.has(row.id) ? { source: "bot" as const, botEvent: botEvents.get(row.id)! } : {}),
    }));
  }

  private mapMessage(row: MessageRow): Message {
    return this.mapMessages([row])[0]!;
  }

  /** Expand an immutable set of digest IDs; this never reads or mutates receipt state. */
  expandDigest(actor: Agent, raw: unknown): DigestExpansionResult {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents expand inbox digests");
    const parsed = digestExpansionSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, "Invalid digest reference: " + parsed.error.issues.map(i => i.message).join("; "));
    const { channel, messageIds, afterSeq = 0 } = parsed.data;
    const ch = this.getChannel(channel, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    const headers = this.db.prepare(`SELECT id, seq, channel_id, length(CAST(body AS BLOB)) AS body_bytes,
      COALESCE((SELECT length(CAST(metadata AS BLOB)) FROM bot_events WHERE message_id = messages.id), 0) +
      COALESCE((SELECT length(CAST(envelope AS BLOB)) FROM task_events WHERE message_id = messages.id), 0) AS metadata_bytes FROM messages
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(JSON.stringify(messageIds)) as
        { id: string; seq: number; channel_id: string; body_bytes: number; metadata_bytes: number }[];
    // Validate the entire selection before emitting any content, including past pages.
    if (headers.length !== messageIds.length || headers.some(m => m.channel_id !== ch.id))
      throw new HiveError(404, "Digest messages are missing or outside this channel");
    if (afterSeq !== 0 && !headers.some(m => m.seq === afterSeq))
      throw new HiveError(400, "afterSeq must be a sequence from this digest");
    const pending = headers.filter(m => m.seq > afterSeq);
    const messages: Message[] = [];
    const result = (items: Message[]): DigestExpansionResult => ({ messages: items,
      hasMore: items.length < pending.length,
      nextAfterSeq: items.length < pending.length ? items.at(-1)!.seq : null });
    for (const header of pending) {
      // No reaction rosters or file bytes; hydrate one selected original at a time.
      // Legacy oversized originals are rejected before loading their content.
      const tooLarge = () => new HiveError(413, "Original exceeds expansion byte limit. Use history with " +
        JSON.stringify({ channel: ch.id, threadId: header.id, since: header.seq - 1, limit: 1, meta: false }));
      if (header.body_bytes + header.metadata_bytes > WAIT_MAX_BYTES) {
        if (!messages.length) throw tooLarge();
        break;
      }
      const row = this.db.prepare("SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ?").get(header.id) as MessageRow;
      const message = this.mapMessage(row);
      message.attachments = this.db.prepare("SELECT id, name, mime, bytes FROM attachments WHERE message_id = ? ORDER BY id LIMIT ?")
        .all(header.id, FILES_PER_MESSAGE) as AttachmentMeta[];
      const candidate = result([...messages, message]);
      const pretty = JSON.stringify(candidate, null, 2);
      const bytes = Math.max(Buffer.byteLength(pretty),
        Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: pretty }] })));
      if (bytes > WAIT_MAX_BYTES) {
        if (!messages.length) throw tooLarge();
        break;
      }
      messages.push(message);
      if (messages.length === 8) break;
    }
    return result(messages);
  }

  listMessages(
    actor: Agent,
    channelRef: string,
    opts: { threadId?: string | null; afterSeq?: number; beforeSeq?: number; limit?: number } = {},
  ): { messages: Message[]; hasOlder: boolean; hasNewer: boolean; cursors: { before?: number; after?: number } } {
    const ch = this.getChannel(channelRef, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    for (const [name, value] of [["afterSeq", opts.afterSeq], ["beforeSeq", opts.beforeSeq]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new HiveError(400, `${name} must be a nonnegative safe integer`);
      }
    }
    if (opts.afterSeq !== undefined && opts.beforeSeq !== undefined) {
      throw new HiveError(400, "Use either afterSeq or beforeSeq, not both");
    }
    if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
      throw new HiveError(400, "limit must be a positive safe integer");
    }
    const limit = Math.min(opts.limit ?? 80, 200);
    // Root-channel reads default to latest-N. Explicit forward cursors and a
    // thread's default opening page are oldest-first.
    const ascending = opts.beforeSeq === undefined && (opts.afterSeq !== undefined || Boolean(opts.threadId));
    const op = ascending ? ">" : "<";
    const order = ascending ? "ASC" : "DESC";
    const boundary = ascending ? (opts.afterSeq ?? 0) : (opts.beforeSeq ?? Number.MAX_SAFE_INTEGER);
    let rows: MessageRow[];

    if (opts.threadId) {
      // Keep the root PK lookup separate from the indexed reply range. An OR
      // over id/thread_id can otherwise scan unrelated channel history.
      const root = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id = ? AND channel_id = ? AND seq ${op} ?`,
      ).get(opts.threadId, ch.id, boundary) as MessageRow | undefined;
      const replies = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE channel_id = ? AND thread_id = ? AND seq ${op} ?
         ORDER BY seq ${order} LIMIT ?`,
      ).all(ch.id, opts.threadId, boundary, limit) as MessageRow[];
      rows = [...(root ? [root] : []), ...replies]
        .sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq))
        .slice(0, limit);
    } else {
      rows = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE channel_id = ? AND thread_id IS NULL AND seq ${op} ?
         ORDER BY seq ${order} LIMIT ?`,
      ).all(ch.id, boundary, limit) as MessageRow[];
    }

    if (!ascending) rows.reverse();
    const messages = this.decorate(this.mapMessages(rows), actor.id);
    const existsBeyond = (operator: "<" | ">", seq: number): boolean => {
      if (opts.threadId) {
        return Boolean(this.db.prepare(
          `SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND seq ${operator} ? LIMIT 1`,
        ).get(opts.threadId, ch.id, seq)) || Boolean(this.db.prepare(
          `SELECT 1 FROM messages WHERE channel_id = ? AND thread_id = ? AND seq ${operator} ? LIMIT 1`,
        ).get(ch.id, opts.threadId, seq));
      }
      return Boolean(this.db.prepare(
        `SELECT 1 FROM messages WHERE channel_id = ? AND thread_id IS NULL AND seq ${operator} ? LIMIT 1`,
      ).get(ch.id, seq));
    };
    const oldest = messages[0]?.seq;
    const newest = messages.at(-1)?.seq;
    const hasOlder = oldest !== undefined && existsBeyond("<", oldest);
    const hasNewer = newest !== undefined && existsBeyond(">", newest);
    return {
      messages,
      hasOlder,
      hasNewer,
      cursors: {
        before: hasOlder ? oldest : undefined,
        after: hasNewer ? newest : undefined,
      },
    };
  }

  searchMessages(
    actor: Agent,
    input: { q: string; project?: string | null; channel?: string | null; beforeSeq?: number; limit?: number },
  ): { hits: SearchHit[]; hasMore: boolean } {
    if (input.beforeSeq !== undefined) validated(cursorSchema, input.beforeSeq);
    if (input.limit !== undefined) validated(limitSchema, input.limit);
    const tokens = parseSearchQuery(input.q ?? "");
    if (tokens.length === 0) throw new HiveError(400, "Search needs a query");
    const project = this.searchProject(actor, input.project);
    let rooms = this.listChannels(actor).filter((ch) => ch.projectId === project.id);
    if (input.channel) {
      const ch = this.getChannel(input.channel, project.id);
      if (!this.canSeeChannel(actor, ch) || ch.projectId !== project.id) {
        throw new HiveError(403, "Cannot search this channel");
      }
      rooms = [ch];
    }
    if (rooms.length === 0) return { hits: [], hasMore: false };
    const limit = clampSearchLimit(input.limit);
    const before =
      Number.isFinite(input.beforeSeq) && Number(input.beforeSeq) > 0
        ? Number(input.beforeSeq)
        : Number.MAX_SAFE_INTEGER;
    const roomScope = input.channel
      ? { sql: "SELECT id FROM channels WHERE id = ?", args: [rooms[0]!.id] }
      : this.visibleChannelScope(actor);
    const params: SQLInputValue[] = [project.id, ...roomScope.args, before];
    const tokenSql = tokens.map((token) => {
      const like = likeNeedle(token);
      params.push(like, like, like, like, like, like);
      let extra = "";
      if (/^\d+$/.test(token)) {
        extra = " OR m.seq = ?";
        params.push(Number(token));
      }
      return `(
        m.body LIKE ? ESCAPE '\\'
        OR a.name LIKE ? ESCAPE '\\'
        OR c.name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM attachments att WHERE att.message_id = m.id AND att.name LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id AND r.emoji LIKE ? ESCAPE '\\')
        OR EXISTS (
          SELECT 1 FROM agents ma
          WHERE instr(m.mentions, ma.id) > 0 AND ma.name LIKE ? ESCAPE '\\'
        )
        ${extra}
      )`;
    });
    params.push(limit + 1);
    const rows = this.db.prepare(
      `SELECT m.id
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN agents a ON a.id = m.author_id
       WHERE c.project_id = ?
         AND c.id IN (${roomScope.sql})
         AND m.seq < ?
         AND ${tokenSql.join(" AND ")}
       ORDER BY m.seq DESC
       LIMIT ?`,
    ).all(...params) as { id: string }[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const messages = this.loadMessagesByIds(
      page.map((row) => row.id),
      actor.id,
    );
    const byId = new Map(rooms.map((ch) => [ch.id, ch]));
    return {
      hasMore,
      hits: messages.map((msg) => {
        const ch = byId.get(msg.channelId) ?? this.getChannel(msg.channelId);
        return {
          seq: msg.seq,
          channelId: msg.channelId,
          channelName: ch.name,
          channelType: ch.type,
          threadId: msg.threadId,
          authorName: msg.authorName,
          authorRole: msg.authorRole,
          body: snippetAround(msg.body, tokens),
          createdAt: msg.createdAt,
          kind: msg.kind,
          botEvent: msg.botEvent,
          attachments: (msg.attachments ?? []).map((a) => a.name),
          reactions: [...new Set((msg.reactions ?? []).map((r) => r.emoji))],
        };
      }),
    };
  }

  private searchProject(actor: Agent, slug?: string | null): Project {
    if (actor.role === "human") {
      if (!slug) throw new HiveError(400, "Project required");
      return this.getProjectBySlug(slug);
    }
    if (slug) {
      const wanted = this.getProjectBySlug(slug);
      if (wanted.id !== actor.projectId) throw new HiveError(403, "You cannot see other projects");
      return wanted;
    }
    if (actor.projectId) return this.getProject(actor.projectId);
    throw new HiveError(400, "Join a project first");
  }

  private loadMessagesByIds(ids: string[], actorId: string): Message[] {
    const byId = new Map<string, MessageRow>();
    for (const batch of batches([...new Set(ids)])) {
      const rows = this.db.prepare(
        `SELECT *, CAST(body AS BLOB) AS body FROM messages WHERE id IN (${batch.map(() => "?").join(",")})`,
      ).all(...batch) as MessageRow[];
      for (const row of rows) byId.set(row.id, row);
    }
    return this.decorate(this.mapMessages(
      ids.map((id) => byId.get(id)).filter((row): row is MessageRow => Boolean(row)),
    ), actorId);
  }

  threadsInChannel(channelId: string): Thread[] {
    return this.db
      .prepare("SELECT id, channel_id AS channelId, status FROM threads WHERE channel_id = ?")
      .all(channelId) as Thread[];
  }

  replyCounts(channelId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT thread_id AS id, COUNT(*) AS n FROM messages
       WHERE channel_id = ? AND thread_id IS NOT NULL GROUP BY thread_id`,
    ).all(channelId) as { id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  latestSeq(channelId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE channel_id = ?").get(
      channelId,
    ) as { n: number };
    return row.n;
  }

  setThreadStatus(actor: Agent, threadId: string, status: ThreadStatus | null): Thread {
    if (this.tasks.has(threadId)) throw new HiveError(409, 'Use structured task events; generic thread status cannot change a task');
    if (actor.role === "bot") throw new HiveError(403, "Bots cannot change thread status");
    const row = this.db.prepare(
      `SELECT m.id, m.channel_id FROM messages m WHERE m.id = ?`,
    ).get(threadId) as { id: string; channel_id: string } | undefined;
    if (!row) throw new HiveError(404, "Thread not found");
    if (status !== null && !["open", "in_progress", "blocked", "done"].includes(status)) {
      throw new HiveError(400, "Invalid thread status");
    }
    const ch = this.getChannel(row.channel_id);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access thread");
    const commitments = this.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=?').all(threadId);
    if (commitments.length) {
      if (actor.role !== 'human' && actor.id !== this.getMessageById(threadId).authorId)
        throw new HiveError(403, 'Only Human or the delegating brain can close adaptive delegated work');
      if (this.db.prepare('SELECT status FROM threads WHERE id=?').get(threadId)?.status === 'done' && status !== 'done')
        throw new HiveError(409, 'Start a new guarded assignment instead of reopening completed adaptive work');
    }
    return this.transaction(() => {
      const routingChanged = this.adaptiveTopology?.threadStatusChange(actor, threadId, status);
      this.db.prepare(`INSERT INTO threads (id, channel_id, status) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status`).run(threadId, row.channel_id, status);
      const thread = this.db.prepare('SELECT id, channel_id AS channelId, status FROM threads WHERE id=?').get(threadId) as Thread;
      this.afterCommit(() => { this.bus.emit('thread', thread); routingChanged?.(); });
      return thread;
    });
  }

  markRead(actor: Agent, channelId: string, seq: number) {
    this.db.prepare(
      `INSERT INTO reads (agent_id, channel_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
    ).run(actor.id, channelId, seq);
  }

  readsFor(actor: Agent): Record<string, number> {
    const rows = this.db.prepare("SELECT channel_id, last_read_seq FROM reads WHERE agent_id = ?").all(actor.id) as {
      channel_id: string;
      last_read_seq: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.last_read_seq]));
  }

  unreadCounts(actor: Agent): Record<string, number> {
    return this.readState.counts(actor.id, this.listChannels(actor).map((channel) => channel.id));
  }

  /** Explicit receipts for the rendered channel/thread page, not a global cursor. */
  markMessagesRead(actor: Agent, channelId: string, seqs: number[], threadId: string | null = null) {
    this.getAgent(actor.id);
    const channel = this.getChannel(channelId, actor.projectId);
    if (!this.canSeeChannel(actor, channel)) throw new HiveError(403, "Cannot read this channel");
    if (threadId !== null && (typeof threadId !== "string" || !threadId)) throw new HiveError(400, "Invalid thread ID");
    if (threadId !== null) {
      const root = this.db.prepare("SELECT channel_id, thread_id FROM messages WHERE id = ?").get(threadId) as
        { channel_id: string; thread_id: string | null } | undefined;
      if (!root || root.channel_id !== channel.id || root.thread_id !== null) throw new HiveError(400, "Thread must be a root in the selected channel");
    }
    this.readState.markMessages(actor.id, channel.id, seqs, threadId);
  }

  markMentionsSeen(actor: Agent, projectId?: string) {
    this.readState.markMentions(actor.id, this.listChannels(actor).map((channel) => channel.id), projectId);
  }

  mentionInbox(actor: Agent, limit = 30, beforeSeq?: number, projectId?: string): MentionPage {
    return this.readState.atomic(() => {
      const page = this.readState.page(actor.id, this.listChannels(actor).map((channel) => channel.id), limit, beforeSeq, projectId);
      return { messages: this.loadMessagesByIds(page.ids, actor.id), hasMore: page.hasMore, ...this.readState.stamp() };
    });
  }

  readSnapshot(actor: Agent): ReadSnapshot {
    return this.readState.atomic(() => {
      const channels = this.listChannels(actor);
      const ids = channels.map((channel) => channel.id);
      const page = this.readState.page(actor.id, ids);
      const counts = this.readState.mentionCounts(actor.id, ids);
      return {
        ...this.readState.stamp(),
        unread: this.readState.counts(actor.id, ids),
        mentions: this.loadMessagesByIds(page.ids, actor.id),
        mentionsHasMore: page.hasMore,
        mentionCounts: Object.fromEntries(channels.map((channel) => [channel.project, counts[channel.projectId] ?? 0])),
      };
    });
  }

  clearContext(actor: Agent, targetName: string): Message {
    if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can clear context");
    const target = this.getAgentByName(targetName);
    if (!target) throw new HiveError(404, `No agent named ${targetName}`);
    if (target.role !== "worker") throw new HiveError(400, "clear_context is for workers");
    const dm = this.openDm(actor, target.name);
    return this.postMessage(actor, {
      channel: dm.id,
      body: `CONTROL clear_context: before following this request, use get_handoffs and save a checkpoint for relevant active tasks where possible (task_event checkpoint with the current revision). Then discard prior task memory, keeping your Hivemind identity (${target.name}) and standing orders, and wait. This is an instruction only: Hivemind has not erased host context or stopped execution. Do not clear automatically after every result.`,
      kind: "control",
      control: "clear_context",
    });
  }

  openInboxSession(actor: Agent, sessionId: string): string {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents have inbox sessions");
    const previous = this.inbox.currentSession(actor.id);
    const current = this.inbox.openSession(actor.id, sessionId);
    if (previous !== current) this.waiters.get(actor.id)?.supersede();
    return current;
  }

  acknowledgeInbox(actor: Agent, sessionId: string, deliveryId: string) {
    if (actor.role !== "brain" && actor.role !== "worker") throw new HiveError(403, "Only agents acknowledge inbox mail");
    let changed: string[] = [];
    const result = this.inbox.acknowledge(actor.id, sessionId, deliveryId,
      (seqs, at) => { changed = this.tasks.recordReceipt(actor.id, seqs, at); });
    this.timeline.recordAcknowledgement(actor, deliveryId, result.acknowledgedAt);
    for (const id of changed) this.bus.emit('task', this.tasks.get(this.getAgent(HUMAN_ID), id));
    this.emitQueued(actor.id);
    return result;
  }

  /** Publish only after the structured event and its message commit atomically. */
  publishTaskMessage(message: Message) {
    this.bus.emit('message', message);
    this.wakeMembers(this.getChannel(message.channelId), message);
  }

  inboxStatuses(): Record<string, InboxStatus> {
    return Object.fromEntries(
      this.listAgents()
        .filter((agent) => agent.role === "brain" || agent.role === "worker")
        .map((agent) => [agent.id, { ...this.inbox.status(agent.id), queued: this.inboxReader.estimate(agent) }]),
    );
  }

  private takeUnseen(actor: Agent, sessionId: string, compact: boolean, scanLimit: number): WaitResult {
    const current = this.getAgent(actor.id);
    const result = this.inboxReader.take(current, sessionId, compact, scanLimit);
    if (result.delivery) this.timeline.recordOffer(current, result.delivery);
    this.emitQueued(actor.id, result.page!.remaining);
    return result;
  }

  queuedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const agent of this.listAgents()) {
      if (agent.role !== "brain" && agent.role !== "worker") continue;
      out[agent.id] = this.inboxReader.estimate(agent).atLeast;
    }
    return out;
  }

  hasReaction(agentId: string, messageId: string, emoji: string): boolean {
    return Boolean(
      this.db.prepare(
        "SELECT 1 AS ok FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?",
      ).get(messageId, agentId, emoji),
    );
  }

  private emitQueued(agentId: string, estimate?: QueueEstimate) {
    const agent = this.getAgent(agentId);
    if (agent.role !== "brain" && agent.role !== "worker") return;
    const queued = estimate ?? this.inboxReader.estimate(agent);
    this.bus.emit("queued", {
      agentId,
      n: queued.atLeast,
      inbox: { ...this.inbox.status(agentId), queued },
    });
  }

  /** Wait wakes agents only for mail addressed to them, not public chatter. */
  isFor(actor: Agent, msg: Message): boolean {
    return (actor.role === 'brain' || actor.role === 'worker') && this.inboxReader.isFor(actor, msg.seq);
  }

  invite(actor: Agent, channelRef: string, memberNames: string[]): Channel {
    if (actor.role === "worker" || actor.role === "bot") throw new HiveError(403, "Workers and bots cannot invite");
    if (memberNames.length === 0) throw new HiveError(400, "No members to invite");
    const ch = this.getChannel(channelRef, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access channel");
    if (ch.type === "dm") throw new HiveError(400, "Cannot invite to a DM");
    return this.transaction(() => {
      const added: string[] = [];
      for (const name of memberNames) {
        const member = this.getAgentByName(name);
        if (!member) throw new HiveError(404, `No agent named ${name}`);
        if (member.role !== "human" && member.projectId !== ch.projectId) {
          throw new HiveError(403, `${member.name} is not in this project`);
        }
        if (ch.type === "brains" && (member.role === "worker" || member.role === "bot")) {
          throw new HiveError(403, "Workers and bots cannot join brains channels");
        }
        this.addMember(ch.id, member.id);
        added.push(member.name);
      }
      this.afterCommit(() => this.bus.emit("channel", this.getChannel(ch.id)));
      this.postMessage(this.getAgent(HUMAN_ID), { channel: ch.id, body: `${actor.name} invited ${added.join(", ")}`, kind: "system" });
      return this.getChannel(ch.id);
    });
  }

  private wakeMembers(ch: Channel, msg: Message) {
    for (const id of new Set([...ch.memberIds, HUMAN_ID])) {
      if (id === msg.authorId) continue;
      const agent = this.getAgent(id);
      // The notification classifier rechecks current project, channel membership,
      // role and routing in SQL. Do not hydrate the entire roster for every member.
      if (!this.isFor(agent, msg)) continue;
      this.waiters.get(id)?.wake();
      this.emitQueued(id);
    }
  }

  async wait(
    actor: Agent,
    timeoutMs: number,
    signal?: AbortSignal,
    opts: { compact?: boolean; sessionId?: string } = {},
  ): Promise<WaitResult> {
    validated(waitDurationSchema, timeoutMs);
    const compact = Boolean(opts.compact);
    const empty = () => packWait(this.getAgent(actor.id), [], 0, compact, () => "");

    // A cancelled request is observational only: it must not touch presence,
    // install a waiter, advance inbox state, or consume already-queued mail.
    if (actor.role === "bot") throw new HiveError(403, "Bots publish observations; they do not wait for work");

    // No session/presence/cursor side effects for work cancelled before admission.
    if (signal?.aborted) return empty();

    const sessionId =
      opts.sessionId ??
      this.inbox.currentSession(actor.id) ??
      this.openInboxSession(actor, crypto.randomUUID());
    this.inbox.requireSession(actor.id, sessionId);
    this.touch(actor.id, true);

    return new Promise((resolve, reject) => {
      let done = false;
      let scannedRows = 0;
      let hydratedMessages = 0;
      let acknowledgedThroughSeq: number | undefined;
      let routineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + (Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_WAIT_MS);
      const take = () => {
        const batch = this.takeUnseen(actor, sessionId, compact, WAIT_SCAN_MAX - scannedRows);
        const page = batch.page!;
        scannedRows += page.scannedRows;
        hydratedMessages += page.hydratedMessages;
        acknowledgedThroughSeq ??= page.acknowledgedThroughSeq;
        batch.page = { ...page, scannedRows, hydratedMessages, acknowledgedThroughSeq };
        return batch;
      };
      let waiter: Waiter;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (this.waiters.get(actor.id) === waiter) this.waiters.delete(actor.id);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        if (routineTimer) clearTimeout(routineTimer);
      };
      const deliver = (batch: WaitResult) => {
        if (done) return;
        done = true;
        cleanup();
        this.touch(actor.id, true);
        resolve(batch);
      };
      const finish = (consume: boolean) => {
        if (done) return;
        if (!consume || signal?.aborted) {
          deliver(empty());
          return;
        }
        try {
          clearTimeout(routineTimer);
          const batch = take();
          if (batch.idle && batch.retryAfterMs && Date.now() < deadline && scannedRows < WAIT_SCAN_MAX) {
            routineTimer = setTimeout(() => finish(true), Math.min(batch.retryAfterMs, deadline - Date.now()));
          } else deliver(batch);
        }
        catch (error) { done = true; cleanup(); reject(error); }
      };
      waiter = {
        wake: () => finish(true),
        supersede: () => {
          if (done) return;
          done = true;
          cleanup();
          reject(new HiveError(409, "superseded"));
        },
      };
      const onAbort = () => finish(false);
      const prev = this.waiters.get(actor.id);
      if (prev) prev.supersede();
      this.waiters.set(actor.id, waiter);
      const ms = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_WAIT_MS;
      timer = setTimeout(() => finish(true), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish(false);
        return;
      }
      try {
        const first = take();
        if (!first.idle || first.page!.continuation || scannedRows === WAIT_SCAN_MAX) deliver(first);
        else if (first.retryAfterMs) routineTimer = setTimeout(() => finish(true), Math.min(first.retryAfterMs, ms));
      } catch (error) { done = true; cleanup(); reject(error); }
    });
  }

  cancelWaits() {
    for (const waiter of this.waiters.values()) waiter.supersede();
    this.waiters.clear();
  }

  async createFile(
    actor: Agent,
    input: { name: string; mime: string; body: ReadableStream<Uint8Array> | null; signal?: AbortSignal; declaredBytes?: number; authorize?: () => Agent },
  ): Promise<AttachmentMeta> {
    assertAllowedMime(input.mime);
    if (typeof input.name !== "string" || !input.name.length || input.name.length > 180) throw new HiveError(400, "Invalid file name");
    input.signal?.throwIfAborted();
    const lease = this.uploads.acquire(actor.id, input.declaredBytes);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new HiveError(408, "Upload deadline exceeded")), this.uploads.limits.deadlineMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
    try {
      const uploaded = await streamUpload(input.body, input.mime, this.home, signal, input.declaredBytes);
      try {
        signal.throwIfAborted();
        return this.transaction(() => {
          lease.require(uploaded.bytes);
          if (input.authorize && input.authorize().id !== actor.id) throw new HiveError(403, "Upload actor changed");
          if (input.declaredBytes !== undefined && uploaded.bytes !== input.declaredBytes) throw new HiveError(400, "Upload length mismatch");
          commitUpload(uploaded.tmp, uploaded.sha256, this.home);
          const id = crypto.randomUUID();
          this.db.prepare(
            `INSERT INTO attachments (id, message_id, name, mime, bytes, sha256, created_by, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
          ).run(id, input.name, input.mime, uploaded.bytes, uploaded.sha256, actor.id, now());
          return { id, name: input.name, mime: input.mime, bytes: uploaded.bytes };
        });
      } finally { removeUploadTemp(uploaded.tmp); }
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new HiveError(507, "Upload disk is full");
      throw error;
    } finally { clearTimeout(timer); lease.release(); }
  }

  async createFileFromBytes(
    actor: Agent,
    input: { name: string; mime: string; bytes: Uint8Array },
  ): Promise<AttachmentMeta> {
    const { Readable } = await import("node:stream");
    const stream = Readable.toWeb(Readable.from(Buffer.from(input.bytes)));
    return this.createFile(actor, { name: input.name, mime: input.mime, body: stream as ReadableStream<Uint8Array>, declaredBytes: input.bytes.byteLength });
  }

  private validateAttachments(actor: Agent, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new HiveError(400, "Duplicate attachment");
    for (const id of ids) {
      const row = this.db.prepare("SELECT id, message_id, created_by FROM attachments WHERE id = ?").get(id) as
        | { id: string; message_id: string | null; created_by: string }
        | undefined;
      if (!row) throw new HiveError(404, "Attachment not found");
      if (row.created_by !== actor.id) throw new HiveError(403, "Attachment is not yours");
      if (row.message_id) throw new HiveError(409, "Attachment already sent");
    }
  }

  private bindAttachments(messageId: string, ids: string[]) {
    const bind = this.db.prepare("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL");
    for (const id of ids) {
      const result = bind.run(messageId, id);
      if (result.changes !== 1) throw new HiveError(409, "Attachment already sent");
    }
  }

  getAttachment(actor: Agent, id: string): { meta: AttachmentMeta; sha256: string; channelId: string | null } {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
      | {
          id: string;
          message_id: string | null;
          name: string;
          mime: string;
          bytes: number;
          sha256: string;
        }
      | undefined;
    if (!row) throw new HiveError(404, "Attachment not found");
    if (row.message_id) {
      const msg = this.getMessageById(row.message_id);
      const ch = this.getChannel(msg.channelId);
      if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access file");
      return { meta: { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes }, sha256: row.sha256, channelId: ch.id };
    }
    if (row.message_id === null) {
      const owner = this.db.prepare("SELECT created_by FROM attachments WHERE id = ?").get(id) as { created_by: string };
      if (owner.created_by !== actor.id && actor.role !== "human") throw new HiveError(403, "Cannot access file");
    }
    return { meta: { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes }, sha256: row.sha256, channelId: null };
  }

  openAttachment(actor: Agent, id: string) {
    const att = this.getAttachment(actor, id);
    return { ...att, ...openBlob(att.sha256, this.home) };
  }

  private collectUnusedBlobs(): number {
    // Acquire the same cross-process writer lock as publication BEFORE reading the live set.
    return this.transaction(() => {
      const used = new Set(
        (this.db.prepare("SELECT DISTINCT sha256 AS h FROM attachments").all() as { h: string }[]).map((r) => r.h),
      );
      return removeOrphanBlobs(used, this.home);
    });
  }

  gcFiles(): { attachments: number; blobs: number } {
    // Commit metadata removal first. A failed COMMIT must never resurrect references to unlinked blobs.
    const attachments = this.transaction(() => Number(this.db.prepare(
      "DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?",
    ).run(now() - 86_400_000).changes));
    return { attachments, blobs: this.collectUnusedBlobs() };
  }

  toggleReaction(actor: Agent, seq: number, emoji: string): { message: Message; added: boolean } {
    return this.setReaction(actor, seq, emoji);
  }

  /** Omitted present retains legacy toggle; retryable clients use explicit state. */
  setReaction(actor: Agent, seq: number, emoji: string, present?: boolean): { message: Message; added: boolean } {
    if (!Number.isSafeInteger(seq) || seq < 1 || !REACTION_EMOJIS.includes(emoji as (typeof REACTION_EMOJIS)[number]) ||
      (present !== undefined && typeof present !== "boolean")) throw new HiveError(400, "Invalid reaction");
    return this.transaction(() => {
      const msg = this.getMessageBySeq(seq), ch = this.getChannel(msg.channelId);
      if (!this.canSeeChannel(actor, ch) || !this.canPost(actor, ch)) throw new HiveError(403, "Cannot react here");
      const had = Boolean(this.db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND agent_id=? AND emoji=?').get(msg.id, actor.id, emoji));
      const wanted = present ?? !had;
      if (had !== wanted) {
        if (wanted) this.db.prepare('INSERT INTO reactions(message_id,agent_id,emoji,created_at) VALUES(?,?,?,?)').run(msg.id, actor.id, emoji, now());
        else this.db.prepare('DELETE FROM reactions WHERE message_id=? AND agent_id=? AND emoji=?').run(msg.id, actor.id, emoji);
        const forUi = this.decorate([msg], HUMAN_ID)[0]!;
        this.afterCommit(() => this.bus.emit("reaction", { seq: msg.seq, message: forUi }));
      }
      return { message: this.decorate([msg], actor.id)[0]!, added: wanted };
    });
  }

  private decorate(messages: Message[], actorId?: string): Message[] {
    if (messages.length === 0) return messages;
    const atts: Array<{ id: string; message_id: string; name: string; mime: string; bytes: number }> = [];
    const reacts: Array<{ message_id: string; emoji: string; agent_id: string }> = [];
    for (const ids of batches([...new Set(messages.map((m) => m.id))])) {
      const placeholders = ids.map(() => "?").join(",");
      atts.push(...this.db.prepare(
        `SELECT id, message_id, name, mime, bytes FROM attachments WHERE message_id IN (${placeholders})`,
      ).all(...ids) as typeof atts);
      reacts.push(...this.db.prepare(
        `SELECT message_id, emoji, agent_id FROM reactions WHERE message_id IN (${placeholders})`,
      ).all(...ids) as typeof reacts);
    }
    const attMap = new Map<string, AttachmentMeta[]>();
    for (const a of atts) {
      const list = attMap.get(a.message_id) ?? [];
      list.push({ id: a.id, name: a.name, mime: a.mime, bytes: a.bytes });
      attMap.set(a.message_id, list);
    }
    const reactMap = new Map<string, ReactionCount[]>();
    for (const r of reacts) {
      const list = reactMap.get(r.message_id) ?? [];
      const found = list.find((x) => x.emoji === r.emoji);
      if (found) {
        found.count += 1;
        if (actorId && r.agent_id === actorId) found.mine = true;
      } else {
        list.push({ emoji: r.emoji, count: 1, mine: Boolean(actorId && r.agent_id === actorId) });
      }
      reactMap.set(r.message_id, list);
    }
    return messages.map((m) => ({
      ...m,
      attachments: attMap.get(m.id) ?? [],
      reactions: reactMap.get(m.id) ?? [],
    }));
  }

  sweepPresence(maxIdleMs = PRESENCE_IDLE_MS) {
    const cutoff = now() - maxIdleMs;
    const rows = this.db.prepare(
      `SELECT id FROM agents WHERE role != 'human' AND online = 1 AND last_seen_at < ?`,
    ).all(cutoff) as { id: string }[];
    for (const r of rows) {
      if (this.waiters.has(r.id)) {
        this.touch(r.id, true);
        continue;
      }
      this.setOffline(r.id);
    }
  }
}

export function describeAgent(agent: Agent): string {
  if (agent.role === "human") return "Human";
  if (agent.role === "bot") return "bot (context only)";
  if (agent.role === "brain") return agent.focus ? `brain (${agent.focus})` : "brain";
  const sen = agent.seniority ?? "mid";
  return agent.focus ? `${sen} worker (${agent.focus})` : `${sen} worker`;
}

export function channelLabel(ch: Channel): string {
  if (ch.type === "dm") return ch.name;
  return `#${ch.name}`;
}

function slugify(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function dmLabel(a: Agent, b: Agent): string {
  return [a.name, b.name].sort((x, y) => x.localeCompare(y)).join(" · ");
}

export function parseMentions(body: string, agents: Agent[]): string[] {
  const ids = new Set<string>();
  const re = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1]!;
    const agent = agents.find((a) => a.role !== "bot" && a.name.toLowerCase() === name.toLowerCase());
    if (agent) ids.add(agent.id);
  }
  return [...ids];
}
