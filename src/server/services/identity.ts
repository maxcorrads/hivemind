import { createHash, randomBytes } from "node:crypto";
import { HiveError, HUMAN_ID, HUMAN_NAME, PRESENCE_IDLE_MS, type Agent, type ChannelType, type Project, type Seniority } from "../../shared/types.ts";
import { joinInputSchema, validated } from "../../shared/api-contract.ts";
import { canonicalWorktree, resolveJoinProject } from "../../shared/project.ts";
import { pickName } from "../names.ts";
import type { AgentDirectory, Core, MessagePoster, WaiterRegistry } from "./ports.ts";
import { now, type AgentRow } from "./rows.ts";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `hm_${randomBytes(24).toString("hex")}`;
}

export function describeAgent(agent: Agent): string {
  if (agent.role === "human") return "Human";
  if (agent.role === "bot") return "bot (context only)";
  if (agent.role === "brain") return agent.focus ? `brain (${agent.focus})` : "brain";
  const sen = agent.seniority ?? "mid";
  return agent.focus ? `${sen} worker (${agent.focus})` : `${sen} worker`;
}

export type JoinInput = {
  role: "brain" | "worker";
  seniority?: Seniority | null;
  focus?: string | null;
  token?: string | null;
  resumeName?: string | null;
  project?: string | null;
  cwd?: string | null;
};

export type IdentityServiceDeps = Core & {
  readonly projects: {
    listProjects(): Project[];
    getProjectBySlug(slug: string): Project;
    slugOf(projectId: string): string | null;
  };
  readonly channels: {
    addMember(channelId: string, agentId: string): void;
    channelsOfProject(projectId: string): Array<{ id: string; type: ChannelType }>;
    generalChannelId(projectId: string): string | null;
  };
  readonly messages: Pick<MessagePoster, "postMessage" | "postSystem">;
  readonly files: { deleteUnsentBy(agentId: string): void };
  readonly waiters: WaiterRegistry & { evict(agentId: string): void };
};

/**
 * Agent identity and sessions: the Human row, brain/worker join and resume (a
 * resume issues a new session key and fences the previous session), lookups,
 * presence (heartbeats and the idle sweep) and removal.
 */
export class IdentityService implements AgentDirectory {
  constructor(private readonly deps: IdentityServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  /** Creates the local Human identity on first start. */
  ensureHuman(): void {
    const existing = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(HUMAN_ID);
    if (existing) return;
    const t = now();
    this.db.prepare(
      `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor)
       VALUES (?, ?, 'human', NULL, NULL, ?, 1, ?, ?, 0)`,
    ).run(HUMAN_ID, HUMAN_NAME, hashToken("human-local"), t, t);
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

  /** The current session-key hash: it changes when the agent resumes or a bot credential rotates. */
  sessionFingerprint(agentId: string): string | undefined {
    return (this.db.prepare("SELECT token_hash FROM agents WHERE id=?").get(agentId) as { token_hash: string } | undefined)?.token_hash;
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
    return this.agentFromRow(row, row.project_id ? this.deps.projects.slugOf(row.project_id) : null);
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

  /** Brains/workers of a project that are online or blocked in a wait. */
  busyAgents(projectId: string): Agent[] {
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND id != ? AND role != 'human'",
    ).all(projectId, HUMAN_ID) as AgentRow[];
    return rows.map((row) => this.mapAgent(row)).filter((agent) => agent.online || this.deps.waiters.has(agent.id));
  }

  private assertSameProject(agent: Agent, project: Project) {
    if (agent.role === "human") return;
    if (agent.project && agent.project !== project.slug) {
      throw new HiveError(409, `${agent.name} is in ${agent.project}; project cannot change`);
    }
  }

  join(input: JoinInput): { agent: Agent; token: string; created: boolean } {
    validated(joinInputSchema, input);
    if (input.role !== "brain" && input.role !== "worker") {
      throw new HiveError(400, "role must be brain or worker");
    }
    const { storage, projects } = this.deps;
    const assertResumable = (agent: Agent) => {
      if (agent.role !== input.role) {
        throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
      }
      if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
        throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
      }
      if (input.project) this.assertSameProject(agent, projects.getProjectBySlug(input.project));
      else if (input.cwd) {
        const cwd = canonicalWorktree(input.cwd);
        const worktree = projects.listProjects().find(project => project.worktree && canonicalWorktree(project.worktree) === cwd);
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
      return storage.transaction(() => {
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

    const project = resolveJoinProject(projects.listProjects(), { project: input.project, cwd: input.cwd });
    return storage.transaction(() => {
      const { channels, messages, bus } = this.deps;
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

      for (const ch of channels.channelsOfProject(project.id)) {
        if (ch.type === "public") channels.addMember(ch.id, id);
        if (ch.type === "brains" && input.role === "brain") channels.addMember(ch.id, id);
      }

      const agent = this.getAgent(id);
      const general = channels.generalChannelId(project.id);
      if (general) {
        messages.postMessage(this.getAgent(HUMAN_ID), { channel: general, body: `${agent.name} has joined as ${describeAgent(agent)}.`, kind: "system" });
      }
      const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get() as { n: number };
      this.db.prepare("UPDATE agents SET inbox_cursor = ? WHERE id = ?").run(maxSeq.n, id);
      storage.afterCommit(() => bus.emit("agent", agent));
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
    this.deps.storage.afterCommit(() => this.deps.waiters.supersede(agentId));
    return token;
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
    if (stateChanged) this.deps.storage.afterCommit(() => this.deps.bus.emit("agent", this.getAgent(agentId)));
  }

  setOffline(agentId: string) {
    if (agentId === HUMAN_ID) return;
    this.touch(agentId, false);
  }

  /** Marks idle brains/workers offline; an agent blocked in a wait counts as present. */
  sweepPresence(maxIdleMs = PRESENCE_IDLE_MS) {
    const cutoff = now() - maxIdleMs;
    const rows = this.db.prepare(
      `SELECT id FROM agents WHERE role != 'human' AND online = 1 AND last_seen_at < ?`,
    ).all(cutoff) as { id: string }[];
    for (const r of rows) {
      if (this.deps.waiters.has(r.id)) {
        this.touch(r.id, true);
        continue;
      }
      this.setOffline(r.id);
    }
  }

  removeAgent(actor: Agent, name: string): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can remove agents");
    const target = this.getAgentByName(name);
    if (!target) throw new HiveError(404, `No agent named ${name}`);
    if (target.id === HUMAN_ID || target.role === "human") {
      throw new HiveError(403, "Cannot remove Human");
    }
    const { waiters, files, channels, messages, bus } = this.deps;
    waiters.evict(target.id);
    this.db.prepare("DELETE FROM channel_members WHERE agent_id = ?").run(target.id);
    this.db.prepare("DELETE FROM reads WHERE agent_id = ?").run(target.id);
    this.db.prepare("DELETE FROM reactions WHERE agent_id = ?").run(target.id);
    files.deleteUnsentBy(target.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(target.id);
    if (target.projectId) {
      const general = channels.generalChannelId(target.projectId);
      if (general) messages.postSystem(general, `${actor.name} removed ${target.name} from the hive.`);
    }
    bus.emit("project", { removed: target.name });
    return target;
  }
}
