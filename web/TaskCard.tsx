import type { TaskSnapshot } from '../src/shared/tasks.ts';

export function TaskCard({ task }: { task: TaskSnapshot }) {
  return <section className="task-card" aria-label="Structured task">
    <header><strong>{task.state.replaceAll('_', ' ')}</strong><small>Revision {task.revision} · contract {task.contractVersion}</small></header>
    <p>{task.contract.objective}</p>
    <p>{task.assignerName} → {task.workerName}</p>
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
    {task.result && <details open><summary>Reported result</summary>
      <p>{task.result.summary}</p>
      <p>Artifacts: {task.result.artifacts.join('; ') || 'none'}</p>
      <p>Checks: {task.result.checks.map(c => `${c.name}: ${c.outcome}`).join('; ') || 'none run/reported'}</p>
      <p>Known gaps: {task.result.gaps.join('; ') || 'none reported'}</p>
      <small>Checks are claims by the worker, not independently verified by Hivemind.</small>
    </details>}
    {task.review ? <p>Assigning brain review: {task.review.decision.replaceAll('_', ' ')} — {task.review.summary}</p> :
      <p>No review decision. A submitted result is not accepted-complete.</p>}
  </section>;
}
