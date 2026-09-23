import type { TaskCoordinationDeps } from './services/ports.ts';
import { HiveError, type Agent } from '../shared/types.ts';
import type { TaskContract, TaskSnapshot } from '../shared/tasks.ts';
import { CLAIM_LIMITS, claimState, overlappingPaths, type ClaimAction, type TaskClaim, type TaskCoordinationView } from '../shared/task-claims.ts';

type ClaimRow = { id: string; claim: string; worker_id: string; contract_version: number };

/** Advisory metadata only. All mutations are called inside TaskStore's writer transaction. */
export class TaskCoordination {
  constructor(private readonly deps: TaskCoordinationDeps) {}
  private get db() { return this.deps.storage.db; }
  private snapshot(id: string, projectId: string | null): TaskSnapshot | undefined {
    const row = this.db.prepare(`SELECT r.snapshot FROM task_records r JOIN channels c ON c.id = r.channel_id
      WHERE r.id = ? AND c.project_id = ?`).get(id, projectId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as TaskSnapshot : undefined;
  }
  private visible(actor: Agent, task: TaskSnapshot | undefined): task is TaskSnapshot {
    return !!task && actor.role !== 'bot' && this.deps.channels.canSeeChannel(actor, this.deps.channels.getChannel(task.channelId));
  }
  /** Walk only a bounded same-project graph, never expose invisible ancestor content. */
  validateDependencies(actor: Agent, contract: TaskContract, targetId?: string) {
    const seen = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (id === targetId || visiting.has(id)) throw new HiveError(409, 'Task dependency cycle');
      if (seen.has(id)) return;
      if (seen.size >= CLAIM_LIMITS.graph) throw new HiveError(409, 'Dependency graph exceeds the 256-task validation budget');
      const task = this.snapshot(id, actor.projectId);
      if (!task) throw new HiveError(409, 'Dependency graph contains an unavailable prerequisite');
      seen.add(id); visiting.add(id);
      for (const parent of task.contract.dependencies) visit(parent);
      visiting.delete(id);
    };
    for (const id of contract.dependencies) {
      if (id === targetId) throw new HiveError(400, 'A task cannot depend on itself');
      const direct = this.snapshot(id, actor.projectId);
      if (!direct) throw new HiveError(404, 'Task not found');
      if (!this.visible(actor, direct)) throw new HiveError(403, 'Cannot reference an unavailable task');
      visit(id);
    }
  }
  private visibleClaims(actor: Agent, task: TaskSnapshot): ClaimRow[] {
    const projectId = this.deps.channels.getChannel(task.channelId).projectId;
    return this.db.prepare(`SELECT r.id, r.worker_id, json_extract(r.snapshot, '$.contractVersion') AS contract_version, json_extract(r.snapshot, '$.claim') AS claim
      FROM channels c JOIN task_records r ON r.channel_id = c.id
      WHERE c.project_id = ? AND r.id != ? AND json_extract(r.snapshot, '$.claim.state') = 'held'
        AND (? = 'human' OR (EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.agent_id = ?)
          AND (? = 'brain' OR c.type != 'brains')))
      ORDER BY r.id LIMIT 257`).all(projectId, task.id, actor.role, actor.id, actor.role) as ClaimRow[];
  }
  private overlaps(actor: Agent, task: TaskSnapshot, paths: string[], acks: TaskClaim['overlapAcknowledgements']) {
    const rows = paths.length ? this.visibleClaims(actor, task) : [];
    const items = rows.flatMap(row => {
      const other = JSON.parse(row.claim) as TaskClaim;
      const matches = overlappingPaths(paths, other.paths);
      return matches.length ? [{ taskId: row.id, claimVersion: other.version, paths: matches,
        status: claimState({ claim: other, workerId: row.worker_id, contractVersion: row.contract_version }) === 'uncertain' ? 'uncertain' as const : 'held' as const,
        acknowledged: acks.some(ack => ack.taskId === row.id && ack.claimVersion === other.version) }] : [];
    });
    return { items: items.slice(0, 12), truncated: rows.length > CLAIM_LIMITS.project || items.length > 12 };
  }
  preview(actor: Agent, task: TaskSnapshot, paths: string[]) {
    if (actor.role !== 'brain' || !this.deps.channels.canPost(actor, this.deps.channels.getChannel(task.channelId)))
      throw new HiveError(403, 'Only a brain with task-channel access can preview advisory claims');
    const conflicts = this.overlaps(actor, task, paths, []);
    return { taskId: task.id, revision: task.revision, overlaps: conflicts.items, truncated: conflicts.truncated,
      warning: 'Read-only advisory preview; no ownership reserved. Only visible declared intents are compared. Recheck on claim; references do not grant access.' };
  }
  view(actor: Agent, task: TaskSnapshot): TaskCoordinationView {
    const projectId = this.deps.channels.getChannel(task.channelId).projectId;
    const dependencies = task.contract.dependencies.map(taskId => {
      const dependency = this.snapshot(taskId, projectId);
      return { taskId, status: !this.visible(actor, dependency) ? 'unavailable' as const :
        dependency.state === 'accepted_complete' ? 'accepted_complete' as const : 'not_complete' as const };
    });
    const overlaps = task.claim?.state === 'held'
      ? this.overlaps(actor, task, task.claim.paths, task.claim.overlapAcknowledgements) : { items: [], truncated: false };
    return { dependencies, claim: claimState(task), overlaps: overlaps.items, truncated: overlaps.truncated };
  }
  assertReady(task: TaskSnapshot) {
    const projectId = this.deps.channels.getChannel(task.channelId).projectId;
    if (task.contract.dependencies.some(id => this.snapshot(id, projectId)?.state !== 'accepted_complete'))
      throw new HiveError(409, 'An immediate prerequisite is not accepted-complete; inspect the task dependency view');
    if (claimState(task) === 'uncertain')
      throw new HiveError(409, 'Advisory ownership is uncertain; the assigning brain must explicitly reconcile or release the claim');
  }
  authorize(actor: Agent, task: TaskSnapshot, action: ClaimAction) {
    if (actor.role !== 'brain') throw new HiveError(403, 'Only a brain with task-channel access can manage an advisory claim');
    if (action.type === 'reconcile_claim' && actor.id !== task.assignerId)
      throw new HiveError(403, 'Only the assigning brain can explicitly reconcile uncertain ownership');
    if (action.type === 'renew_claim' && actor.id !== task.claim?.coordinatorId)
      throw new HiveError(403, 'Only the claim coordinator can renew it');
    if (action.type === 'release_claim' && actor.id !== task.claim?.coordinatorId && actor.id !== task.assignerId)
      throw new HiveError(403, 'Only the coordinator or assigning brain can release the claim');
  }
  apply(actor: Agent, task: TaskSnapshot, action: ClaimAction) {
    this.authorize(actor, task, action);
    const old = task.claim, now = Date.now();
    if (action.type === 'release_claim') {
      if (old?.state !== 'held') throw new HiveError(409, 'There is no held claim to release');
      task.claim = { ...old, state: 'released', version: old.version + 1, updatedAt: now };
      return;
    }
    if (task.state === 'accepted_complete' || task.state === 'rejected') throw new HiveError(409, 'Finished or rejected tasks cannot acquire work claims');
    if (action.type === 'claim' && old?.state === 'held') throw new HiveError(409, 'Task already claimed; expiry never automatically grants another owner');
    if (action.type === 'renew_claim' && claimState(task, now) !== 'held') throw new HiveError(409, 'Only a current unexpired claim can be renewed');
    if (action.type === 'reconcile_claim' && old?.state !== 'held') throw new HiveError(409, 'Reconciliation requires an existing held or uncertain claim');
    const paths = action.type === 'renew_claim' ? old!.paths : [...action.paths].sort();
    const overlaps = this.overlaps(actor, task, paths, action.overlapAcknowledgements);
    if (overlaps.truncated) throw new HiveError(409, 'Too many visible intent overlaps; narrow the advisory intent');
    if (overlaps.items.some(item => !item.acknowledged)) throw new HiveError(409, 'Acknowledge each visible overlapping task and its current claim version');
    if (action.overlapAcknowledgements.some(ack => !overlaps.items.some(item => item.taskId === ack.taskId && item.claimVersion === ack.claimVersion)))
      throw new HiveError(409, 'An overlap acknowledgement is stale or not visible; reread task coordination');
    // Counts include expired claims. Expiry alone cannot evict an owner's intention.
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(json_extract(r.snapshot, '$.claim.coordinatorId') = ?), 0) AS coordinator,
      COALESCE(SUM(json_extract(r.snapshot, '$.claim.workerId') = ?), 0) AS worker
      FROM channels c JOIN task_records r ON r.channel_id = c.id WHERE c.project_id = ? AND r.id != ?
        AND json_extract(r.snapshot, '$.claim.state') = 'held'`).get(actor.id, task.workerId,
      this.deps.channels.getChannel(task.channelId).projectId, task.id) as { total: number; coordinator: number; worker: number };
    if (counts.total >= CLAIM_LIMITS.project || counts.coordinator >= CLAIM_LIMITS.coordinator || counts.worker >= CLAIM_LIMITS.worker)
      throw new HiveError(429, 'Advisory claim capacity reached; explicitly release finished or uncertain claims');
    task.claim = { version: (old?.version ?? 0) + 1, coordinatorId: actor.id, coordinatorName: actor.name,
      workerId: task.workerId, contractVersion: task.contractVersion, state: 'held', paths,
      overlapAcknowledgements: action.overlapAcknowledgements, updatedAt: now, expiresAt: now + action.leaseSeconds * 1000 };
  }
}
