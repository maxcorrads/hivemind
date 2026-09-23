import type { SQLInputValue } from "node:sqlite";
import { DEFAULT_PROJECT_SLUG, HiveError, HUMAN_ID, type Agent, type Channel, type ChannelType, type Project } from "../../shared/types.ts";
import { channelInputSchema, validated } from "../../shared/api-contract.ts";
import type { AgentDirectory, ChannelAccess, Core, MessagePoster, ProjectDirectory } from "./ports.ts";
import { now, type ChannelRow } from "./rows.ts";

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

export type ChannelServiceDeps = Core & {
  readonly projects: Pick<ProjectDirectory, "requireActorProject"> & { slugOf(projectId: string): string | null };
  readonly agents: AgentDirectory;
  readonly messages: Pick<MessagePoster, "postMessage">;
};

/** Channels, DMs and membership, plus the visibility/post rules every other service checks. */
export class ChannelService implements ChannelAccess {
  constructor(private readonly deps: ChannelServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  /** Creates (or adopts) a project's #general and #brains, with Human as a member. */
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

  /** Channels of a project with their type (join adds a new agent to the ones its role may see). */
  channelsOfProject(projectId: string): Array<{ id: string; type: ChannelType }> {
    return this.db.prepare("SELECT id, type FROM channels WHERE project_id = ?").all(projectId) as Array<{ id: string; type: ChannelType }>;
  }

  generalChannelId(projectId: string): string | null {
    const general = this.db.prepare(
      "SELECT id FROM channels WHERE project_id = ? AND lower(name) = 'general'",
    ).get(projectId) as { id: string } | undefined;
    return general?.id ?? null;
  }

  /** Constant-parameter authorization scope, shared by lists and inbox reads. */
  visibleChannelScope(actor: Agent): { sql: string; args: SQLInputValue[] } {
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
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      topic: row.topic,
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberIds: members.map((m) => m.agent_id),
      projectId: row.project_id,
      project: this.deps.projects.slugOf(row.project_id) ?? DEFAULT_PROJECT_SLUG,
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
    const { storage, bus, agents, messages } = this.deps;
    const project = this.deps.projects.requireActorProject(actor, input.project);
    const slug = slugify(input.name);
    if (!slug) throw new HiveError(400, "Invalid channel name");
    return storage.transaction(() => {
      const exists = this.db.prepare(
        "SELECT id FROM channels WHERE project_id = ? AND lower(name) = ?",
      ).get(project.id, slug);
      if (exists) throw new HiveError(409, `#${slug} already exists`);
      const id = crypto.randomUUID();
      this.db.prepare(
        `INSERT INTO channels (id, name, type, topic, created_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, slug, input.type, input.topic ?? null, actor.id, now(), project.id);
      this.addMember(id, HUMAN_ID);
      const roster = agents.listAgents().filter((a) => a.role === "human" || a.projectId === project.id);
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
          const m = agents.getAgentByName(name);
          if (m && (m.role === "human" || m.projectId === project.id)) this.addMember(id, m.id);
        }
      }
      const ch = this.getChannel(id);
      storage.afterCommit(() => bus.emit("channel", ch));
      messages.postMessage(agents.getAgent(HUMAN_ID), { channel: id, body: `${actor.name} created #${slug}`, kind: "system" });
      return this.getChannel(id);
    });
  }

  openDm(actor: Agent, otherName: string): Channel {
    const other = this.deps.agents.getAgentByName(otherName);
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
      this.deps.storage.afterCommit(() => this.deps.bus.emit("channel", ch));
      return ch;
    };
    // Nests as a savepoint inside a caller's transaction (e.g. TaskStore.assign); the event waits for its commit.
    return this.deps.storage.transaction(create);
  }

  findDm(a: string, b: string): Channel | null {
    const [x, y] = [a, b].sort();
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(`dm:${x}:${y}`) as
      | ChannelRow
      | undefined;
    return row ? this.mapChannel(row) : null;
  }

  invite(actor: Agent, channelRef: string, memberNames: string[]): Channel {
    if (actor.role === "worker" || actor.role === "bot") throw new HiveError(403, "Workers and bots cannot invite");
    if (memberNames.length === 0) throw new HiveError(400, "No members to invite");
    const ch = this.getChannel(channelRef, actor.projectId);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access channel");
    if (ch.type === "dm") throw new HiveError(400, "Cannot invite to a DM");
    const { storage, bus, agents, messages } = this.deps;
    return storage.transaction(() => {
      const added: string[] = [];
      for (const name of memberNames) {
        const member = agents.getAgentByName(name);
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
      storage.afterCommit(() => bus.emit("channel", this.getChannel(ch.id)));
      messages.postMessage(agents.getAgent(HUMAN_ID), { channel: ch.id, body: `${actor.name} invited ${added.join(", ")}`, kind: "system" });
      return this.getChannel(ch.id);
    });
  }
}
