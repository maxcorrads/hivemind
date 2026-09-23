import { RoutingStore } from './routing.ts';
import { DecisionStore } from './decisions.ts';
import { TimelineStore } from './timeline.ts';
import { UploadBudget, type UploadLimits } from "./upload-budget.ts";
import { joinInputSchema, validated, waitDurationSchema, cursorSchema, limitSchema, channelInputSchema, attachmentIdsSchema, memberNamesSchema } from "../shared/api-contract.ts";
import { SendRequests } from "./send-requests.ts";
import { pruneTelegramUpdates, type TelegramUpdateScope } from "./telegram-inbox.ts";
import { pruneTelegramFailures, type TelegramDestination } from "./telegram-outbox.ts";
import { TelegramAdminService } from "./services/telegram-admin.ts";
import { FileService } from "./services/files.ts";
import { ProjectService } from "./services/projects.ts";
import type { ChannelAccess, Core, MessageReader } from "./services/ports.ts";
import { Storage } from './storage.ts';
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HiveBus } from "./hive-events.ts";
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
import { canonicalWorktree, resolveJoinProject } from "../shared/project.ts";
import { clampSearchLimit, likeNeedle, parseSearchQuery, snippetAround } from "../shared/search-query.ts";
import { pickName } from "./names.ts";
import { ReadState } from "./read-state.ts";
import { InboxDeliveryStore } from "./inbox-delivery.ts";
import { InboxReader } from "./inbox-reader.ts";
import type { MentionPage, ReadSnapshot } from "../shared/read-state.ts";
import { hiveHome } from "./paths.ts";
import { preparePrivateDatabase } from "./private-database.ts";
import { removeLegacyIdentityDirs } from "./legacy-identities.ts";
import { packWait } from "./wait-format.ts";
import { digestExpansionSchema } from "../shared/digest.ts";
import { botMessageSchema, createBotSchema, botCredentialSchema } from "../shared/bot-message.ts";
import { applyMigrations, assertSupportedVersion } from "./migrations/index.ts";
import { TaskStore } from './tasks.ts';
import { NotificationStore } from './notifications.ts';
import { RoomStore } from './rooms.ts';
import { ROUTINE_BATCH_MS } from '../shared/notifications.ts';
import { AdaptiveTopologyRuntime } from './adaptive-topology.ts';
import type { TaskEnvelope } from '../shared/tasks.ts';

export { hiveHome } from "./paths.ts";
import { parseMentions } from "../shared/mentions.ts";
// Kept for callers that historically imported the helper from the Hive module.
export { parseMentions };

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

