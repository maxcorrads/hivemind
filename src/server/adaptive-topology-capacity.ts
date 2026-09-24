import type { CapacityDeps } from './services/ports.ts';
import { PRESENCE_IDLE_MS } from '../shared/types.ts';
import type { TopologyCapacitySnapshot } from './adaptive-topology-provider.ts';

/**
 * Worker capacity as Jev sees it for one brain (#211). It is context for advice, never a limit: a worker is busy for
 * this brain while it holds unfinished structured work the brain assigned, and busy elsewhere while it holds work from
 * another brain. Free-form DM delegation is not tracked.
 */
export function readAdaptiveCapacity(deps: CapacityDeps, scope: { projectId: string; brainId: string | null }): TopologyCapacitySnapshot {
  const now = Date.now();
  const workers = deps.identity.listAgents().filter(agent => agent.role === 'worker' && agent.projectId === scope.projectId);
  const work = deps.tasks.capacityWork(scope.projectId);
  const own = work.filter(task => scope.brainId !== null && task.assignerId === scope.brainId);
  const otherWorkers = new Set(work.filter(task => task.assignerId !== scope.brainId).map(task => task.workerId));
  const ownWorkers = new Set(own.map(task => task.workerId));
  const isLive = (worker: typeof workers[number]) => worker.online && now - worker.lastSeenAt < PRESENCE_IDLE_MS;
  const free = workers.filter(worker => isLive(worker) && !ownWorkers.has(worker.id) && !otherWorkers.has(worker.id));
  const committed = workers.filter(worker => isLive(worker) && ownWorkers.has(worker.id) && !otherWorkers.has(worker.id));
  const active = own.filter(task => !['accepted_complete', 'rejected', 'cancelled'].includes(task.state));
  const dependencyIds = [...new Set(active.flatMap(task => task.dependencies))];
  const completed = new Set(deps.tasks.completedAmong(dependencyIds));
  const available = [...committed.map(worker => ({ ...worker, committed: true })), ...free.map(worker => ({ ...worker, committed: false }))]
    .map(({ id, name, seniority, focus, committed: inUse }) => ({ id, name, seniority, focus, committed: inUse }));
  return {
    workers: { total: workers.length, online: workers.filter(isLive).length,
      busyOther: workers.filter(worker => otherWorkers.has(worker.id)).length,
      busyCurrent: committed.length, free: free.length, usableForExecution: available.length, available },
    activeTasks: active.length,
    activeWorkers: ownWorkers.size,
    blockers: active.filter(task => task.state === 'blocked').length,
    openDependencies: active.reduce((total, task) => total + task.dependencies.filter(id => !completed.has(id)).length, 0),
    workstreams: active.length,
    unreconciledClaims: own.filter(task => task.held).length,
  };
}
