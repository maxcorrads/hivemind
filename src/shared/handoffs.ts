import type { TaskSnapshot, TaskState } from './tasks.ts';

export type CheckpointFreshness = {
  freshness: 'missing' | 'current' | 'task_changed' | 'contract_changed';
  ageMs: number | null;
};
export type HandoffSummary = CheckpointFreshness & {
  taskId: string; channelId: string; workerId: string; objective: string;
  revision: number; contractVersion: number; checkpointVersion: number | null;
  nextAction: string | null; state: TaskState;
};
export type HandoffList = {
  items: HandoffSummary[]; hasMore: boolean; nextCursor: string | null; next: string;
};

/** The server's current contract, never a saved summary, remains authoritative. */
export function checkpointFreshness(task: TaskSnapshot, now = Date.now()): CheckpointFreshness {
  const checkpoint = task.checkpoint;
  if (!checkpoint) return { freshness: 'missing', ageMs: null };
  return {
    freshness: checkpoint.contractVersion !== task.contractVersion || checkpoint.workerId !== task.workerId
      ? 'contract_changed' : checkpoint.taskRevision !== task.revision ? 'task_changed' : 'current',
    ageMs: Math.max(0, now - checkpoint.savedAt),
  };
}
