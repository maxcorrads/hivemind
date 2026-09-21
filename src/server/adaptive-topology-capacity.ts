import type { Hive } from './hive.ts';
import { PRESENCE_IDLE_MS } from '../shared/types.ts';
import type { TopologyCapacitySnapshot } from './adaptive-topology-provider.ts';

export function initAdaptiveCommitments(hive: Hive): void {
  hive.db.exec(`CREATE TABLE IF NOT EXISTS adaptive_topology_messages (
    root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY(root_id,worker_id));
    CREATE INDEX IF NOT EXISTS idx_adaptive_message_execution ON adaptive_topology_messages(execution_id);
    CREATE INDEX IF NOT EXISTS idx_adaptive_message_worker ON adaptive_topology_messages(worker_id);
  `);
}

type Work = { id: string; workerId: string; executionId: string | null; state: string; held: boolean; dependencies: string[] };
export type ExecutionCapacityScope = { projectId: string; executionId: string };

/** One authority for provider snapshots AND synchronous delegation admission. */
export function readAdaptiveCapacity(hive: Hive, scope: ExecutionCapacityScope): TopologyCapacitySnapshot {
  const now = Date.now();
  const workers = hive.listAgents().filter(agent => agent.role === 'worker' && agent.projectId === scope.projectId);
  const work = hive.db.prepare(`SELECT t.id,t.worker_id,link.execution_id,
      json_extract(t.snapshot,'$.state') AS state,
      json_extract(t.snapshot,'$.claim.state') AS claim_state,
      json_extract(t.snapshot,'$.contract.dependencies') AS dependencies
    FROM task_records t JOIN channels c ON c.id=t.channel_id
    LEFT JOIN adaptive_topology_tasks link ON link.task_id=t.id
    LEFT JOIN room_tasks room ON room.task_id=t.id
    WHERE c.project_id=? AND ((json_extract(t.snapshot,'$.state') NOT IN ('accepted_complete','rejected')
      AND COALESCE(room.status,'active')!='stopped') OR json_extract(t.snapshot,'$.claim.state')='held')`).all(scope.projectId).map(row => ({
      id: String(row.id), workerId: String(row.worker_id), executionId: row.execution_id == null ? null : String(row.execution_id),
      state: String(row.state), held: row.claim_state === 'held',
      dependencies: row.dependencies ? JSON.parse(String(row.dependencies)) as string[] : [],
    } satisfies Work));
  // Free-form delegation is active until its brain explicitly closes the thread.
  const raw = hive.db.prepare(`SELECT a.root_id,a.worker_id,a.execution_id,threads.status
      FROM adaptive_topology_messages a LEFT JOIN threads ON threads.id=a.root_id
      WHERE a.project_id=? AND COALESCE(threads.status,'open')!='done'`).all(scope.projectId);
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
  const completed = new Set(hive.db.prepare(`SELECT id FROM task_records
    WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(snapshot,'$.state')='accepted_complete'`)
    .all(JSON.stringify(dependencyIds)).map(row => String(row.id)));
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