/** Every service's dependencies; filled in construction order, read by services at call time. */
type ServiceRegistry = Core & {
  home: string;
  uploads: UploadBudget;
  telegram: TelegramAdminService;
  files: FileService;
  projects: ProjectService;
  messages: MessageReader;
  channels: ChannelAccess & { ensureBuiltinChannels(project: Project): void; addHumanToAllChannels(): void };
  agents: { busyAgents(projectId: string): Agent[] };
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
  private waiters = new Map<string, Waiter>();
  private telegramOrigin = new Set<string>();
  readonly uploads!: UploadBudget;
  private readonly readState!: ReadState;
  readonly storage: Storage;
  readonly telegramAdmin!: TelegramAdminService;
  readonly files!: FileService;
  readonly projects!: ProjectService;
  /** The registry every service receives, typed down to its own dependencies (services/ports.ts). */
  private readonly services: ServiceRegistry;

  constructor(dbPath = path.join(hiveHome(), "hive.db"), options: { routineBatchMs?: number; uploadLimits?: Partial<UploadLimits> } = {}) {
    this.home = path.dirname(dbPath);
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    preparePrivateDatabase(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.storage = Storage.for(this.db);
    // Transitional: domains not yet extracted are served by Hive itself.
    const registry: Partial<ServiceRegistry> = { storage: this.storage, bus: this.bus, home: this.home, messages: this, channels: this, agents: this };
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
      this.transaction(() => this.bootstrap());
      this.transaction(() => { pruneTelegramUpdates(this.db); pruneTelegramFailures(this.db); });
      this.readState = new ReadState(this.db);
      this.sendRequests = new SendRequests(this.db);
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

  /** Brains/workers of a project that are online or blocked in a wait. */
  busyAgents(projectId: string): Agent[] {
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND id != ? AND role != 'human'",
    ).all(projectId, HUMAN_ID) as AgentRow[];
    return rows.map((row) => this.mapAgent(row)).filter((agent) => agent.online || this.waiters.has(agent.id));
  }

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
    const existing = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(HUMAN_ID);
    if (!existing) {
      const t = now();
      this.db.prepare(
        `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor)
         VALUES (?, ?, 'human', NULL, NULL, ?, 1, ?, ?, 0)`,
      ).run(HUMAN_ID, HUMAN_NAME, hashToken("human-local"), t, t);
    }

    const home = this.projects.listProjects()[0];
    if (home) this.ensureBuiltinChannels(home);
    this.addHumanToAllChannels();
  }

  ensureBuiltinChannels(project: Project) {
    this.ensureBuiltinChannel(project, "general", "public", "Town square");
    this.ensureBuiltinChannel(project, "brains", "brains", "Human and brains only");
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

  addHumanToAllChannels() {
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
    this.files.deleteUnsentBy(target.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(target.id);
    if (target.projectId) {
      const general = this.db.prepare(
        "SELECT id FROM channels WHERE project_id = ? AND lower(name) = 'general'",
      ).get(target.projectId) as { id: string } | undefined;
      if (general) this.postSystem(general.id, `${actor.name} removed ${target.name} from the hive.`);
    }
    this.bus.emit("project", { removed: target.name });
    return target;
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
    const assertResumable = (agent: Agent) => {
      if (agent.role !== input.role) {
        throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
      }
      if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
        throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
      }
      if (input.project) this.assertSameProject(agent, this.projects.getProjectBySlug(input.project));
      else if (input.cwd) {
        const cwd = canonicalWorktree(input.cwd);
        const worktree = this.projects.listProjects().find(project => project.worktree && canonicalWorktree(project.worktree) === cwd);
        if (worktree) this.assertSameProject(agent, worktree);
      }
    };
    // The session key of a running process: a repeated join keeps its session.
    const current = input.token
      ? this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hashToken(input.token)) as AgentRow | undefined
      : undefined;
    if (current) {
      const agent = this.mapAgent(current);
      if (input.resumeName && agent.name.toLowerCase() !== input.resumeName.toLowerCase()) {
        throw new HiveError(403, `This session is ${agent.name}, not ${input.resumeName}`);
      }
      assertResumable(agent);
      this.touch(agent.id, true);
      return { agent, token: input.token!, created: false };
    }
    // Brains and workers have no stored credentials: resuming by name opens a new session
    // and supersedes the previous one, whose key stops working.
    if (input.resumeName) {
      const row = this.db.prepare("SELECT * FROM agents WHERE lower(name) = lower(?) AND role IN ('brain','worker')")
        .get(input.resumeName) as AgentRow | undefined;
      if (!row) throw new HiveError(404, `No brain or worker named ${input.resumeName}; join without resume to get a new name`);
      const agent = this.mapAgent(row);
      assertResumable(agent);
      return this.transaction(() => {
        const token = this.replaceAgentSession(agent.id);
        this.touch(agent.id, true);
        return { agent: this.getAgent(agent.id), token, created: false };
      });
    }
    if (input.token) throw new HiveError(401, "This session key is no longer valid; join again with resume=YOUR_NAME");

    if (input.role === "worker" && !input.seniority) {
      throw new HiveError(400, "Workers need --seniority junior|mid|senior");
    }
    if (input.role === "brain" && input.seniority) {
      throw new HiveError(400, "Brains have no seniority; only workers do");
    }

    const project = resolveJoinProject(this.projects.listProjects(), { project: input.project, cwd: input.cwd });
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

  /** Issues a new session key and fences the previous session's waits and receipts in the same commit. */
  private replaceAgentSession(agentId: string): string {
    const token = newToken();
    this.db.prepare("UPDATE agents SET token_hash=? WHERE id=?").run(hashToken(token), agentId);
    // Do not call the inbox store's top-level transaction from this transaction.
    this.db.prepare(`INSERT INTO inbox_sessions(agent_id,session_id,generation)
      SELECT ?,?,COALESCE(MAX(generation),0)+1 FROM inbox_sessions WHERE agent_id=?`).run(agentId, crypto.randomUUID(), agentId);
    this.afterCommit(() => this.waiters.get(agentId)?.supersede());
    return token;
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
    const project = this.projects.requireActorProject(actor, input.project);
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

  openDm(actor: Agent, otherName: string): Channel {
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
      this.afterCommit(() => this.bus.emit("channel", ch));
      return ch;
    };
    // Nests as a savepoint inside a caller's transaction (e.g. TaskStore.assign); the event waits for its commit.
    return this.transaction(create);
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
    const project = this.projects.requireActorProject(actor, projectRef);
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
    const project = this.projects.requireActorProject(actor, projectRef), bot = this.getAgent(botId);
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
      if (attachmentIds.length) this.files.validateAttachments(actor, attachmentIds);
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
      if (attachmentIds.length) this.files.bindAttachments(id, attachmentIds);
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
    const project = this.projects.searchProject(actor, input.project);
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
    return this.readState.snapshot(() => {
      const page = this.readState.page(actor.id, this.listChannels(actor).map((channel) => channel.id), limit, beforeSeq, projectId);
      return { messages: this.loadMessagesByIds(page.ids, actor.id), hasMore: page.hasMore, ...this.readState.stamp() };
    });
  }

  readSnapshot(actor: Agent): ReadSnapshot {
    return this.readState.snapshot(() => {
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

  createFile(...args: Parameters<FileService["createFile"]>) { return this.files.createFile(...args); }
  createFileFromBytes(...args: Parameters<FileService["createFileFromBytes"]>) { return this.files.createFileFromBytes(...args); }
  getAttachment(actor: Agent, id: string) { return this.files.getAttachment(actor, id); }
  openAttachment(actor: Agent, id: string) { return this.files.openAttachment(actor, id); }
  gcFiles() { return this.files.gcFiles(); }

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
