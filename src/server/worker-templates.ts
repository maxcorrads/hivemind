import type { z } from "zod";
import { HiveError, type Agent } from "../shared/types.ts";
import { buildLaunchCommand } from "../shared/launch-prompt.ts";
import { ACCOUNT_ERRORS, accountDriverForSoftware, accountEnvironmentConflict, toLaunchAccount } from "../shared/accounts.ts";
import {
  createWorkerTemplateSchema, updateWorkerTemplateSchema, WORKER_TEMPLATE_LIMITS,
  type WorkerTemplate, type WorkerTemplateSpec,
} from "../shared/worker-templates.ts";
import type { AccountStore } from "./accounts.ts";
import type { HostCatalog } from "./host-catalog.ts";
import type { Core } from "./services/ports.ts";

type Row = { id: string; project_id: string; slug: string; revision: number; spec: string; created_at: number; updated_at: number };

export type WorkerTemplateDeps = Core & {
  readonly identity: { templateWorkerCount(templateId: string): number };
  readonly launcherQueue: { hasActiveTemplateRequests(templateId: string): boolean };
  readonly accounts: Pick<AccountStore, "list">;
  readonly hosts: Pick<HostCatalog, "get">;
};

/** Field paths and reasons, never values: a template's environment may hold anything Human typed. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const reasons = result.error.issues.slice(0, 6).map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`);
  throw new HiveError(400, `Invalid worker template: ${reasons.join("; ")}`);
}

/** The launch builder must accept the template as it will when a brain launches it. */
function assertLaunchable(spec: WorkerTemplateSpec, accounts: WorkerTemplateDeps["accounts"]): void {
  try {
    buildLaunchCommand({ software: spec.software, model: spec.model, effort: spec.effort, extraFlags: spec.extraFlags,
      workspacePath: null, cdWorktree: false, projectSlug: "project", passProject: true, role: "worker",
      seniority: spec.seniority, focus: spec.focus || null, adoptUntrusted: true });
  } catch (error) {
    throw new HiveError(400, `Invalid worker template: ${(error as Error).message}`);
  }
  assertAccountFits(spec, accounts);
}

/** A pinned account must exist, belong to Software's driver, and keep the template's variables and secrets clear of it. */
function assertAccountFits(spec: WorkerTemplateSpec, accounts: WorkerTemplateDeps["accounts"]): void {
  if (!spec.accountId) return;
  const account = accounts.list().accounts.find(candidate => candidate.id === spec.accountId);
  if (!account) throw new HiveError(400, `${ACCOUNT_ERRORS.unknown}: the pinned account does not exist`);
  if (accountDriverForSoftware(spec.software) !== account.driver) {
    throw new HiveError(400, `${ACCOUNT_ERRORS.driverMismatch}: Pin an account only when Software is exactly codex or claude.`);
  }
  const conflict = accountEnvironmentConflict(spec.environment, spec.secretNames, toLaunchAccount(account));
  if (conflict) throw new HiveError(400, `${ACCOUNT_ERRORS.conflict}: ${conflict}`);
}

/**
 * A host chosen for the template must be one Server.app reported (docs/remote-hosts.md#launch). A template that keeps
 * the host it had saves as before even when that host is gone: its launches then wait and name the host.
 */
function assertHostKnown(spec: WorkerTemplateSpec, hosts: WorkerTemplateDeps["hosts"], previous?: string | null): void {
  if (!spec.hostId || spec.hostId === previous) return;
  if (!hosts.get(spec.hostId)) throw new HiveError(400, "Invalid worker template: hostId: the host does not exist");
}

/** Human-only CRUD of a project's worker templates, with revision checks. */
export class WorkerTemplateStore {
  constructor(private readonly deps: WorkerTemplateDeps) {}

  private get db() { return this.deps.storage.db; }

  private view(row: Row): WorkerTemplate {
    return { id: row.id, projectId: row.project_id, slug: row.slug, revision: row.revision, createdAt: row.created_at,
      updatedAt: row.updated_at, spec: JSON.parse(row.spec) as WorkerTemplateSpec };
  }

  private human(actor: Agent) {
    if (actor.role !== "human") throw new HiveError(403, "Only Human manages worker templates");
  }

  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM worker_templates WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError(404, "Worker template not found");
    return row;
  }

  private slugTaken(projectId: string, slug: string, except?: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM worker_templates WHERE project_id = ? AND slug = ? AND id IS NOT ?").get(projectId, slug, except ?? null));
  }

  private changed(projectId: string) {
    this.deps.storage.afterCommit(() => this.deps.bus.emit("worker-templates", { projectId }));
  }

  list(projectId: string): WorkerTemplate[] {
    return (this.db.prepare("SELECT * FROM worker_templates WHERE project_id = ? ORDER BY slug").all(projectId) as Row[]).map(row => this.view(row));
  }

  get(id: string): WorkerTemplate {
    return this.view(this.row(id));
  }

  create(actor: Agent, projectId: string, raw: unknown): WorkerTemplate {
    this.human(actor);
    const input = parse(createWorkerTemplateSchema, raw);
    assertLaunchable(input.spec, this.deps.accounts);
    assertHostKnown(input.spec, this.deps.hosts);
    return this.deps.storage.transaction(() => {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM worker_templates WHERE project_id = ?").get(projectId) as { n: number }).n);
      if (count >= WORKER_TEMPLATE_LIMITS.perProject) throw new HiveError(429, `A project has at most ${WORKER_TEMPLATE_LIMITS.perProject} worker templates`);
      if (this.slugTaken(projectId, input.slug)) throw new HiveError(409, `A worker template named ${input.slug} already exists`);
      const id = crypto.randomUUID(), at = Date.now();
      this.db.prepare("INSERT INTO worker_templates (id, project_id, slug, revision, spec, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
        .run(id, projectId, input.slug, JSON.stringify(input.spec), at, at);
      this.changed(projectId);
      return this.get(id);
    });
  }

  update(actor: Agent, id: string, raw: unknown): WorkerTemplate {
    this.human(actor);
    const input = parse(updateWorkerTemplateSchema, raw);
    assertLaunchable(input.spec, this.deps.accounts);
    return this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (row.revision !== input.expectedRevision) throw new HiveError(409, "The worker template changed; reload it before saving");
      assertHostKnown(input.spec, this.deps.hosts, (JSON.parse(row.spec) as WorkerTemplateSpec).hostId);
      const slug = input.slug ?? row.slug;
      if (this.slugTaken(row.project_id, slug, id)) throw new HiveError(409, `A worker template named ${slug} already exists`);
      this.db.prepare("UPDATE worker_templates SET slug = ?, spec = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(slug, JSON.stringify(input.spec), Date.now(), id);
      this.changed(row.project_id);
      return this.get(id);
    });
  }

  delete(actor: Agent, id: string, expectedRevision: number): void {
    this.human(actor);
    this.deps.storage.transaction(() => {
      const row = this.row(id);
      if (row.revision !== expectedRevision) throw new HiveError(409, "The worker template changed; reload it before deleting");
      if (this.deps.identity.templateWorkerCount(id) > 0 || this.deps.launcherQueue.hasActiveTemplateRequests(id))
        throw new HiveError(409, "Worker template has active workers or pending launches");
      this.db.prepare("DELETE FROM worker_templates WHERE id = ?").run(id);
      this.changed(row.project_id);
    });
  }

  /** Inside the project-deletion transaction. */
  purgeProject(projectId: string): void {
    this.db.prepare("DELETE FROM worker_templates WHERE project_id = ?").run(projectId);
  }
}
