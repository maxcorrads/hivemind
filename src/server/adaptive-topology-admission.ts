import { createHash } from 'node:crypto';
import type { AdmissionDeps } from './services/ports.ts';
import { HiveError, type Agent, type Channel, type Message } from '../shared/types.ts';
import type { TaskContract, TaskSnapshot } from '../shared/tasks.ts';
import type { AdaptiveAgentPolicy, AdaptiveCoordinationEvent } from './adaptive-topology.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';

export function coordinationEventId(actorId: string, family: string, requestId: string): string {
  return createHash('sha256').update(JSON.stringify([actorId, family, requestId])).digest('hex');
}

type Permit = { executionId: string; revision: number; workerId: string; channelId: string | null;
  requestId: string; contractHash: string; expiresAt: number };

/**
 * In-memory admission state of one AdaptiveTopologyRuntime (`deps.adaptiveTopology.admission`):
 * - `permits`: the short-lived pre-action capability per brain (see permitAdaptiveTask);
 * - `lanes`: each brain's serialized coordination tail (see coordinateMutation);
 * - `followUps`: post-commit routing tasks still running (see settleAdaptiveFollowUps).
 */
export class AdaptiveAdmission {
  readonly permits = new Map<string, Permit>();
  readonly lanes = new Map<string, Promise<void>>();
  readonly followUps = new Set<Promise<void>>();
  /** A stopped runtime issues no capability: pending permits are dropped. Lanes and follow-ups drain themselves. */
  dispose(): void { this.permits.clear(); }
}
function contractHash(contract: TaskContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
function stateRevision(deps: AdmissionDeps, executionId: string): number {
  const row = deps.storage.db.prepare("SELECT COALESCE(json_extract(snapshot,'$.revision'),0) AS revision FROM adaptive_topology_executions WHERE execution_id=?")
    .get(executionId);
  if (!row) throw new HiveError(409, 'Adaptive execution changed');
  return Number(row.revision);
}

/** Only the pre-action controller can create this short-lived capability. Never accepted from request JSON. */
export function permitAdaptiveTask(deps: AdmissionDeps, actor: Agent, input: {
  requestId: string; worker: string; channel?: string; contract: TaskContract;
}, policy: AdaptiveAgentPolicy | null): void {
  if (!policy) return;
  const worker = deps.identity.getAgentByName(input.worker);
  if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId)
    throw new HiveError(400, 'Select a worker in this project');
  deps.adaptiveTopology.admission.permits.set(actor.id, { executionId: policy.executionId, revision: stateRevision(deps, policy.executionId),
    workerId: worker.id, channelId: input.channel ? deps.channels.getChannel(input.channel, actor.projectId).id : null,
    requestId: input.requestId, contractHash: contractHash(input.contract), expiresAt: Date.now() + 10_000 });
}
export function clearAdaptivePermit(deps: AdmissionDeps, actorId: string): void {
  deps.adaptiveTopology?.admission.permits.delete(actorId);
}

export function assertAdaptiveWorkerAdmission(deps: AdmissionDeps, actor: Agent, channel: Channel,
  workerIds: string[], policy: AdaptiveAgentPolicy): void {
  if (policy.currentTopology === 'single') throw new HiveError(409, 'Adaptive routing retains Single; new delegation is blocked');
  if (policy.delegationPaused) throw new HiveError(409, 'Adaptive de-escalation pending; finish existing work first');
  const usesRoom = Boolean(deps.rooms.peek(channel.id));
  if (usesRoom !== (policy.currentTopology === 'brain_multi_room'))
    throw new HiveError(409, usesRoom ? 'Applied topology does not permit new room work' : 'Applied topology is Room; new work must use its room contract');
  const capacity = readAdaptiveCapacity(deps, { projectId: channel.projectId, executionId: policy.executionId });
  const chosen = [...new Set(workerIds)];
  let additional = 0;
  for (const id of chosen) {
    const worker = deps.identity.getAgent(id);
    const candidate = capacity.workers.available.find(item => item.id === id);
    if (worker.role !== 'worker' || worker.projectId !== actor.projectId || !candidate ||
      !deps.channels.canSeeChannel(worker, channel) || !deps.channels.canPost(worker, channel))
      throw new HiveError(409, 'A selected worker is no longer available to this execution');
    if (!candidate.committed) additional++;
  }
  if (capacity.activeWorkers + additional > policy.workerBudget)
    throw new HiveError(409, `Applied worker budget is ${policy.workerBudget}; capacity changed before commit`);
}

