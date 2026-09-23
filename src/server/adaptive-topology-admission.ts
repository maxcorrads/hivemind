import { createHash } from 'node:crypto';
import type { Hive } from './hive.ts';
import { HiveError, type Agent, type Channel, type Message } from '../shared/types.ts';
import type { TaskContract, TaskSnapshot } from '../shared/tasks.ts';
import type { AdaptiveAgentPolicy, AdaptiveCoordinationEvent } from './adaptive-topology.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';

export function coordinationEventId(actorId: string, family: string, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([actorId, family, requestId])).digest('hex');
}

type Permit = { executionId: string; revision: number; workerId: string; channelId: string | null;
  requestId: string; contractHash: string; expiresAt: number };
const permits = new WeakMap<Hive, Map<string, Permit>>();
function contractHash(contract: TaskContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
function stateRevision(hive: Hive, executionId: string): number {
  const row = hive.db.prepare("SELECT COALESCE(json_extract(snapshot,'$.revision'),0) AS revision FROM adaptive_topology_executions WHERE execution_id=?")
    .get(executionId);
  if (!row) throw new HiveError(409, 'Adaptive execution changed');
  return Number(row.revision);
}

/** Only the pre-action controller can create this short-lived capability. Never accepted from request JSON. */
export function permitAdaptiveTask(hive: Hive, actor: Agent, input: {
  requestId: string; worker: string; channel?: string; contract: TaskContract;
}, policy: AdaptiveAgentPolicy | null): void {
  if (!policy) return;
  const worker = hive.getAgentByName(input.worker);
  if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId)
    throw new HiveError(400, 'Select a worker in this project');
  const byActor = permits.get(hive) ?? new Map<string, Permit>();
  permits.set(hive, byActor);
  byActor.set(actor.id, { executionId: policy.executionId, revision: stateRevision(hive, policy.executionId),
    workerId: worker.id, channelId: input.channel ? hive.getChannel(input.channel, actor.projectId).id : null,
    requestId: input.requestId, contractHash: contractHash(input.contract), expiresAt: Date.now() + 10_000 });
}
export function clearAdaptivePermit(hive: Hive, actorId: string): void {
  permits.get(hive)?.delete(actorId);
}

export function assertAdaptiveWorkerAdmission(hive: Hive, actor: Agent, channel: Channel,
  workerIds: string[], policy: AdaptiveAgentPolicy): void {
  if (policy.currentTopology === 'single') throw new HiveError(409, 'Adaptive routing retains Single; new delegation is blocked');
  if (policy.delegationPaused) throw new HiveError(409, 'Adaptive de-escalation pending; finish existing work first');
  const usesRoom = Boolean(hive.rooms.peek(channel.id));
  if (usesRoom !== (policy.currentTopology === 'brain_multi_room'))
    throw new HiveError(409, usesRoom ? 'Applied topology does not permit new room work' : 'Applied topology is Room; new work must use its room contract');
  const capacity = readAdaptiveCapacity(hive, { projectId: channel.projectId, executionId: policy.executionId });
  const chosen = [...new Set(workerIds)];
  let additional = 0;
  for (const id of chosen) {
    const worker = hive.getAgent(id);
    const candidate = capacity.workers.available.find(item => item.id === id);
    if (worker.role !== 'worker' || worker.projectId !== actor.projectId || !candidate ||
      !hive.canSeeChannel(worker, channel) || !hive.canPost(worker, channel))
      throw new HiveError(409, 'A selected worker is no longer available to this execution');
    if (!candidate.committed) additional++;
  }
  if (capacity.activeWorkers + additional > policy.workerBudget)
    throw new HiveError(409, `Applied worker budget is ${policy.workerBudget}; capacity changed before commit`);
}

/** Called inside TaskStore's existing write transaction, before any task/message row is inserted. */
export function admitAdaptiveTask(hive: Hive, actor: Agent, task: TaskSnapshot, requestId: string): string | null {
  if (!hive.adaptiveTopology?.hasActive(actor)) return null;
  const permit = permits.get(hive)?.get(actor.id);
  // The permit names the execution this assignment was verified against.
  const policy = permit ? hive.adaptiveTopology.forAgent(actor, permit.executionId) : null;
  if (!permit || !policy || permit.expiresAt < Date.now() ||
    permit.revision !== stateRevision(hive, policy.executionId) || permit.requestId !== requestId ||
    permit.workerId !== task.workerId || permit.contractHash !== contractHash(task.contract) ||
    (permit.channelId !== null && permit.channelId !== task.channelId))
    throw new HiveError(409, 'A fresh Jev coordination check is required before this assignment');
  const channel = hive.getChannel(task.channelId, actor.projectId);
  if (permit.channelId === null && channel.type !== 'dm')
    throw new HiveError(409, 'Adaptive assignment destination changed after verification');
  assertAdaptiveWorkerAdmission(hive, actor, channel, [task.workerId], policy);
  return policy.executionId;
}

/** Called after task_records is written but before the same transaction commits. */
export function linkAdaptiveTask(hive: Hive, taskId: string, executionId: string | null): void {
  if (!executionId) return;
  const previous = hive.db.prepare('SELECT execution_id FROM adaptive_topology_tasks WHERE task_id=?').get(taskId);
  if (previous && previous.execution_id !== executionId) throw new HiveError(409, 'Task belongs to another adaptive execution');
  hive.db.prepare('INSERT OR IGNORE INTO adaptive_topology_tasks(task_id,execution_id) VALUES(?,?)').run(taskId, executionId);
}

