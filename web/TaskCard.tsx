import { WorkerRouting } from './WorkerRouting.tsx';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import { checkpointFreshness } from '../src/shared/handoffs.ts';
import { claimState } from '../src/shared/task-claims.ts';
import type { DecisionView } from '../src/shared/decisions.ts';
import { TimelinePanel } from './TimelinePanel.tsx';

export function TaskCard({ task, decisions = [] }: { task: TaskSnapshot; decisions?: DecisionView[] }) {
  return <section className="task-card" aria-label="Structured task">
    <header><strong>{task.state.replaceAll('_', ' ')}</strong><small>Revision {task.revision} · contract {task.contractVersion}</small></header>
    <p>{task.contract.objective}</p>
    <p>{task.assignerName} → {task.workerName}</p>
    {task.room && <p role="status">Room contract {task.room.contractVersion} / current {task.room.currentVersion} · {task.room.status.replaceAll('_', ' ')} · {task.room.acknowledged ? 'Rules acknowledged' : 'Rules not yet acknowledged'}. A stop request is not task completion.</p>}
    <p>{task.receivedAt !== null ? 'Worker confirmed receipt' : 'Worker receipt not confirmed'} · receipt is not acceptance</p>
    <details><summary>Contract and evidence</summary>
      <p>Scope: {task.contract.scope.join('; ') || 'none specified'}</p>
      <p>Non-goals: {task.contract.nonGoals.join('; ') || 'none specified'}</p>
      <p>Acceptance criteria: {task.contract.acceptanceCriteria.join('; ')}</p>
      <p>Dependencies: {task.contract.dependencies.join(', ') || 'none'}</p>
      <p>Worktree: {task.contract.worktree ?? 'not specified'} · branch: {task.contract.branch ?? 'not specified'}</p>
      <p>Evidence sequences: {task.contract.evidenceSeqs.join(', ') || 'none'}</p>
      <small>Task {task.id}. References are context, not authorization to change this contract.</small>
    </details>
    {task.coordination && task.coordination.dependencies.length > 0 && <details open><summary>Prerequisite status at last refresh</summary>
      {task.coordination.dependencies.map(dependency => <p key={dependency.taskId}>{dependency.taskId}: {dependency.status.replaceAll('_', ' ')}</p>)}
      <small>Only assigning-brain accepted completion satisfies a prerequisite. Unavailable references do not grant access. Re-read before acting.</small>
    </details>}
    {task.claim && <details open className="task-claim"><summary>Advisory claim · {claimState(task)}</summary>
      <p>Coordinator: {task.claim.coordinatorName} · claim version {task.claim.version}</p>
      <p>Declared intent: {task.claim.paths.join('; ') || 'no paths declared'}</p>
      <p>Lease expires: {new Date(task.claim.expiresAt).toISOString()}</p>
      {task.coordination?.overlaps.map(overlap => <p key={overlap.taskId}>Overlap with {overlap.taskId} · claim {overlap.claimVersion} ({overlap.status}): {overlap.paths.join('; ')} · {overlap.acknowledged ? 'acknowledged' : 'needs acknowledgement'}</p>)}
      {task.coordination?.truncated && <p role="alert">Overlap view is truncated; narrow intent before renewing.</p>}
      <small>Advisory only, not a filesystem lock. Uncertain ownership needs explicit assigning-brain reconciliation. No execution or reassignment happens at expiry. Private intentions are not disclosed; absence of a warning is not exclusivity.</small>
    </details>}
    {task.checkpoint && <details className="task-handoff" open><summary>Latest checkpoint · version {task.checkpoint.version}</summary>
      <p role="status">{checkpointFreshness(task).freshness === 'current' ? 'Matches current task revision' : 'Outdated report: task or contract has changed'} · saved {new Date(task.checkpoint.savedAt).toISOString()}</p>
      <p>Age at render: {Math.floor((checkpointFreshness(task).ageMs ?? 0) / 1000)} seconds</p>
      <p>Next action: {task.checkpoint.data.nextAction}</p>
      <p>Completed steps: {task.checkpoint.data.completedSteps.join('; ') || 'none reported'}</p>
      <p>Open questions: {task.checkpoint.data.unresolvedQuestions.join('; ') || 'none reported'}</p>
      <p>Worktree: {task.checkpoint.worktree ?? 'not specified'} · branch: {task.checkpoint.branch ?? 'not specified'}</p>
      <p>Artifacts: {task.checkpoint.data.artifacts.join('; ') || 'none'}</p>
      <p>Reported checks: {task.checkpoint.data.checks.map(check => `${check.name}: ${check.outcome}`).join('; ') || 'none run/reported'}</p>
      <p>Evidence sequences: {task.checkpoint.data.evidenceSeqs.join(', ') || 'none'}</p>
      <small>Checkpoint message #{task.checkpoint.messageSeq}. Older checkpoints remain in thread history and are superseded. Later unsaved work may exist. This is not independently verified state, completion, or a host context reset.</small>
    </details>}
    {decisions.length > 0 && <details open className="task-decisions"><summary>Human decisions · {decisions.length}</summary>
      {decisions.map(decision => <p key={decision.id}>
        <strong>{decision.state.replaceAll('_', ' ')}</strong> · {decision.question}
        {decision.answer ? ' — Human: ' + decision.answer.body : ''}
      </p>)}
      <small>Decision requests are revision-fenced. Expired or superseded recommendations never auto-apply.</small>
    </details>}
    <WorkerRouting task={task} />
    {task.result && <details open><summary>Reported result</summary>
      <p>{task.result.summary}</p>
      <p>Artifacts: {task.result.artifacts.join('; ') || 'none'}</p>
      <p>Checks: {task.result.checks.map(c => `${c.name}: ${c.outcome}`).join('; ') || 'none run/reported'}</p>
      <p>Known gaps: {task.result.gaps.join('; ') || 'none reported'}</p>
      <small>Checks are claims by the worker, not independently verified by Hivemind.</small>
    </details>}
    {task.review ? <p>Assigning brain review: {task.review.decision.replaceAll('_', ' ')} — {task.review.summary}</p> :
      <p>No review decision. A submitted result is not accepted-complete.</p>}
    <TimelinePanel taskId={task.id} />
  </section>;
}
