import { HiveError, HUMAN_ID, type Agent, type Project } from "../../shared/types.ts";
import { canonicalWorktree, parseProjectSlug } from "../../shared/project.ts";
import type { Core } from "./ports.ts";
import { now, type ProjectRow } from "./rows.ts";

export type ProjectServiceDeps = Core & {
  readonly telegramAdmin: { purgeProject(projectId: string, channelIds: string[], extraChatId?: number | null): void };
  readonly files: { deleteUnsentBy(agentId: string): void; collectUnusedBlobs(): number };
  readonly channels: { ensureBuiltinChannels(project: Project): void; addHumanToAllChannels(): void };
  /** Brains/workers of the project that are online or blocked in a wait. */
  readonly identity: { busyAgents(projectId: string): Agent[] };
};

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    worktree: row.worktree,
    createdAt: row.created_at,
  };
}

/** Projects: lookup, the actor's project scope, and the Human-only lifecycle (create/edit/delete). */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  private get db() { return this.deps.storage.db; }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC, slug ASC").all() as ProjectRow[]).map(mapProject);
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new HiveError(404, "Project not found");
    return mapProject(row);
  }

  getProjectBySlug(slug: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(parseProjectSlug(slug)) as
      | ProjectRow
      | undefined;
    if (!row) throw new HiveError(404, `No project named ${slug}`);
    return mapProject(row);
  }

  findProjectBySlug(slug: string): Project | null {
    try {
      return this.getProjectBySlug(slug);
    } catch (err) {
      if (err instanceof HiveError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  /** The project slug for a project id, or null (e.g. a legacy agent without one). */
  slugOf(projectId: string): string | null {
    const row = this.db.prepare("SELECT slug FROM projects WHERE id = ?").get(projectId) as { slug: string } | undefined;
    return row?.slug ?? null;
  }

  private byIdOrSlug(projectRef: string): Project {
    const byId = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectRef) as ProjectRow | undefined;
    if (byId) return mapProject(byId);
    return this.getProjectBySlug(projectRef);
  }

  requireActorProject(actor: Agent, projectRef?: string | null): Project {
    if (actor.role === "human") {
      if (projectRef) return this.byIdOrSlug(projectRef);
      throw new HiveError(400, "Pass project");
    }
    if (!actor.projectId) throw new HiveError(409, `${actor.name} has no project`);
    if (projectRef) {
      const wanted = this.byIdOrSlug(projectRef);
      if (wanted.id !== actor.projectId) {
        throw new HiveError(403, `${actor.name} cannot use project ${wanted.slug}`);
      }
      return wanted;
    }
    return this.getProject(actor.projectId);
  }

  /** The project a search runs in: Human names one; agents default to (and are confined to) theirs. */
  searchProject(actor: Agent, slug?: string | null): Project {
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

  createProject(
    actor: Agent,
    input: { name: string; slug?: string; worktree?: string | null },
  ): Project {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can create projects");
    const name = input.name.trim();
    if (!name) throw new HiveError(400, "Project name required");
    const slug = parseProjectSlug(input.slug?.trim() || name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
    const id = crypto.randomUUID();
    return this.deps.storage.transaction(() => {
      const exists = this.db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
      if (exists) throw new HiveError(409, `Project ${slug} already exists`);
      this.db.prepare("INSERT INTO projects (id, slug, name, worktree, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        slug,
        name.slice(0, 80),
        canonicalWorktree(input.worktree),
        now(),
      );
      this.deps.channels.ensureBuiltinChannels(this.getProject(id));
      this.deps.channels.addHumanToAllChannels();
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

  /** Deletes a project and everything scoped to it, refusing while any of its agents is online or waiting. */
  deleteProject(actor: Agent, slug: string, opts: { telegramChatId?: number | null } = {}): void {
    if (actor.role !== "human") throw new HiveError(403, "Only Human can delete projects");
    const project = this.getProjectBySlug(slug);
    const { storage, telegramAdmin: telegram, files, identity: agents } = this.deps;

    storage.transaction(() => {
      const busy = agents.busyAgents(project.id);
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
      telegram.purgeProject(project.id, channelIds, opts.telegramChatId);

      if (channelIds.length > 0) {
        const ph = channelIds.map(() => "?").join(",");
        this.db.prepare(
          `DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (${ph}))`,
        ).run(...channelIds);
        this.db.prepare(
          `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (${ph}))`,
        ).run(...channelIds);
        for (const table of ["task_records", "notification_subscriptions", "threads", "bot_events", "reads", "channel_members", "messages"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE channel_id IN (${ph})`).run(...channelIds);
        }
        this.db.prepare(`DELETE FROM channels WHERE id IN (${ph})`).run(...channelIds);
      }

      for (const agent of goneAgents) {
        this.db.prepare("DELETE FROM channel_members WHERE agent_id = ?").run(agent.id);
        this.db.prepare("DELETE FROM reads WHERE agent_id = ?").run(agent.id);
        this.db.prepare("DELETE FROM reactions WHERE agent_id = ?").run(agent.id);
        files.deleteUnsentBy(agent.id);
        this.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
      }

      this.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    });

    try {
      files.collectUnusedBlobs();
    } catch {
      /* sweep can drop leftover blobs later */
    }
    this.deps.bus.emit("project", { deleted: project.slug });
  }
}
