import { createHash, randomBytes } from "node:crypto";
import { HiveError, HUMAN_ID, HUMAN_NAME, PRESENCE_IDLE_MS, RESERVATION_MS, type Agent, type ChannelType, type Project, type Seniority } from "../../shared/types.ts";
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
  /** The Hivemind tmux session the joining process runs in; null or absent clears the agent's label. */
  terminalSession?: string | null;
  /** A reserved worker's single-use launch ticket (reserve): joins as that worker. */
  claim?: string | null;
};

/** What reserve() needs of a worker template. */
export type ReservationTemplate = {
  id: string;
  projectId: string;
  slug: string;
  spec: { enabled: boolean; seniority: Seniority; focus: string; maxConcurrent: number };
};

/** A name part from free text: lowercase letters, digits and single dashes, at most 24 characters. */
export function nameSlug(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
}

/** A launch ticket: shown once, stored as its hash. */
function newClaimTicket(): string {
  return `hmc_${randomBytes(24).toString("hex")}`;
}

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
  readonly waiters: WaiterRegistry;
  readonly lifecycle: { removeAgent(actor: Agent, name: string): Agent; expireReservation(agentId: string): void };
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
    ).run(HUMAN_ID, HUMAN_NAME, hashToken(newToken()), t, t);
  }

  /** The agent, including a removed one (a tombstone keeps its history readable). */
  getAgent(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) throw new HiveError(404, "Agent not found");
    return this.mapAgent(row);
  }

  /** The agent, or null when it does not exist (e.g. removed since it was referenced). */
  findAgent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? this.mapAgent(row) : null;
  }

  /** The agent when it exists and was not removed. */
  findActiveAgent(id: string): Agent | null {
    const agent = this.findAgent(id);
    return agent && agent.removedAt === undefined && agent.archivedAt === undefined ? agent : null;
  }

  /** Ids of a project's workers (removed ones excluded). */
  projectWorkerIds(projectId: string): string[] {
    return (this.db.prepare("SELECT id FROM agents WHERE project_id = ? AND role = 'worker' AND removed_at IS NULL AND archived_at IS NULL")
      .all(projectId) as { id: string }[])
      .map((row) => row.id);
  }

  /** An agent that can still be addressed by name; removed agents are not found. */
  getAgentByName(name: string): Agent | null {
    const agent = this.findAgentByName(name);
    return agent && agent.removedAt === undefined && agent.archivedAt === undefined ? agent : null;
  }

  /** Any agent holding the name, including a removed one: removed names stay reserved. */
  findAgentByName(name: string): Agent | null {
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
    const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ? AND removed_at IS NULL AND archived_at IS NULL").get(hashToken(token)) as
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
      ...(row.removed_at != null ? { removedAt: row.removed_at } : {}),
      ...(row.archived_at != null ? { archivedAt: row.archived_at } : {}),
      ...(row.role === "brain" ? { launchMode: row.launch_mode } : {}),
      ...(row.terminal_session ? { terminalSession: row.terminal_session } : {}),
      ...(row.pending_until != null && row.removed_at == null ? { pending: { until: row.pending_until,
        ...(row.reserved_by_brain_id ? { brainId: row.reserved_by_brain_id } : {}) } } : {}),
      ...(row.template_id ? { templateId: row.template_id } : {}),
    };
  }

  private mapAgent(row: AgentRow): Agent {
    return this.agentFromRow(row, row.project_id ? this.deps.projects.slugOf(row.project_id) : null);
  }

  /** The roster: agents that were not removed. */
  listAgents(viewer?: Agent): Agent[] {
    type Joined = AgentRow & { project_slug: string | null };
    const scoped = viewer && viewer.role !== "human";
    // Both OR arms have indexes. Without idx_agents_role SQLite scans all projects.
    const rows = this.db.prepare(`
      SELECT a.*, p.slug AS project_slug FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.removed_at IS NULL AND a.archived_at IS NULL
        ${scoped ? "AND (a.role = 'human' OR (a.project_id = ? AND (a.pending_until IS NULL OR EXISTS (SELECT 1 FROM launch_requests r WHERE r.agent_id=a.id AND r.brain_id=? AND r.task_id IS NOT NULL))))" : ""}
      ORDER BY a.role, a.seniority, a.name
    `).all(...(scoped ? [viewer.projectId, viewer.id] : [])) as Joined[];
    return rows.map((row) => this.agentFromRow(row, row.project_slug));
  }

  setLaunchMode(actor: Agent, name: string, mode: "approval" | "auto"): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human changes a brain's launch mode");
    return this.deps.storage.transaction(() => {
      const brain = this.getAgentByName(name);
      if (!brain || brain.role !== "brain" || brain.archivedAt !== undefined) throw new HiveError(404, "Brain not found");
      this.db.prepare("UPDATE agents SET launch_mode=? WHERE id=?").run(mode, brain.id);
      const changed = this.getAgent(brain.id);
      this.deps.storage.afterCommit(() => this.deps.bus.emit("agent", changed));
      return changed;
    });
  }

  archiveTaskWorker(agentId: string): Agent {
    return this.deps.storage.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent.role !== "worker" || !agent.templateId || agent.removedAt !== undefined) throw new HiveError(409, "Only a task-bound worker can be archived");
      if (agent.archivedAt === undefined) {
        this.db.prepare("UPDATE agents SET archived_at=?, online=0, token_hash=?, claim_hash=NULL, pending_until=NULL WHERE id=?")
          .run(now(), hashToken(newToken()), agentId);
        this.db.prepare("DELETE FROM channel_members WHERE agent_id=?").run(agentId);
        this.db.prepare("DELETE FROM notification_subscriptions WHERE agent_id=?").run(agentId);
        this.deps.storage.afterCommit(() => this.deps.waiters.supersede(agentId));
      }
      const changed = this.getAgent(agentId);
      this.deps.storage.afterCommit(() => this.deps.bus.emit("agent", changed));
      return changed;
    });
  }

  /** A confirmed native close fences the old MCP session while keeping the identity resumable. */
  suspendSession(agentId: string): Agent {
    return this.deps.storage.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent.archivedAt !== undefined || agent.removedAt !== undefined || !agent.templateId)
        throw new HiveError(409, "Only an active task-bound worker session can be suspended");
      this.db.prepare("UPDATE agents SET token_hash=?, online=0, terminal_session=NULL WHERE id=?")
        .run(hashToken(newToken()), agentId);
      const changed = this.getAgent(agentId);
      this.deps.storage.afterCommit(() => {
        this.deps.waiters.supersede(agentId);
        this.deps.bus.emit("agent", changed);
      });
      return changed;
    });
  }

  /** Brains/workers of a project that are online or blocked in a wait. */
  busyAgents(projectId: string): Agent[] {
    const rows = this.db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND id != ? AND role != 'human' AND removed_at IS NULL AND archived_at IS NULL",
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
      if (agent.archivedAt !== undefined) throw new HiveError(410, `${agent.name} was archived and cannot resume`);
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
      ? this.db.prepare("SELECT * FROM agents WHERE token_hash = ? AND removed_at IS NULL AND archived_at IS NULL")
        .get(hashToken(input.token)) as AgentRow | undefined
      : undefined;
    if (input.claim) {
      if (current) throw new HiveError(409, `This process is already ${current.name}; a launch ticket needs a new MCP process`);
      return this.claim(input, input.claim);
    }
    if (current) {
      const agent = this.mapAgent(current);
      if (input.resumeName && agent.name.toLowerCase() !== input.resumeName.toLowerCase()) {
        throw new HiveError(403, `This session is ${agent.name}, not ${input.resumeName}`);
      }
      assertResumable(agent);
      return storage.transaction(() => {
        this.touch(agent.id, true);
        this.claimTerminalSession(agent.id, input.terminalSession ?? null);
        return { agent: this.getAgent(agent.id), token: input.token!, created: false };
      });
    }
    // Brains and workers have no stored credentials: resuming by name opens a new session
    // and supersedes the previous one, whose key stops working.
    if (input.resumeName) {
      const row = this.db.prepare("SELECT * FROM agents WHERE lower(name) = lower(?) AND role IN ('brain','worker')")
        .get(input.resumeName) as AgentRow | undefined;
      if (!row) throw new HiveError(404, `No brain or worker named ${input.resumeName}; join without resume to get a new name`);
      if (row.removed_at != null) {
        throw new HiveError(410, `${row.name} was removed from the hive and cannot resume; join without resume to get a new name`);
      }
      if (row.archived_at != null) throw new HiveError(410, `${row.name} was archived and cannot resume`);
      if (row.pending_until != null) {
        throw new HiveError(409, `${row.name} has not joined yet: only its launch can join it, with its launch ticket`);
      }
      const agent = this.mapAgent(row);
      assertResumable(agent);
      // A confirmed hard stop revokes the old token. Name-based resume must not
      // bypass Human's explicit resume control while the task remains paused.
      if (agent.templateId) {
        const paused = this.db.prepare(`SELECT snapshot FROM task_records WHERE worker_id=?
          AND json_extract(snapshot,'$.state')='paused'
          AND json_extract(snapshot,'$.pause.mode')='hard' LIMIT 1`).get(agent.id) as { snapshot: string } | undefined;
        if (paused) {
          const task = JSON.parse(paused.snapshot) as { pause?: { resumeRequestId?: string } };
          const request = task.pause?.resumeRequestId ? this.db.prepare(`SELECT 1 FROM launch_requests
            WHERE id=? AND agent_id=? AND launch_kind='resume' AND state='launching' LIMIT 1`)
            .get(task.pause.resumeRequestId, agent.id) : null;
          if (!request) throw new HiveError(409, `${agent.name} is hard-paused until Human resumes its task`);
        }
      }
      return storage.transaction(() => {
        const token = this.replaceAgentSession(agent.id);
        this.touch(agent.id, true);
        this.claimTerminalSession(agent.id, input.terminalSession ?? null);
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
      this.claimTerminalSession(id, input.terminalSession ?? null, false);
      storage.afterCommit(() => bus.emit("agent", this.getAgent(id)));
      return { agent: this.getAgent(id), token, created: true };
    });
  }

  /**
   * Reserves a task-bound worker from a template: a worker row with its name, project, seniority and focus, a member of
   * the project's public channels and with its inbox starting now, so mail sent while it starts reaches it. It has no
   * session until its launch joins with the returned single-use ticket, within RESERVATION_MS.
   */
  reserve(actor: Agent, template: ReservationTemplate, label?: string | null, deferCap = false): { agent: Agent; ticket: string } {
    if (actor.role !== "human" && (actor.role !== "brain" || actor.projectId !== template.projectId))
      throw new HiveError(403, "Only Human or a brain in this project reserves a worker");
    if (!template.spec.enabled) throw new HiveError(409, `Worker template ${template.slug} is disabled`);
    const { storage, channels, bus } = this.deps;
    return storage.transaction(() => {
      const running = this.templateWorkerCount(template.id);
      if (!deferCap && running >= template.spec.maxConcurrent) {
        throw new HiveError(409, `Worker template ${template.slug} already has ${running} of at most ${template.spec.maxConcurrent} workers`);
      }
      const taken = new Set((this.db.prepare("SELECT lower(name) AS n FROM agents").all() as { n: string }[]).map((r) => r.n));
      const slug = nameSlug(label ?? "");
      const base = slug ? `${pickName("worker", taken)}-${slug}` : pickName("worker", taken);
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
      const id = crypto.randomUUID(), ticket = newClaimTicket(), t = now();
      const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get() as { n: number };
      this.db.prepare(
        `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor, project_id,
           pending_until, claim_hash, template_id, reserved_by_brain_id)
         VALUES (?, ?, 'worker', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, template.spec.seniority, template.spec.focus || null, hashToken(newToken()), t, t, maxSeq.n, template.projectId,
        t + RESERVATION_MS, hashToken(ticket), template.id, actor.role === "brain" ? actor.id : null);
      // Brain-reserved identities see only their task channel until claim; retain legacy Human reservations.
      if (actor.role === "human") for (const ch of channels.channelsOfProject(template.projectId))
        if (ch.type === "public") channels.addMember(ch.id, id);
      storage.afterCommit(() => bus.emit("agent", this.getAgent(id)));
      return { agent: this.getAgent(id), ticket };
    });
  }

  /** Active reserved or joined workers; callers subtract requests still awaiting approval for capacity. */
  templateWorkerCount(templateId: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM agents a WHERE a.template_id = ? AND a.removed_at IS NULL
      AND ((a.archived_at IS NULL AND (NOT EXISTS (SELECT 1 FROM launch_requests r WHERE r.agent_id=a.id)
        OR EXISTS (SELECT 1 FROM launch_requests r WHERE r.agent_id=a.id AND r.state IN ('approved','launching','launched'))))
        OR EXISTS (SELECT 1 FROM launch_requests r WHERE r.agent_id=a.id AND r.session IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM launcher_commands k WHERE k.request_id=r.id AND k.kind='kill' AND k.state='done')))`)
      .get(templateId) as { n: number }).n);
  }

  /** Human changes a pending worker's template before approving its launch. */
  retargetReservation(actor: Agent, agentId: string, template: ReservationTemplate): Agent {
    if (actor.role !== "human") throw new HiveError(403, "Only Human changes a reserved worker's template");
    return this.deps.storage.transaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent.pending || agent.removedAt !== undefined || agent.archivedAt !== undefined) throw new HiveError(409, "Worker is no longer pending");
      if (agent.projectId !== template.projectId || !template.spec.enabled) throw new HiveError(409, "Template must be enabled in the same project");
      this.db.prepare("UPDATE agents SET template_id = ?, seniority = ?, focus = ? WHERE id = ?")
        .run(template.id, template.spec.seniority, template.spec.focus || null, agentId);
      const changed = this.getAgent(agentId);
      this.deps.storage.afterCommit(() => this.deps.bus.emit("agent", changed));
      return changed;
    });
  }

  /** A launch joins its reserved worker with the ticket reserve() returned; the ticket works once. */
  private claim(input: JoinInput, ticket: string): { agent: Agent; token: string; created: boolean } {
    if (input.role !== "worker") throw new HiveError(400, "A launch ticket joins a worker");
    if (input.resumeName) throw new HiveError(400, "Pass a launch ticket or resume, not both");
    const row = this.db.prepare("SELECT * FROM agents WHERE claim_hash = ? AND removed_at IS NULL").get(hashToken(ticket)) as AgentRow | undefined;
    if (!row || row.archived_at != null) throw new HiveError(401, "This launch ticket is not valid: it was used, it expired, or its worker was removed");
    if (row.pending_until != null && row.pending_until < now()) {
      this.deps.lifecycle.expireReservation(row.id);
      throw new HiveError(410, `${row.name} waited too long for its launch and was withdrawn`);
    }
    const agent = this.mapAgent(row);
    if (input.seniority && input.seniority !== agent.seniority) throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
    if (input.project) this.assertSameProject(agent, this.deps.projects.getProjectBySlug(input.project));
    const { storage, channels, messages, bus } = this.deps;
    return storage.transaction(() => {
      const token = this.replaceAgentSession(agent.id);
      this.db.prepare("UPDATE agents SET pending_until = NULL, claim_hash = NULL WHERE id = ?").run(agent.id);
      this.touch(agent.id, true);
      this.claimTerminalSession(agent.id, input.terminalSession ?? null, false);
      const joined = this.getAgent(agent.id);
      for (const ch of channels.channelsOfProject(agent.projectId!)) if (ch.type === "public") channels.addMember(ch.id, agent.id);
      const general = joined.projectId ? channels.generalChannelId(joined.projectId) : null;
      if (general) {
        messages.postMessage(this.getAgent(HUMAN_ID), { channel: general, body: `${joined.name} has joined as ${describeAgent(joined)}.`, kind: "system" });
      }
      storage.afterCommit(() => bus.emit("agent", this.getAgent(agent.id)));
      return { agent: joined, token, created: true };
    });
  }

  /** Withdraws reserved workers whose launch never joined. */
  expireReservations(at = now()): void {
    const rows = this.db.prepare("SELECT id FROM agents WHERE pending_until IS NOT NULL AND pending_until < ? AND removed_at IS NULL AND archived_at IS NULL")
      .all(at) as { id: string }[];
    for (const row of rows) this.deps.lifecycle.expireReservation(row.id);
  }

  /**
   * Records the tmux session the agent's current process reported (or clears it). A session holds one agent at a
   * time, so an agent that joins from a session another agent held takes the label over. Only a label: nothing runs by it.
   */
  private claimTerminalSession(agentId: string, session: string | null, announce = true): void {
    const changed: string[] = [];
    if (session) {
      const holders = this.db.prepare("SELECT id FROM agents WHERE terminal_session = ? AND id != ?").all(session, agentId) as { id: string }[];
      this.db.prepare("UPDATE agents SET terminal_session = NULL WHERE terminal_session = ? AND id != ?").run(session, agentId);
      changed.push(...holders.map(row => row.id));
    }
    const own = this.db.prepare("UPDATE agents SET terminal_session = ? WHERE id = ? AND terminal_session IS NOT ?").run(session, agentId, session);
    if (announce && Number(own.changes) > 0) changed.push(agentId);
    if (changed.length) this.deps.storage.afterCommit(() => { for (const id of changed) this.deps.bus.emit("agent", this.getAgent(id)); });
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
      "SELECT online, last_seen_at AS lastSeenAt FROM agents WHERE id = ? AND removed_at IS NULL AND archived_at IS NULL",
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
    this.expireReservations();
    const cutoff = now() - maxIdleMs;
    const rows = this.db.prepare(
      `SELECT id FROM agents WHERE role != 'human' AND online = 1 AND last_seen_at < ? AND removed_at IS NULL AND archived_at IS NULL`,
    ).all(cutoff) as { id: string }[];
    for (const r of rows) {
      if (this.deps.waiters.has(r.id)) {
        this.touch(r.id, true);
        continue;
      }
      this.setOffline(r.id);
    }
  }

  /** Human removes an agent; see AgentLifecycle.removeAgent. */
  removeAgent(actor: Agent, name: string): Agent {
    return this.deps.lifecycle.removeAgent(actor, name);
  }

  /**
   * Inside the lifecycle transaction: turns the agent into a tombstone. It keeps its row and name (history stays
   * attributed), goes offline and gets an unguessable session key, so no earlier key authenticates it again.
   */
  markRemoved(agentId: string, at: number): void {
    this.db.prepare(`UPDATE agents SET removed_at = ?, online = 0, token_hash = ?, terminal_session = NULL, pending_until = NULL,
      claim_hash = NULL WHERE id = ? AND removed_at IS NULL`).run(at, hashToken(newToken()), agentId);
  }
}
