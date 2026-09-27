import type { JobView } from '../src/shared/jobs.ts';
import type { TaskControlInput } from '../src/shared/task-control.ts';
import type { TaskOverview, TaskViewsPage } from '../src/shared/task-views.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { AgentTrafficView } from '../src/shared/types.ts';

export type TaskGroup = { job: JobView | null; items: TaskOverview[] };

/** A later page can repeat a moved task or refreshed job; keep its newer server projection. */
export function mergeTaskPages(previous: TaskViewsPage, incoming: TaskViewsPage): TaskViewsPage {
  const items = new Map(previous.items.map(item => [item.task.id, item]));
  for (const item of incoming.items) items.set(item.task.id, item);
  const jobs = new Map(previous.jobs.map(job => [job.id, job]));
  for (const job of incoming.jobs) jobs.set(job.id, job);
  return { ...incoming, items: [...items.values()], jobs: [...jobs.values()] };
}

/** Jobs on this page, including empty active jobs, followed by work without a job. */
export function groupTaskViews(page: Pick<TaskViewsPage, 'items' | 'jobs'>): TaskGroup[] {
  const byJob = new Map(page.jobs.map(job => [job.id, { job, items: [] as TaskOverview[] }]));
  const loose: TaskOverview[] = [];
  for (const item of page.items) {
    const group = item.task.jobId ? byJob.get(item.task.jobId) : null;
    if (group) group.items.push(item);
    else loose.push(item);
  }
  return [...byJob.values(), ...(loose.length ? [{ job: null, items: loose }] : [])];
}

export function taskControls(item: TaskOverview) {
  const { task, worker } = item;
  const done = ['accepted_complete', 'cancelled', 'rejected'].includes(task.state);
  const paused = task.state === 'paused' && Boolean(task.pause);
  const hard = paused && task.pause?.mode === 'hard';
  return {
    pauseSoft: !done && !paused,
    pauseHard: !done && !paused && Boolean(worker.templateId) && !worker.pending && worker.archivedAt === undefined,
    retryClose: hard && item.controls.retryClose,
    resume: paused && item.controls.resume,
    cancel: !done,
  };
}

/** This is an agent-wide API counter, never task-specific usage or a model token count. */
export function workerTrafficLabel(traffic: AgentTrafficView | undefined): string {
  if (!traffic) return 'Agent API traffic unavailable';
  const n = traffic.bytes;
  const bytes = n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} returned across ${traffic.calls} calls since server start`;
}

export function controlBody(task: TaskSnapshot, action: TaskControlInput['action'], requestId: string): TaskControlInput {
  return { requestId, expectedRevision: task.revision, action };
}
