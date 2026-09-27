import { z } from 'zod';
import type { Agent, AgentTrafficView } from './types.ts';
import type { JobView } from './jobs.ts';
import type { TaskSnapshot } from './tasks.ts';

/** One Human task card with its historical participants and project context. */
export type TaskOverview = {
  task: TaskSnapshot;
  projectId: string;
  /** Persisted project slug. */
  project: string;
  worker: Agent;
  brain: Agent;
  template: { id: string; label: string } | null;
  /** Worker API traffic since this server started, including an archived worker; not task-specific. */
  traffic: AgentTrafficView | null;
  /** Current native-close gates for Human controls; task control rechecks these atomically. */
  controls: { retryClose: boolean; resume: boolean };
};

export type TaskViewsPage = {
  items: TaskOverview[];
  /** Jobs referenced by this page, plus active jobs with no tasks in the selected scope. */
  jobs: JobView[];
  hasMore: boolean;
  nextCursor: string | null;
};

export const taskViewsListSchema = z.object({
  projectId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type TaskViewsListInput = z.infer<typeof taskViewsListSchema>;
