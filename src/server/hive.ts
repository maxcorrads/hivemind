import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_SLUG,
  HUMAN_ID,
  HUMAN_NAME,
  WAIT_SCAN_MAX,
  type Agent,
  type BotEvent,
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
import { InboxDeliveryStore } from "./inbox-delivery.ts";
import { InboxReader } from "./inbox-reader.ts";
import { canonicalWorktree, parseProjectSlug, resolveJoinProject } from "../shared/project.ts";
import { clampSearchLimit, likeNeedle, parseSearchQuery, snippetAround } from "../shared/search-query.ts";
import { pickName } from "./names.ts";
import { hiveHome } from "./paths.ts";
import { packWait } from "./wait-format.ts";
import { botMessageSchema, createBotSchema } from "../shared/bot-message.ts";
import { digestExpansionSchema } from "../shared/digest.ts";
import { assertAllowedMime, commitUpload, openBlob, removeOrphanBlobs, streamUpload } from "./files.ts";

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
  body: string;
  kind: "chat" | "system" | "control";
  control: ControlAction | null;
  event_type?: Message["eventType"] | null;
  mentions: string;
  created_at: number;
};


export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `hm_${randomBytes(24).toString("hex")}`;
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
  readonly inbox: InboxDeliveryStore;
  private readonly inboxReader: InboxReader;
  private waiters = new Map<string, Waiter>();
  private telegramOrigin = new Set<string>();

  constructor(dbPath = path.join(hiveHome(), "hive.db")) {
    this.home = path.dirname(dbPath);
    this.bus.setMaxListeners(200);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.migrateProjects();
    this.bootstrap();
    this.inbox = new InboxDeliveryStore(this.db);
    this.inboxReader = new InboxReader(this.db, this.inbox);
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
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
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
      CREATE TABLE IF NOT EXISTS telegram_hold (
        telegram_message_id INTEGER PRIMARY KEY,
        telegram_thread_id INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    if (!this.db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "event_type")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN event_type TEXT");
    }
  }

  private tableSql(name: string): string {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql: string }
      | undefined;
    return row?.sql ?? "";
  }

  private hasColumn(table: string, col: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === col);
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

  private migrateProjects() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        worktree TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    if (!this.hasColumn("agents", "project_id")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT");
    }
    if (!this.hasColumn("channels", "project_id")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN project_id TEXT");
    }
    const holdSql = this.tableSql("telegram_hold");
    if (!this.hasColumn("telegram_hold", "telegram_chat_id") || /telegram_message_id INTEGER PRIMARY KEY/i.test(holdSql)) {
      const holds = holdSql
        ? (this.db.prepare("SELECT * FROM telegram_hold").all() as Array<{
            telegram_message_id: number;
            telegram_thread_id: number;
            payload: string;
            telegram_chat_id?: number | null;
          }>)
        : [];
      this.db.exec(`
        DROP TABLE IF EXISTS telegram_hold;
        CREATE TABLE telegram_hold (
          telegram_chat_id INTEGER NOT NULL,
          telegram_message_id INTEGER NOT NULL,
          telegram_thread_id INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (telegram_chat_id, telegram_message_id)
        );
      `);
      const insHold = this.db.prepare(
        "INSERT INTO telegram_hold (telegram_chat_id, telegram_message_id, telegram_thread_id, payload) VALUES (?, ?, ?, ?)",
      );
      for (const row of holds) {
        insHold.run(row.telegram_chat_id ?? 0, row.telegram_message_id, row.telegram_thread_id, row.payload);
      }
    }
    const topicSql = this.tableSql("telegram_topics");
    if (!this.hasColumn("telegram_out", "telegram_chat_id") || /telegram_message_id INTEGER PRIMARY KEY/i.test(this.tableSql("telegram_out"))) {
      const rows = this.db.prepare("SELECT * FROM telegram_out").all() as Array<{
        telegram_message_id: number;
        seq: number;
        channel_id: string;
        thread_id: string | null;
        telegram_chat_id?: number | null;
      }>;
      this.db.exec(`
        DROP TABLE telegram_out;
        CREATE TABLE telegram_out (
          telegram_chat_id INTEGER NOT NULL,
          telegram_message_id INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          PRIMARY KEY (telegram_chat_id, telegram_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_telegram_out_seq ON telegram_out(seq);
      `);
      const ins = this.db.prepare(
        "INSERT INTO telegram_out (telegram_chat_id, telegram_message_id, seq, channel_id, thread_id) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of rows) {
        ins.run(row.telegram_chat_id ?? 0, row.telegram_message_id, row.seq, row.channel_id, row.thread_id);
      }
    }

    if (
      !this.hasColumn("telegram_topics", "telegram_chat_id") ||
      /telegram_thread_id INTEGER NOT NULL UNIQUE/i.test(topicSql)
    ) {
      const rows = this.db.prepare("SELECT * FROM telegram_topics").all() as Array<{
        channel_id: string;
        telegram_thread_id: number;
        telegram_chat_id?: number | null;
      }>;
      this.db.exec(`
        DROP TABLE telegram_topics;
        CREATE TABLE telegram_topics (
          channel_id TEXT PRIMARY KEY,
          telegram_thread_id INTEGER NOT NULL,
          telegram_chat_id INTEGER
        );
      `);
      const ins = this.db.prepare(
        "INSERT INTO telegram_topics (channel_id, telegram_thread_id, telegram_chat_id) VALUES (?, ?, ?)",
      );
      for (const row of rows) ins.run(row.channel_id, row.telegram_thread_id, row.telegram_chat_id ?? null);
    }

    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    if (count === 0) {
      this.db.prepare("INSERT INTO projects (id, slug, name, worktree, created_at) VALUES (?, ?, ?, NULL, ?)").run(
        crypto.randomUUID(),
        DEFAULT_PROJECT_SLUG,
        DEFAULT_PROJECT_NAME,
        now(),
      );
    }
    const seed = this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC LIMIT 1").get() as ProjectRow;
    this.db.prepare("UPDATE agents SET project_id = ? WHERE project_id IS NULL AND id != ?").run(seed.id, HUMAN_ID);
    this.db.prepare("UPDATE channels SET project_id = ? WHERE project_id IS NULL").run(seed.id);
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
    const exists = this.db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
    if (exists) throw new HiveError(409, `Project ${slug} already exists`);
    const id = crypto.randomUUID();
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
        this.db.prepare(`DELETE FROM threads WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM bot_events WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM reads WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM channel_members WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM messages WHERE channel_id IN (${ph})`).run(...channelIds);
        this.db.prepare(`DELETE FROM channels WHERE id IN (${ph})`).run(...channelIds);
      }

      for (const chatId of chatIds) {
        this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
        this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
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
      const used = new Set(
        (this.db.prepare("SELECT DISTINCT sha256 AS h FROM attachments").all() as { h: string }[]).map((row) => row.h),
      );
      removeOrphanBlobs(used, this.home);
    } catch {
      /* sweep can drop leftover blobs later */
    }
    this.bus.emit("project", { deleted: project.slug });
  }

  forgetTelegramChat(chatId: number) {
    if (!Number.isFinite(chatId)) return;
    this.db.prepare("DELETE FROM telegram_hold WHERE telegram_chat_id = ?").run(chatId);
    this.db.prepare("DELETE FROM telegram_state WHERE key = ?").run(`mute:${chatId}`);
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
    this.db.prepare(
      `UPDATE agents SET last_seen_at = ?, online = ? WHERE id = ?`,
    ).run(now(), online ? 1 : 0, agentId);
    this.bus.emit("agent", this.getAgent(agentId));
  }

  setOffline(agentId: string) {
    if (agentId === HUMAN_ID) return;
    this.touch(agentId, false);
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

  private mapAgent(row: AgentRow): Agent {
    const project = row.project_id
      ? this.db.prepare("SELECT * FROM projects WHERE id = ?").get(row.project_id) as ProjectRow | undefined
      : undefined;
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
      project: project?.slug ?? null,
    };
  }

  listAgents(viewer?: Agent): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY role, seniority, name").all() as AgentRow[];
    const all = rows.map((r) => this.mapAgent(r));
    if (!viewer || viewer.role === "human") return all;
    return all.filter((a) => a.role === "human" || a.projectId === viewer.projectId);
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
        this.touch(agent.id, true);
        return { agent, token: input.token, created: false };
      }
      if (!input.resumeName) throw new HiveError(401, "Invalid token");
    }

    if (input.resumeName) {
      const agent = this.getAgentByName(input.resumeName);
      if (!agent) throw new HiveError(404, `No identity named ${input.resumeName}`);
      if (agent.role !== input.role) {
        throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
      }
      if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
        throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
      }
      if (input.project) this.assertSameProject(agent, this.getProjectBySlug(input.project));
      const token = newToken();
      this.db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(hashToken(token), agent.id);
      this.touch(agent.id, true);
      return { agent: this.getAgent(agent.id), token, created: false };
    }

    if (input.role === "worker" && !input.seniority) {
      throw new HiveError(400, "Workers need --seniority junior|mid|senior");
    }
    if (input.role === "brain" && input.seniority) {
      throw new HiveError(400, "Brains have no seniority; only workers do");
    }

    const project = resolveJoinProject(this.listProjects(), { project: input.project, cwd: input.cwd });
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
      this.postSystem(general.id, `${agent.name} has joined as ${describeAgent(agent)}.`);
    }
    const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get() as { n: number };
    this.db.prepare("UPDATE agents SET inbox_cursor = ? WHERE id = ?").run(maxSeq.n, id);
    this.bus.emit("agent", agent);
    return { agent: this.getAgent(id), token, created: true };
  }

  listChannels(actor: Agent): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY type, name").all() as ChannelRow[];
    return rows
      .map((r) => this.mapChannel(r))
      .filter((ch) => this.canSeeChannel(actor, ch));
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
    if (actor.projectId && ch.projectId && actor.projectId !== ch.projectId) return false;
    if (ch.type === "brains" && actor.role !== "brain") return false;
    return ch.memberIds.includes(actor.id);
  }

  canPost(actor: Agent, ch: Channel): boolean {
    if (actor.role === "bot") return false; // Bots use the observation-only ingress.
    if (actor.role === "human") return true;
    if (actor.projectId && ch.projectId && actor.projectId !== ch.projectId) return false;
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
    this.bus.emit("channel", ch);
    this.postSystem(id, `${actor.name} created #${slug}`);
    return this.getChannel(id);
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
    this.bus.emit("channel", ch);
    return ch;
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
    let messageId: string;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(`SELECT message_id, payload_hash FROM bot_events
        WHERE bot_id = ? AND channel_id = ? AND thread_id = ? AND event_id = ?`)
        .get(actor.id, ch.id, input.threadId ?? "", input.eventId) as { message_id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new HiveError(409, "Event ID already used with different content; use a new revision/event ID");
        this.db.exec("COMMIT");
        return { message: this.getMessageById(previous.message_id), duplicate: true };
      }
      messageId = crypto.randomUUID();
      this.db.prepare(`INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, mentions, created_at, event_type)
        VALUES (?, ?, ?, ?, ?, 'chat', '[]', ?, ?)`)
        .run(messageId, ch.id, input.threadId ?? null, actor.id, input.body, now(), input.eventType ?? null);
      this.db.prepare(`INSERT INTO bot_events (message_id, bot_id, channel_id, thread_id, event_id, metadata, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, actor.id, ch.id, input.threadId ?? "", input.eventId, JSON.stringify(event), payloadHash);
      this.bindAttachments(actor, messageId, input.attachmentIds);
      if (input.threadId) this.db.prepare("INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')")
        .run(input.threadId, ch.id);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    const message = this.getMessageById(messageId);
    this.bus.emit("message", message);
    this.wakeMembers(ch, message);
    return { message, duplicate: false };
  }

  postMessage(
    actor: Agent,
    input: {
      channel: string;
      body: string;
      threadId?: string | null;
      kind?: Message["kind"];
      eventType?: Message["eventType"];
      control?: ControlAction | null;
      source?: "hive" | "telegram";
      attachmentIds?: string[];
    },
  ): Message {
    if (input.eventType !== undefined && !MESSAGE_EVENT_TYPES.includes(input.eventType))
      throw new HiveError(400, "Unknown message eventType");
    const ch = this.getChannel(input.channel, actor.projectId);
    if (!this.canSeeChannel(actor, ch) || !this.canPost(actor, ch)) {
      throw new HiveError(403, `You cannot post to ${channelLabel(ch)}`);
    }
    if (actor.role === "human" && !ch.memberIds.includes(actor.id)) {
      this.addMember(ch.id, actor.id);
      ch.memberIds.push(actor.id);
    }
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
    this.db.prepare(
      `INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at, event_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      ch.id,
      input.threadId ?? null,
      actor.id,
      body,
      kind,
      input.control ?? null,
      JSON.stringify(mentions),
      t,
      input.eventType ?? null,
    );
    if (input.threadId) {
      this.db.prepare(
        `INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')`,
      ).run(input.threadId, ch.id);
    }
    if (attachmentIds.length) this.bindAttachments(actor, id, attachmentIds);
    this.touch(actor.id, true);
    const msg = this.getMessageById(id);
    if (input.source === "telegram") this.telegramOrigin.add(msg.id);
    this.bus.emit("message", msg);
    this.wakeMembers(ch, msg);
    return msg;
  }

  fromTelegram(messageId: string): boolean {
    return this.telegramOrigin.has(messageId);
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
    const row = this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(seq) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  getMessageById(id: string): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.decorate([this.mapMessage(row)])[0]!;
  }

  private mapMessage(row: MessageRow): Message {
    const botRow = this.db.prepare("SELECT metadata FROM bot_events WHERE message_id = ?").get(row.id) as { metadata: string } | undefined;
    let author: Agent;
    try {
      author = this.getAgent(row.author_id);
    } catch {
      author = {
        id: row.author_id,
        name: "unknown",
        role: "worker",
        seniority: null,
        focus: null,
        online: false,
        lastSeenAt: row.created_at,
        createdAt: row.created_at,
        projectId: null,
        project: null,
      };
    }
    return {
      id: row.id,
      seq: row.seq,
      channelId: row.channel_id,
      threadId: row.thread_id,
      authorId: author.id,
      authorName: author.name,
      authorRole: author.role,
      body: row.body,
      kind: row.kind,
      control: row.control,
      ...(row.event_type ? { eventType: row.event_type } : {}),
      mentions: JSON.parse(row.mentions) as string[],
      createdAt: row.created_at,
      ...(botRow ? { source: "bot" as const, botEvent: JSON.parse(botRow.metadata) as BotEvent } : {}),
    };
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
      COALESCE((SELECT length(CAST(metadata AS BLOB)) FROM bot_events WHERE message_id = messages.id), 0) AS metadata_bytes FROM messages
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
      const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(header.id) as MessageRow;
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
  ): { messages: Message[]; hasOlder: boolean } {
    const ch = this.getChannel(channelRef, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Number(opts.limit) : 80), 200);
    const after = opts.afterSeq ?? 0;
    const before = opts.beforeSeq;
    let rows: MessageRow[];
    if (opts.threadId) {
      const sqlBefore = before
        ? `SELECT * FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) AND seq < ? ORDER BY seq DESC LIMIT ?`
        : `SELECT * FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) AND seq > ? ORDER BY seq ASC LIMIT ?`;
      rows = before
        ? (this.db.prepare(sqlBefore).all(ch.id, opts.threadId, opts.threadId, before, limit) as MessageRow[]).reverse()
        : (this.db.prepare(sqlBefore).all(ch.id, opts.threadId, opts.threadId, after, limit) as MessageRow[]);
    } else if (before) {
      rows = this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_id IS NULL AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(ch.id, before, limit) as MessageRow[];
      rows.reverse();
    } else {
      rows = this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_id IS NULL AND seq > ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(ch.id, after, limit) as MessageRow[];
      rows.reverse();
    }
    const messages = this.decorate(rows.map((r) => this.mapMessage(r)), actor.id);
    const scope = opts.threadId
      ? this.db.prepare(
          `SELECT COALESCE(MIN(seq), 0) AS n FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?)`,
        ).get(ch.id, opts.threadId, opts.threadId) as { n: number }
      : this.db.prepare(
          `SELECT COALESCE(MIN(seq), 0) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL`,
        ).get(ch.id) as { n: number };
    const oldest = messages[0]?.seq ?? 0;
    return { messages, hasOlder: Boolean(oldest && scope.n && scope.n < oldest) };
  }

  searchMessages(
    actor: Agent,
    input: { q: string; project?: string | null; channel?: string | null; beforeSeq?: number; limit?: number },
  ): { hits: SearchHit[]; hasMore: boolean } {
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
    const roomIds = rooms.map((ch) => ch.id);
    const roomPh = roomIds.map(() => "?").join(",");
    const params: Array<string | number> = [project.id, ...roomIds, before];
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
         AND c.id IN (${roomPh})
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
    if (ids.length === 0) return [];
    const ph = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM messages WHERE id IN (${ph})`).all(...ids) as MessageRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return this.decorate(
      ids.map((id) => byId.get(id)).filter((row): row is MessageRow => Boolean(row)).map((row) => this.mapMessage(row)),
      actorId,
    );
  }

  threadsInChannel(channelId: string): Thread[] {
    return this.db.prepare("SELECT * FROM threads WHERE channel_id = ?").all(channelId) as Thread[];
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
    this.db.prepare(
      `INSERT INTO threads (id, channel_id, status) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(threadId, row.channel_id, status);
    const thread = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread;
    this.bus.emit("thread", thread);
    return thread;
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
    const channels = this.listChannels(actor);
    const reads = this.readsFor(actor);
    const out: Record<string, number> = {};
    for (const ch of channels) {
      const last = reads[ch.id] ?? 0;
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND seq > ? AND author_id != ?`,
      ).get(ch.id, last, actor.id) as { n: number };
      out[ch.id] = row.n;
    }
    return out;
  }

  markMentionsSeen(actor: Agent, projectId?: string) {
    const inbox = this.mentionInbox(actor, 400, undefined, projectId);
    for (const m of inbox.messages) this.markRead(actor, m.channelId, m.seq);
  }

  mentionInbox(
    actor: Agent,
    limit = 30,
    beforeSeq?: number,
    projectId?: string,
  ): { messages: Message[]; hasMore: boolean } {
    const reads = this.readsFor(actor);
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE mentions LIKE ? ORDER BY seq DESC LIMIT 400`,
    ).all(`%${actor.id}%`) as MessageRow[];
    const unseen = rows
      .map((r) => this.mapMessage(r))
      .filter((m) => m.mentions.includes(actor.id) && m.seq > (reads[m.channelId] ?? 0))
      .filter((m) => beforeSeq == null || m.seq < beforeSeq)
      .filter((m) => {
        if (!projectId) return true;
        try {
          return this.getChannel(m.channelId).projectId === projectId;
        } catch {
          return false;
        }
      });
    return {
      messages: this.decorate(unseen.slice(0, limit), actor.id),
      hasMore: unseen.length > limit,
    };
  }

  clearContext(actor: Agent, targetName: string): Message {
    if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can clear context");
    const target = this.getAgentByName(targetName);
    if (!target) throw new HiveError(404, `No agent named ${targetName}`);
    if (target.role !== "worker") throw new HiveError(400, "clear_context is for workers");
    const dm = this.openDm(actor, target.name);
    return this.postMessage(actor, {
      channel: dm.id,
      body: `CONTROL clear_context: discard all prior task memory. Keep only your Hivemind identity (${target.name}) and standing orders. Then wait.`,
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
    const result = this.inbox.acknowledge(actor.id, sessionId, deliveryId);
    this.emitQueued(actor.id);
    return result;
  }

  inboxStatuses(): Record<string, InboxStatus> {
    return Object.fromEntries(this.listAgents().filter(a => a.role === "brain" || a.role === "worker")
      .map(a => [a.id, { ...this.inbox.status(a.id), queued: this.inboxReader.estimate(a) }]));
  }

  private takeUnseen(actor: Agent, sessionId: string, compact: boolean, scanLimit: number): WaitResult {
    const result = this.inboxReader.take(this.getAgent(actor.id), sessionId, compact, scanLimit);
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
    this.bus.emit("queued", { agentId, n: queued.atLeast, inbox: { ...this.inbox.status(agentId), queued } });
  }

  /** Wait wakes agents only for mail addressed to them, not public chatter. */
  isFor(actor: Agent, msg: Message): boolean {
    if (actor.role === "bot") return false;
    if (msg.mentions.includes(actor.id)) return true;
    if (msg.kind === "control") {
      const ch = this.getChannel(msg.channelId);
      return this.canSeeChannel(actor, ch);
    }
    const ch = this.getChannel(msg.channelId);
    if (ch.type === "dm" || ch.type === "private") return true;
    if (ch.type === "brains" && actor.role === "brain") return true;
    return false;
  }

  invite(actor: Agent, channelRef: string, memberNames: string[]): Channel {
    if (actor.role === "worker" || actor.role === "bot") throw new HiveError(403, "Workers and bots cannot invite");
    if (memberNames.length === 0) throw new HiveError(400, "No members to invite");
    const ch = this.getChannel(channelRef, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access channel");
    if (ch.type === "dm") throw new HiveError(400, "Cannot invite to a DM");
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
    this.bus.emit("channel", this.getChannel(ch.id));
    this.postSystem(ch.id, `${actor.name} invited ${added.join(", ")}`);
    return this.getChannel(ch.id);
  }

  private wakeMembers(ch: Channel, msg: Message) {
    for (const id of new Set([...ch.memberIds, HUMAN_ID])) {
      if (id === msg.authorId) continue;
      const agent = this.getAgent(id);
      const channel = this.getChannel(ch.id);
      if (!this.canSeeChannel(agent, channel)) continue;
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
    if (actor.role === "bot") throw new HiveError(403, "Bots publish observations; they do not wait for work");
    const sessionId = opts.sessionId ?? this.inbox.currentSession(actor.id) ?? this.openInboxSession(actor, crypto.randomUUID());
    this.inbox.requireSession(actor.id, sessionId);
    this.touch(actor.id, true);
    const compact = Boolean(opts.compact);
    const empty = () => packWait(this.getAgent(actor.id), [], 0, compact, () => "");

    return new Promise((resolve, reject) => {
      let done = false;
      let scannedRows = 0;
      let hydratedMessages = 0;
      let acknowledgedThroughSeq: number | undefined;
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
      const cleanup = () => {
        if (this.waiters.get(actor.id) === waiter) this.waiters.delete(actor.id);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
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
        try { deliver(take()); }
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
      const timer = setTimeout(() => finish(true), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { finish(false); return; }
      try {
        const first = take();
        // Empty progress pages continue immediately. MCP loops internally; don't
        // add a full long-poll timeout for each page of unaddressed backlog.
        // The initial scan and any scan after sleeping share this request's
        // budget. Return at exhaustion even when only public noise was scanned.
        if (!first.idle || first.page!.continuation || scannedRows === WAIT_SCAN_MAX) deliver(first);
      } catch (error) { done = true; cleanup(); reject(error); }
    });
  }

  async createFile(
    actor: Agent,
    input: { name: string; mime: string; body: ReadableStream<Uint8Array> | null },
  ): Promise<AttachmentMeta> {
    assertAllowedMime(input.mime);
    const uploaded = await streamUpload(input.body, input.mime, this.home);
    await commitUpload(uploaded.tmp, uploaded.sha256, this.home);
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO attachments (id, message_id, name, mime, bytes, sha256, created_by, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.name.slice(0, 180), input.mime, uploaded.bytes, uploaded.sha256, actor.id, now());
    return { id, name: input.name.slice(0, 180), mime: input.mime, bytes: uploaded.bytes };
  }

  async createFileFromBytes(
    actor: Agent,
    input: { name: string; mime: string; bytes: Uint8Array },
  ): Promise<AttachmentMeta> {
    const { Readable } = await import("node:stream");
    const stream = Readable.toWeb(Readable.from(Buffer.from(input.bytes)));
    return this.createFile(actor, { name: input.name, mime: input.mime, body: stream as ReadableStream<Uint8Array> });
  }

  private bindAttachments(actor: Agent, messageId: string, ids: string[]) {
    for (const id of ids) {
      const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
        | { id: string; message_id: string | null; created_by: string }
        | undefined;
      if (!row) throw new HiveError(404, "Attachment not found");
      if (row.created_by !== actor.id) throw new HiveError(403, "Attachment is not yours");
      if (row.message_id) throw new HiveError(409, "Attachment already sent");
      this.db.prepare("UPDATE attachments SET message_id = ? WHERE id = ?").run(messageId, id);
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

  gcFiles(): { attachments: number; blobs: number } {
    const cutoff = now() - 24 * 60 * 60 * 1000;
    const orphans = this.db.prepare(
      "SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?",
    ).all(cutoff) as { id: string }[];
    for (const row of orphans) {
      this.db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
    }
    const used = new Set(
      (this.db.prepare("SELECT DISTINCT sha256 AS h FROM attachments").all() as { h: string }[]).map((r) => r.h),
    );
    return { attachments: orphans.length, blobs: removeOrphanBlobs(used, this.home) };
  }

  toggleReaction(actor: Agent, seq: number, emoji: string): { message: Message; added: boolean } {
    if (!REACTION_EMOJIS.includes(emoji as (typeof REACTION_EMOJIS)[number])) {
      throw new HiveError(400, "Unsupported reaction");
    }
    const row = this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(seq) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    const msg = this.mapMessage(row);
    const ch = this.getChannel(msg.channelId);
    if (!this.canSeeChannel(actor, ch) || !this.canPost(actor, ch)) {
      throw new HiveError(403, "Cannot react here");
    }
    const existing = this.db.prepare(
      "SELECT emoji FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?",
    ).get(msg.id, actor.id, emoji);
    if (existing) {
      this.db.prepare("DELETE FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?").run(
        msg.id,
        actor.id,
        emoji,
      );
      const forUi = this.decorate([msg], HUMAN_ID)[0]!;
      this.bus.emit("reaction", { seq: msg.seq, message: forUi });
      return { message: this.decorate([msg], actor.id)[0]!, added: false };
    }
    this.db.prepare("INSERT INTO reactions (message_id, agent_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(
      msg.id,
      actor.id,
      emoji,
      now(),
    );
    const forUi = this.decorate([msg], HUMAN_ID)[0]!;
    this.bus.emit("reaction", { seq: msg.seq, message: forUi });
    return { message: this.decorate([msg], actor.id)[0]!, added: true };
  }

  private decorate(messages: Message[], actorId?: string): Message[] {
    if (messages.length === 0) return messages;
    const ids = messages.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const atts = this.db.prepare(
      `SELECT id, message_id, name, mime, bytes FROM attachments WHERE message_id IN (${placeholders})`,
    ).all(...ids) as { id: string; message_id: string; name: string; mime: string; bytes: number }[];
    const reacts = this.db.prepare(
      `SELECT message_id, emoji, agent_id FROM reactions WHERE message_id IN (${placeholders})`,
    ).all(...ids) as { message_id: string; emoji: string; agent_id: string }[];
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