/** postMessage's receipt callback runs inside its transaction: no post-commit reservation race. */
export function bindAdaptiveMessage(hive: Hive, actor: Agent, message: Message,
  workerIds: string[], expected: AdaptiveAgentPolicy | null): void {
  if (!expected || workerIds.length === 0) return;
  const current = hive.adaptiveTopology.forAgent(actor, expected.executionId);
  if (!current || current.executionId !== expected.executionId || current.currentTopology !== expected.currentTopology ||
    current.workerBudget !== expected.workerBudget)
    throw new HiveError(409, 'Adaptive policy changed before message delivery');
  const channel = hive.getChannel(message.channelId, actor.projectId);
  if (hive.db.prepare('SELECT status FROM threads WHERE id=?').get(message.threadId ?? message.id)?.status === 'done')
    throw new HiveError(409, 'Delegation thread is completed; start a new assignment instead of reusing closed work');
  assertAdaptiveWorkerAdmission(hive, actor, channel, workerIds, current);
  for (const workerId of new Set(workerIds)) {
    const root = message.threadId ?? message.id;
    const previous = hive.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=? AND worker_id=?').get(root, workerId);
    if (previous && previous.execution_id !== current.executionId)
      throw new HiveError(409, 'This delegation thread belongs to another execution');
    hive.db.prepare(`INSERT OR IGNORE INTO adaptive_topology_messages
      (root_id,worker_id,execution_id,project_id) VALUES(?,?,?,?)`)
      .run(root, workerId, current.executionId, channel.projectId);
  }
}

/** Post-commit routing that must not hold a brain's lane (e.g. project-wide revalidation after capacity changes). */
export type DeferRouting = (label: string, task: () => Promise<unknown>) => void;
const followUps = new WeakMap<Hive, Set<Promise<void>>>();
function startFollowUps(hive: Hive, tasks: Array<[string, () => Promise<unknown>]>): void {
  if (!tasks.length) return;
  const running = followUps.get(hive) ?? new Set<Promise<void>>();
  followUps.set(hive, running);
  for (const [label, task] of tasks) {
    const pending: Promise<void> = Promise.resolve().then(task).then(() => undefined, (error: unknown) => {
      console.error(`Adaptive ${label} failed after commit`, error instanceof Error ? error.message : String(error));
    }).finally(() => { running.delete(pending); });
    running.add(pending);
  }
}
/** Deterministic hook for tests and shutdown: resolves once every started post-commit routing task settled. */
export async function settleAdaptiveFollowUps(hive: Hive): Promise<void> {
  const running = followUps.get(hive);
  while (running?.size) await Promise.all(running);
}

/**
 * Serializes one brain's full Jev await + synchronous mutation, rather than only the classifier call.
 *
 * The lane is keyed by brain, not by project. The admission invariants still hold without a project-wide lane:
 * - Permits are keyed by actor and are created and consumed synchronously (no await between
 *   permitAdaptiveTask and the TaskStore write that admits it), so no other action can observe or replace them;
 *   the per-brain lane additionally keeps one brain's own actions (and their retries) in submission order.
 * - Worker budget, availability and execution revision are re-read inside the SQLite write transaction
 *   (admitAdaptiveTask / bindAdaptiveMessage). A concurrent brain can only change capacity by committing its
 *   own transaction first, which the later commit then observes and rejects with 409 — never over-admits.
 * - Each execution's Jev revalidation is already serialized by AdaptiveTopologyRuntime and discards stale results
 *   by revision, so parallel brains cannot interleave writes to one execution.
 *
 * Workers never go through Jev and their actions contain no await, so they bypass the lane entirely, as do
 * brains without an active (enabled or locked) execution and no pending coordination of their own.
 * Work registered through `defer` runs after the lane is released, fire-and-forget with error logging.
 */
const lanes = new WeakMap<Hive, Map<string, Promise<void>>>();
export function coordinateMutation<T>(hive: Hive, actor: Agent, work: (defer: DeferRouting) => Promise<T>): Promise<T> {
  const map = lanes.get(hive) ?? new Map<string, Promise<void>>();
  lanes.set(hive, map);
  const deferred: Array<[string, () => Promise<unknown>]> = [];
  const run = () => work((label, task) => { deferred.push([label, task]); });
  const key = actor.id;
  const bypass = actor.role !== 'brain' || (!map.has(key) && !hive.adaptiveTopology?.hasActive(actor));
  let result: Promise<T>;
  if (bypass) result = run();
  else {
    result = (map.get(key) ?? Promise.resolve()).then(run);
    const finished = result.then(() => undefined, () => undefined).finally(() => {
      if (map.get(key) === finished) map.delete(key);
    });
    map.set(key, finished);
  }
  // Deferred routing starts once this mutation settled, i.e. after it left its lane.
  void result.then(() => undefined, () => undefined).finally(() => startFollowUps(hive, deferred));
  return result;
}

export function taskEventIdentity(actor: Agent, family: string, requestId: string): Pick<AdaptiveCoordinationEvent, 'eventId'> {
  return { eventId: coordinationEventId(actor.id, family, requestId) };
}
