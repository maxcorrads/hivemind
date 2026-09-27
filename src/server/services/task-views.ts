import { z } from 'zod';
import { HiveError, type Agent } from '../../shared/types.ts';
import { taskViewsListSchema, type TaskOverview, type TaskViewsListInput, type TaskViewsPage } from '../../shared/task-views.ts';
import type { JobStore } from './jobs.ts';
import type { TaskStore } from '../tasks.ts';
import type { AgentDirectory, Core } from './ports.ts';

type Deps = Core & { identity: Pick<AgentDirectory, 'getAgent'>; tasks: Pick<TaskStore, 'view'>;
  jobs: Pick<JobStore, 'get'> };
type TaskRow = { id: string; updated_at: number; project_id: string; project_slug: string };
type Cursor = { v: 1; updatedAt: number; id: string; projectId: string | null };
const cursorSchema = z.object({ v: z.literal(1), updatedAt: z.number().int().nonnegative().safe(),
  id: z.string().uuid(), projectId: z.string().uuid().nullable() }).strict();
const templateSnapshotSchema = z.object({ id: z.string().uuid(), label: z.string().min(1) }).passthrough();

function assertHuman(actor: Agent): void {
  if (actor.role !== 'human') throw new HiveError(403, 'Only Human reads cross-project task views');
}

function decodeCursor(raw: string, projectId: string | null): Cursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw new HiveError(400, 'Invalid task cursor');
  try {
    const value = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (Buffer.from(JSON.stringify(value)).toString('base64url') !== raw || value.projectId !== projectId)
      throw new Error('Cursor does not match the project filter');
    return value;
  } catch {
    throw new HiveError(400, 'Invalid task cursor');
  }
}

function encodeCursor(row: TaskRow, projectId: string | null): string {
  return Buffer.from(JSON.stringify({ v: 1, updatedAt: row.updated_at, id: row.id, projectId })).toString('base64url');
}

/** Human-only task history across channels; reads one coherent SQLite snapshot per request. */
export class TaskViews {
  constructor(private readonly deps: Deps) {}
  private get db() { return this.deps.storage.db; }

  list(actor: Agent, raw: TaskViewsListInput = {}): TaskViewsPage {
    assertHuman(actor);
    const parsed = taskViewsListSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError(400, 'Invalid task list filter');
    const { projectId, cursor: rawCursor, limit = 50 } = parsed.data;
    const scope = projectId ?? null;
    const cursor = rawCursor ? decodeCursor(rawCursor, scope) : null;
    return this.deps.storage.transaction(() => {
      // Channel scope is applied before the page limit; every task belongs to its channel's real project.
      const rows = this.db.prepare(`SELECT t.id, COALESCE(CAST(json_extract(t.snapshot,'$.updatedAt') AS INTEGER),0) AS updated_at,
          p.id AS project_id, p.slug AS project_slug
        FROM task_records t JOIN channels c ON c.id=t.channel_id JOIN projects p ON p.id=c.project_id
        WHERE (? IS NULL OR p.id=?)
          AND (? IS NULL OR COALESCE(CAST(json_extract(t.snapshot,'$.updatedAt') AS INTEGER),0) < ?
            OR (COALESCE(CAST(json_extract(t.snapshot,'$.updatedAt') AS INTEGER),0)=? AND t.id<?))
        ORDER BY updated_at DESC,t.id DESC LIMIT ?`)
        .all(scope, scope, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null,
          cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1) as TaskRow[];
      const page = rows.slice(0, limit);
      const items = page.map(row => this.overview(actor, row));
      const jobIds = [...new Set(items.map(item => item.task.jobId).filter((id): id is string => Boolean(id)))];
      const jobs = (this.db.prepare(`SELECT j.id FROM jobs j WHERE (? IS NULL OR j.project_id=?)
        AND (j.id IN (SELECT value FROM json_each(?)) OR (j.state='active' AND NOT EXISTS
          (SELECT 1 FROM task_records t WHERE t.job_id=j.id)))
        ORDER BY j.updated_at DESC,j.id DESC`).all(scope, scope, JSON.stringify(jobIds)) as { id: string }[])
        .map(row => this.deps.jobs.get(actor, row.id));
      return { items, jobs, hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!, scope) : null };
    }, { immediate: false });
  }

  get(actor: Agent, taskId: string): TaskOverview {
    assertHuman(actor);
    if (!z.string().uuid().safeParse(taskId).success) throw new HiveError(400, 'Invalid task id');
    return this.deps.storage.transaction(() => {
      const row = this.db.prepare(`SELECT t.id, COALESCE(CAST(json_extract(t.snapshot,'$.updatedAt') AS INTEGER),0) AS updated_at,
          p.id AS project_id, p.slug AS project_slug
        FROM task_records t JOIN channels c ON c.id=t.channel_id JOIN projects p ON p.id=c.project_id
        WHERE t.id=?`).get(taskId) as TaskRow | undefined;
      if (!row) throw new HiveError(404, 'Task not found');
      return this.overview(actor, row);
    }, { immediate: false });
  }

  private overview(actor: Agent, row: TaskRow): TaskOverview {
    const task = this.deps.tasks.view(actor, row.id);
    const worker = this.deps.identity.getAgent(task.workerId);
    const brain = this.deps.identity.getAgent(task.assignerId);
    const saved = this.db.prepare(`SELECT r.template_snapshot,
      (SELECT k.state FROM launcher_commands k WHERE k.request_id=r.id AND k.kind='kill'
        ORDER BY k.rowid DESC LIMIT 1) AS kill_state
      FROM launch_requests r WHERE r.task_id=? AND r.agent_id=?
      ORDER BY r.requested_at DESC,r.rowid DESC LIMIT 1`).get(task.id, task.workerId) as
      { template_snapshot: string; kill_state: string | null } | undefined;
    let template: TaskOverview['template'] = null;
    if (saved) {
      try {
        const parsed = templateSnapshotSchema.safeParse(JSON.parse(saved.template_snapshot));
        if (parsed.success) template = { id: parsed.data.id, label: parsed.data.label };
      } catch { /* The live template remains a best-effort fallback for a corrupt legacy snapshot. */ }
    }
    if (!template && worker.templateId) {
      const live = this.db.prepare('SELECT id,spec FROM worker_templates WHERE id=?').get(worker.templateId) as
        { id: string; spec: string } | undefined;
      if (live) {
        try {
          const spec = z.object({ label: z.string().min(1) }).passthrough().safeParse(JSON.parse(live.spec));
          if (spec.success) template = { id: live.id, label: spec.data.label };
        } catch { /* Historical task remains readable after template corruption or deletion. */ }
      }
    }
    const hardPause = task.state === 'paused' && task.pause?.mode === 'hard';
    const retryClose = Boolean(hardPause && task.pause?.stopRequestedAt &&
      saved?.kill_state === 'failed');
    let resume = task.state === 'paused' && task.pause?.mode === 'soft';
    if (hardPause && task.pause?.closedAt && !task.pause.resumeRequestId) {
      const unsafe = this.db.prepare(`SELECT 1 FROM launch_requests r WHERE r.agent_id=? AND r.session IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM launcher_commands k WHERE k.request_id=r.id AND k.kind='kill' AND k.state='done')
        LIMIT 1`).get(task.workerId);
      resume = !unsafe;
    }
    return { task, projectId: row.project_id, project: row.project_slug, worker, brain, template,
      controls: { retryClose, resume } };
  }
}
