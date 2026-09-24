import type { TaskState } from '../src/shared/tasks.ts';

export type StepState = 'done' | 'current' | 'todo' | 'warn' | 'fail';
export type TaskStep = { key: 'sent' | 'accepted' | 'outcome' | 'reviewed'; label: string; state: StepState };

const LABELS = { sent: 'Sent', accepted: 'Accepted', outcome: 'Result', reviewed: 'Reviewed' } as const;
const ORDER = ['sent', 'accepted', 'outcome', 'reviewed'] as const;
/** The step each state has reached, how that step went, and the label that replaces the step's default. */
const REACHED: Record<TaskState, [index: number, state: StepState, label?: string]> = {
  sent: [0, 'current'],
  delivered: [0, 'current', 'Delivered'],
  accepted: [1, 'current'],
  rejected: [1, 'fail', 'Rejected'],
  blocked: [2, 'warn', 'Blocked'],
  result_submitted: [2, 'current'],
  changes_requested: [3, 'warn', 'Changes requested'],
  accepted_complete: [3, 'done'],
  // A cancelled task ends here without a review; how far it got is in the thread, so no earlier step is claimed.
  cancelled: [3, 'fail', 'Cancelled'],
};

/** The progress stepper of a task: sent → accepted → blocked/result → reviewed. Receipt alone never passes "Accepted". */
export function taskSteps(state: TaskState): TaskStep[] {
  const [reached, outcome, label] = REACHED[state];
  return ORDER.map((key, index) => ({
    key,
    label: index === reached && label ? label : LABELS[key],
    state: index === reached ? outcome : index < reached && state !== 'cancelled' ? 'done' : 'todo',
  }));
}

/** The chip tone of a task state: finished, needs attention, failed, or still moving. */
export function taskTone(state: TaskState): 'done' | 'warn' | 'fail' | 'active' {
  if (state === 'accepted_complete') return 'done';
  if (state === 'blocked' || state === 'changes_requested') return 'warn';
  if (state === 'rejected' || state === 'cancelled') return 'fail';
  return 'active';
}

/** Tasks someone still has to act on: everything but accepted-complete, rejected and cancelled. */
export function isOpenTask(state: TaskState): boolean {
  return state !== 'accepted_complete' && state !== 'rejected' && state !== 'cancelled';
}
