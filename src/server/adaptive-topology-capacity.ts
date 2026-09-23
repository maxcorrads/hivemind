import type { CapacityDeps } from './services/ports.ts';
import { PRESENCE_IDLE_MS } from '../shared/types.ts';
import type { TopologyCapacitySnapshot } from './adaptive-topology-provider.ts';

/**
 * Free-form delegation is active until its thread is done or the worker reports it finished (the commitment row is
 * then deleted). A completed or deleted execution holds no worker: its commitments are released with it.
 */
export function openDelegations(deps: CapacityDeps, of: { projectId: string } | { executionId: string }) {
  const rows = deps.adaptiveTopology.store.runningDelegations(of);
  const statuses = deps.messageQueries.threadStatuses(rows.map(row => row.root_id));
  return rows.map(row => ({ ...row, status: statuses.get(row.root_id) ?? null }))
    .filter(row => (row.status ?? 'open') !== 'done');
}

type Work = { id: string; workerId: string; executionId: string | null; state: string; held: boolean; dependencies: string[] };
export type ExecutionCapacityScope = { projectId: string; executionId: string };

/** One authority for provider snapshots AND synchronous delegation admission. */
export function readAdaptiveCapacity(deps: CapacityDeps, scope: ExecutionCapacityScope): TopologyCapacitySnapshot {
  const now = Date.now();
  const workers = deps.identity.listAgents().filter(agent => agent.role === 'worker' && agent.projectId === scope.projectId);
  const open = deps.tasks.capacityWork(scope.projectId);
  const links = deps.adaptiveTopology.store.taskExecutions(open.map(task => task.id));
  const work = open.map(task => ({ ...task, executionId: links.get(task.id) ?? null } satisfies Work));
  const raw = openDelegations(deps, { projectId: scope.projectId });
  const own = work.filter(task => task.executionId === scope.executionId);
  const ownRaw = raw.filter(row => row.execution_id === scope.executionId);
  const otherWorkers = new Set([
    ...work.filter(task => task.executionId !== scope.executionId).map(task => task.workerId),
    ...raw.filter(row => row.execution_id !== scope.executionId).map(row => String(row.worker_id)),
  ]);
  const ownWorkers = new Set([...own.map(task => task.workerId), ...ownRaw.map(row => String(row.worker_id))]);
  const isLive = (worker: typeof workers[number]) => worker.online && now - worker.lastSeenAt < PRESENCE_IDLE_MS;
  const free = workers.filter(worker => isLive(worker) && !ownWorkers.has(worker.id) && !otherWorkers.has(worker.id));
  const committed = workers.filter(worker => isLive(worker) && ownWorkers.has(worker.id) && !otherWorkers.has(worker.id));
  const active = own.filter(task => !['accepted_complete','rejected'].includes(task.state));
  const dependencyIds = [...new Set(active.flatMap(task => task.dependencies))];
  const completed = new Set(deps.tasks.completedAmong(dependencyIds));
  const available = [...committed.map(worker => ({ ...worker, committed: true })), ...free.map(worker => ({ ...worker, committed: false }))]
    .map(({ id, name, seniority, focus, committed: inUse }) => ({ id, name, seniority, focus, committed: inUse }));
  return {
    workers: { total: workers.length, online: workers.filter(isLive).length,
      busyOther: workers.filter(worker => otherWorkers.has(worker.id)).length,
      busyCurrent: committed.length, free: free.length, usableForExecution: available.length, available },
    activeTasks: active.length + new Set(ownRaw.map(row => String(row.root_id))).size,
    activeWorkers: ownWorkers.size,
    blockers: active.filter(task => task.state === 'blocked').length + ownRaw.filter(row => row.status === 'blocked').length,
    openDependencies: active.reduce((total, task) => total + task.dependencies.filter(id => !completed.has(id)).length, 0),
    workstreams: active.length + new Set(ownRaw.map(row => String(row.root_id))).size,
    unreconciledClaims: own.filter(task => task.held).length,
  };
}
