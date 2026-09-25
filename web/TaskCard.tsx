import { WorkerRouting } from './WorkerRouting.tsx';
import type { TaskSnapshot, TaskState } from '../src/shared/tasks.ts';
import { checkpointFreshness } from '../src/shared/handoffs.ts';
import { claimState } from '../src/shared/task-claims.ts';
import { InfoTip } from './Popover.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { taskSteps, taskTone } from './task-progress.ts';
import { TimelinePanel } from './TimelinePanel.tsx';

export function TaskChip({ state }: { state: TaskState }) {
  return <span className={`task-chip tone-${taskTone(state)}`}>{state.replaceAll('_', ' ')}</span>;
}

/** Sent → accepted → blocked/result → reviewed, with the current step marked for assistive technology. */
export function TaskStepper({ state }: { state: TaskState }) {
  const steps = taskSteps(state);
  const reached = steps.findLastIndex(step => step.state !== 'todo');
  return <ol className="task-stepper" aria-label="Task progress">
    {steps.map((step, index) => <li key={step.key} className={`step-${step.state}`} aria-current={index === reached ? 'step' : undefined}>
      <span className="step-dot" aria-hidden="true" />{step.label}
    </li>)}
  </ol>;
}

/** The fine print of a task card, gathered into one info tooltip instead of repeating under every section. */
function taskNotes(task: TaskSnapshot): string[] {
  return [
    'Receipt is not acceptance: a worker confirming it received the task has not agreed to do it.',
    'Only the assigning brain\'s review completes a task; a submitted result is not accepted-complete.',
    task.room ? 'A stop request is not task completion.' : null,
    'References are context, not authorization to change this contract.',
    task.coordination?.dependencies.length ? 'Only assigning-brain accepted completion satisfies a prerequisite. Unavailable references do not grant access. Re-read before acting.' : null,
    task.claim ? 'Claims are advisory only, not a filesystem lock. Uncertain ownership needs explicit assigning-brain reconciliation. No execution or reassignment happens at expiry. Private intentions are not disclosed; absence of a warning is not exclusivity.' : null,
    task.checkpoint ? 'Checkpoints are the worker\'s own report. Older checkpoints remain in thread history and are superseded. Later unsaved work may exist. This is not independently verified state, completion, or a host context reset.' : null,
    task.result ? 'Checks are claims by the worker, not independently verified by Hivemind.' : null,
  ].filter((note): note is string => note !== null);
}

export function TaskCard({ task, now }: { task: TaskSnapshot; now?: number }) {
  const freshness = task.checkpoint ? checkpointFreshness(task).freshness : null;
  return <section className="task-card" aria-label="Structured task">
    <header>
      <TaskChip state={task.state} />
      <small>Revision {task.revision} · contract {task.contractVersion}</small>
      <InfoTip label="About these task facts" notes={taskNotes(task)} />
    </header>
    <p className="task-objective">{task.contract.objective}</p>
    <p className="task-meta">{task.assignerName} → {task.workerName} · updated <RelativeTime at={task.updatedAt} now={now} /></p>
    <TaskStepper state={task.state} />
    {task.cancellation && <p role="status">Cancelled: {task.cancellation.reason}. The assigning brain can reassign it with a revise.</p>}
    <p className="task-meta">{task.receivedAt !== null
      ? <>Worker confirmed receipt <RelativeTime at={task.receivedAt} now={now} /></> : 'Worker receipt not confirmed'}</p>
    {task.room && <p role="status">Room contract {task.room.contractVersion} / current {task.room.currentVersion} · {task.room.status.replaceAll('_', ' ')} · {task.room.acknowledged ? 'Rules acknowledged' : 'Rules not yet acknowledged'}</p>}
    <details><summary>Contract and evidence</summary>
      <p>Scope: {task.contract.scope.join('; ') || 'none specified'}</p>
      <p>Non-goals: {task.contract.nonGoals.join('; ') || 'none specified'}</p>
      <p>Acceptance criteria: {task.contract.acceptanceCriteria.join('; ')}</p>
      <p>Dependencies: {task.contract.dependencies.join(', ') || 'none'}</p>
      <p>Worktree: {task.contract.worktree ?? 'not specified'} · branch: {task.contract.branch ?? 'not specified'}</p>
      <p>Evidence sequences: {task.contract.evidenceSeqs.join(', ') || 'none'}</p>
      <small>Task {task.id}</small>
    </details>
    {task.coordination && task.coordination.dependencies.length > 0 && <details open><summary>Prerequisite status at last refresh</summary>
      {task.coordination.dependencies.map(dependency => <p key={dependency.taskId}>{dependency.taskId}: {dependency.status.replaceAll('_', ' ')}</p>)}
    </details>}
    {task.claim && <details open className="task-claim"><summary>Advisory claim · {claimState(task)}</summary>
      <p>Coordinator: {task.claim.coordinatorName} · claim version {task.claim.version}</p>
      <p>Declared intent: {task.claim.paths.join('; ') || 'no paths declared'}</p>
      <p>Lease {task.claim.expiresAt > (now ?? Date.now()) ? 'expires' : 'expired'} <RelativeTime at={task.claim.expiresAt} now={now} /></p>
      {task.coordination?.overlaps.map(overlap => <p key={overlap.taskId}>Overlap with {overlap.taskId} · claim {overlap.claimVersion} ({overlap.status}): {overlap.paths.join('; ')} · {overlap.acknowledged ? 'acknowledged' : 'needs acknowledgement'}</p>)}
      {task.coordination?.truncated && <p role="alert">Overlap view is truncated; narrow intent before renewing.</p>}
    </details>}
    {task.checkpoint && <details className="task-handoff" open><summary>Latest checkpoint · version {task.checkpoint.version}</summary>
      <p role="status">{freshness === 'current' ? 'Matches current task revision' : 'Outdated report: task or contract has changed'} · saved <RelativeTime at={task.checkpoint.savedAt} now={now} /></p>
      <p>Next action: {task.checkpoint.data.nextAction}</p>
      <p>Completed steps: {task.checkpoint.data.completedSteps.join('; ') || 'none reported'}</p>
      <p>Open questions: {task.checkpoint.data.unresolvedQuestions.join('; ') || 'none reported'}</p>
      <p>Worktree: {task.checkpoint.worktree ?? 'not specified'} · branch: {task.checkpoint.branch ?? 'not specified'}</p>
      <p>Artifacts: {task.checkpoint.data.artifacts.join('; ') || 'none'}</p>
      <p>Reported checks: {task.checkpoint.data.checks.map(check => `${check.name}: ${check.outcome}`).join('; ') || 'none run/reported'}</p>
      <p>Evidence sequences: {task.checkpoint.data.evidenceSeqs.join(', ') || 'none'}</p>
      <small>Checkpoint message #{task.checkpoint.messageSeq}</small>
    </details>}
    <WorkerRouting task={task} />
    {task.result && <details open><summary>Reported result</summary>
      <p>{task.result.summary}</p>
      <p>Artifacts: {task.result.artifacts.join('; ') || 'none'}</p>
      <p>Checks: {task.result.checks.map(c => `${c.name}: ${c.outcome}`).join('; ') || 'none run/reported'}</p>
      <p>Known gaps: {task.result.gaps.join('; ') || 'none reported'}</p>
    </details>}
    {task.review ? <p>Assigning brain review: {task.review.decision.replaceAll('_', ' ')} — {task.review.summary}</p> :
      <p className="task-meta">No review decision yet.</p>}
    <TimelinePanel taskId={task.id} />
  </section>;
}