/** Called inside TaskStore's existing write transaction, before any task/message row is inserted. */
export function admitAdaptiveTask(deps: AdmissionDeps, actor: Agent, task: TaskSnapshot, requestId: string): string | null {
  if (!deps.adaptiveTopology?.hasActive(actor)) return null;
  const permit = deps.adaptiveTopology.admission.permits.get(actor.id);
  // The permit names the execution this assignment was verified against.
  const policy = permit ? deps.adaptiveTopology.forAgent(actor, permit.executionId) : null;
  if (!permit || !policy || permit.expiresAt < Date.now() ||
    permit.revision !== stateRevision(deps, policy.executionId) || permit.requestId !== requestId ||
    permit.workerId !== task.workerId || permit.contractHash !== contractHash(task.contract) ||
    (permit.channelId !== null && permit.channelId !== task.channelId))
    throw new HiveError(409, 'A fresh Jev coordination check is required before this assignment');
  const channel = deps.channels.getChannel(task.channelId, actor.projectId);
  if (permit.channelId === null && channel.type !== 'dm')
    throw new HiveError(409, 'Adaptive assignment destination changed after verification');
  assertAdaptiveWorkerAdmission(deps, actor, channel, [task.workerId], policy);
  return policy.executionId;
}

/** Called after task_records is written but before the same transaction commits. */
export function linkAdaptiveTask(deps: AdmissionDeps, taskId: string, executionId: string | null): void {
  if (!executionId) return;
  const previous = deps.storage.db.prepare('SELECT execution_id FROM adaptive_topology_tasks WHERE task_id=?').get(taskId);
  if (previous && previous.execution_id !== executionId) throw new HiveError(409, 'Task belongs to another adaptive execution');
  deps.storage.db.prepare('INSERT OR IGNORE INTO adaptive_topology_tasks(task_id,execution_id) VALUES(?,?)').run(taskId, executionId);
}

/** postMessage's receipt callback runs inside its transaction: no post-commit reservation race. */
export function bindAdaptiveMessage(deps: AdmissionDeps, actor: Agent, message: Message,
  workerIds: string[], expected: AdaptiveAgentPolicy | null): void {
  if (!expected || workerIds.length === 0) return;
  const current = deps.adaptiveTopology.forAgent(actor, expected.executionId);
  if (!current || current.executionId !== expected.executionId || current.currentTopology !== expected.currentTopology ||
    current.workerBudget !== expected.workerBudget)
    throw new HiveError(409, 'Adaptive policy changed before message delivery');
  const channel = deps.channels.getChannel(message.channelId, actor.projectId);
  if (deps.storage.db.prepare('SELECT status FROM threads WHERE id=?').get(message.threadId ?? message.id)?.status === 'done')
    throw new HiveError(409, 'Delegation thread is completed; start a new assignment instead of reusing closed work');
  assertAdaptiveWorkerAdmission(deps, actor, channel, workerIds, current);
  for (const workerId of new Set(workerIds)) {
    const root = message.threadId ?? message.id;
    const previous = deps.storage.db.prepare('SELECT execution_id FROM adaptive_topology_messages WHERE root_id=? AND worker_id=?').get(root, workerId);
    if (previous && previous.execution_id !== current.executionId)
      throw new HiveError(409, 'This delegation thread belongs to another execution');
    deps.storage.db.prepare(`INSERT OR IGNORE INTO adaptive_topology_messages
      (root_id,worker_id,execution_id,project_id) VALUES(?,?,?,?)`)
      .run(root, workerId, current.executionId, channel.projectId);
  }
}

/** Post-commit routing that must not hold a brain's lane (e.g. project-wide revalidation after capacity changes). */
export type DeferRouting = (label: string, task: () => Promise<unknown>) => void;
function startFollowUps(deps: AdmissionDeps, tasks: Array<[string, () => Promise<unknown>]>): void {
  if (!tasks.length) return;
  const running = deps.adaptiveTopology.admission.followUps;
  for (const [label, task] of tasks) {
    const pending: Promise<void> = Promise.resolve().then(task).then(() => undefined, (error: unknown) => {
      console.error(`Adaptive ${label} failed after commit`, error instanceof Error ? error.message : String(error));
    }).finally(() => { running.delete(pending); });
    running.add(pending);
  }
}
/** Deterministic hook for tests and shutdown: resolves once every started post-commit routing task settled. */
export async function settleAdaptiveFollowUps(deps: AdmissionDeps): Promise<void> {
  const running = deps.adaptiveTopology.admission.followUps;
  while (running.size) await Promise.all(running);
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
export function coordinateMutation<T>(deps: AdmissionDeps, actor: Agent, work: (defer: DeferRouting) => Promise<T>): Promise<T> {
  const map = deps.adaptiveTopology.admission.lanes;
  const deferred: Array<[string, () => Promise<unknown>]> = [];
  const run = () => work((label, task) => { deferred.push([label, task]); });
  const key = actor.id;
  const bypass = actor.role !== 'brain' || (!map.has(key) && !deps.adaptiveTopology.hasActive(actor));
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
  void result.then(() => undefined, () => undefined).finally(() => startFollowUps(deps, deferred));
  return result;
}

export function taskEventIdentity(actor: Agent, family: string, requestId: string): Pick<AdaptiveCoordinationEvent, 'eventId'> {
  return { eventId: coordinationEventId(actor.id, family, requestId) };
}
