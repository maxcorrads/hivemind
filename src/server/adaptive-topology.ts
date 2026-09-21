import { createHash, randomUUID } from 'node:crypto';
import type { Hive } from './hive.ts';
import { HiveError, HUMAN_ID, type Agent, type Message } from '../shared/types.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import { ADAPTIVE_TOPOLOGIES, type AdaptiveExecutionState, type AdaptiveLockScope,
  type AdaptiveRoutingEvent, type AdaptiveRoutingMode, type AdaptiveRoutingView,
  type AdaptiveTopology, type AdaptiveTopologyDecision, type AdaptiveWorkerCapacity } from '../shared/adaptive-topology.ts';
import { loadAdaptiveRouting, type AdaptiveRoutingFile } from './adaptive-routing.ts';
import { advanceTopologyPolicy, initialTopologyPolicy, minimumTopologyWorkers, topologyCheckpointSafe,
  topologyIsEscalation, validTopologyTarget, MIN_TOPOLOGY_CONFIDENCE,
  type TopologyTarget, type TopologyPolicyState, type TopologySafety } from '../shared/adaptive-topology-policy.ts';
import { evaluateAdaptiveTopology, ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
  type TopologyCapacitySnapshot, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { initAdaptiveCommitments, readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import { coordinationEventId } from './adaptive-topology-admission.ts';
import { immediateTransaction } from './transaction.ts';

export { evaluateAdaptiveTopology, ADAPTIVE_TOPOLOGY_CONTRACT_VERSION } from './adaptive-topology-provider.ts';
export type AdaptiveCoordinationEvent = {
  kind: 'brain_message' | 'worker_message' | 'delegation_attempt' | 'task_event' | 'room_event' | 'capacity_change';
  actorId: string; actorRole: 'brain' | 'worker'; channelId?: string; taskId?: string;
  eventType?: string; summary?: string; workerName?: string; usesRoom?: boolean;
  eventId?: string;
};
export type AdaptiveAgentPolicy = {
  executionId: string; currentTopology: AdaptiveTopology; workerBudget: number;
  delegationPaused: boolean; locked: boolean;
};
type StoredExecution = AdaptiveExecutionState & {
  recentEvents: AdaptiveCoordinationEvent[]; confirmationHighCount?: number; revision?: number;
};
type HumanMessageInput = {
  channel: string; body: string; requestId?: string; threadId?: string | null;
  eventType?: Message['eventType']; traceId?: string; causeMessageId?: string;
  attachmentIds?: string[]; recipients?: string[]; source?: 'hive' | 'telegram';
};
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function modeOf(value: string | undefined): AdaptiveRoutingMode {
  if (!value || value === 'auto') return 'auto';
  if (value === 'orchestrated') return 'orchestrated_auto';
  if (value === 'orchestrated_auto' || ADAPTIVE_TOPOLOGIES.includes(value as AdaptiveTopology)) return value as AdaptiveRoutingMode;
  throw new HiveError(400, 'Unknown adaptive routing mode');
}
function scopeOf(value: string | undefined): AdaptiveLockScope {
  if (!value || value === 'none') return 'none';
  if (value === 'task' || value === 'conversation') return value;
  throw new HiveError(400, 'Unknown adaptive routing lock scope');
}
function publicState(stored: StoredExecution): AdaptiveExecutionState {
  const { recentEvents: _recent, confirmationHighCount: _high, ...state } = stored;
  return state;
}
function compactPolicy(state: StoredExecution): AdaptiveAgentPolicy {
  const pending = state.desiredTopology ? { topology: state.desiredTopology, workers: state.desiredWorkers ?? 0 } : null;
  const applied = { topology: state.currentTopology, workers: state.workerBudget };
  return { executionId: state.executionId, currentTopology: state.currentTopology, workerBudget: state.workerBudget,
    delegationPaused: Boolean(pending && !topologyIsEscalation(applied, pending)), locked: state.lockedTopology !== null };
}
function safetyOf(capacity: TopologyCapacitySnapshot): TopologySafety {
  return { usableWorkers: capacity.workers.usableForExecution, activeWorkers: capacity.activeWorkers,
    activeTasks: capacity.activeTasks, openBlockers: capacity.blockers, openDependencies: capacity.openDependencies,
    unreconciledClaims: capacity.unreconciledClaims ?? 0 };
}
function policyOf(state: StoredExecution): TopologyPolicyState {
  return { applied: { topology: state.currentTopology, workers: state.workerBudget },
    pending: state.desiredTopology ? { topology: state.desiredTopology, workers: state.desiredWorkers ?? 0 } : null,
    confirmation: { target: state.confirmationTopology ? { topology: state.confirmationTopology, workers: state.confirmationWorkers ?? 0 } : null,
      count: state.confirmations, highCount: state.confirmationHighCount ?? 0 }, eventsSinceChange: state.eventsSinceChange };
}
function cleanEvent(event: AdaptiveCoordinationEvent): AdaptiveCoordinationEvent {
  return { kind: event.kind, actorId: event.actorId, actorRole: event.actorRole,
    channelId: event.channelId, taskId: event.taskId, eventType: event.eventType,
    workerName: event.workerName, usesRoom: event.usesRoom, eventId: event.eventId };
}
function fallbackDecision(topology: AdaptiveTopology, workers: number): AdaptiveTopologyDecision {
  return { routeId: `route-${randomUUID()}`, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
    targetTopology: topology, targetWorkers: workers, confidence: null, reason: 'jev_disabled_manual_override',
    providerStatus: 'bypassed', model: null, latencyMs: 0, inputTokens: null, outputTokens: null,
    singleSufficient: null, needsOrchestration: null };
}
export function topologyDirective(state: Pick<AdaptiveExecutionState,
  'executionId' | 'currentTopology' | 'workerBudget' | 'lockScope' | 'orchestratedOnly'>): string {
  const labels: Record<AdaptiveTopology, string> = {
    single: 'SINGLE', brain_one_worker: 'BRAIN+1', brain_multi_dm: 'MULTI-DM', brain_multi_room: 'ROOM',
  };
  const instructions: Record<AdaptiveTopology, string> = {
    single: 'Execute this request in the brain session. Do not delegate while Single is active.',
    brain_one_worker: 'Delegate to at most one worker using a structured task/DM.',
    brain_multi_dm: 'Use independent structured tasks/DMs within the worker budget.',
    brain_multi_room: 'Use a Human-authorized room for new delegated work. Existing DM tasks may finish in place.',
  };
  return [`[Hivemind adaptive topology · ${labels[state.currentTopology]} · ${state.executionId}]`,
    instructions[state.currentTopology], `Worker budget: ${state.workerBudget}. The brain chooses the subtasks and specific workers.`,
    'Hivemind revalidates Jev at coordination boundaries; follow the applied policy, not a hypothetical recommendation.',
    state.lockScope === 'none' ? '' : `Human lock: ${state.lockScope}.`].filter(Boolean).join('\n');
}

export class AdaptiveTopologyRuntime {
  private serial = new Map<string, Promise<void>>();
  private stopped = false;
  private abort = new AbortController();
  private readonly onAgent = (agent: Agent) => {
    if (this.stopped || agent.role !== 'worker' || !agent.projectId) return;
    void this.revalidateProject(agent.projectId, {
      kind: 'capacity_change', actorId: agent.id, actorRole: 'worker',
      eventId: `presence:${agent.id}:${agent.lastSeenAt}:${agent.online}`,
    }).catch(() => undefined);
  };
  constructor(private hive: Hive) {
    hive.db.exec(`CREATE TABLE IF NOT EXISTS adaptive_topology_executions (
      channel_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
      brain_id TEXT NOT NULL, root_message_id TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_brain ON adaptive_topology_executions(brain_id,project_id);
      CREATE TABLE IF NOT EXISTS adaptive_topology_events (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_events_channel ON adaptive_topology_events(channel_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS adaptive_topology_locks (channel_id TEXT PRIMARY KEY, topology TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS adaptive_topology_tasks (
        task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE, execution_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_adaptive_topology_tasks_execution ON adaptive_topology_tasks(execution_id);
      CREATE TABLE IF NOT EXISTS adaptive_topology_evaluated (
        execution_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(execution_id,event_id));`);
    initAdaptiveCommitments(hive);
    hive.bus.on('agent', this.onAgent);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort(); this.hive.bus.off('agent', this.onAgent);
    await Promise.allSettled(this.serial.values());
  }
  private queued<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.serial.get(key) ?? Promise.resolve()).then(work);
    const settled = next.then(() => undefined, () => undefined).finally(() => {
      if (this.serial.get(key) === settled) this.serial.delete(key);
    });
    this.serial.set(key, settled); return next;
  }
  private row(channel: string): StoredExecution | null {
    const row = this.hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE channel_id=?').get(channel);
    return row ? JSON.parse(String(row.snapshot)) as StoredExecution : null;
  }
  private save(state: StoredExecution) {
    this.hive.db.prepare(`INSERT INTO adaptive_topology_executions
      (channel_id,execution_id,project_id,brain_id,root_message_id,snapshot) VALUES(?,?,?,?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET execution_id=excluded.execution_id,project_id=excluded.project_id,
      brain_id=excluded.brain_id,root_message_id=excluded.root_message_id,snapshot=excluded.snapshot`)
      .run(state.channelId, state.executionId, state.projectId, state.brainId, state.rootMessageId, JSON.stringify(state));
  }
  private conversationLock(channel: string): AdaptiveTopology | null {
    const row = this.hive.db.prepare('SELECT topology FROM adaptive_topology_locks WHERE channel_id=?').get(channel);
    return typeof row?.topology === 'string' && ADAPTIVE_TOPOLOGIES.includes(row.topology as AdaptiveTopology) ? row.topology as AdaptiveTopology : null;
  }
  private conversationLockWrite(channel: string, topology: AdaptiveTopology | null) {
    if (topology === null) this.hive.db.prepare('DELETE FROM adaptive_topology_locks WHERE channel_id=?').run(channel);
    else this.hive.db.prepare(`INSERT INTO adaptive_topology_locks(channel_id,topology,updated_at) VALUES(?,?,?)
      ON CONFLICT(channel_id) DO UPDATE SET topology=excluded.topology,updated_at=excluded.updated_at`).run(channel, topology, Date.now());
  }
  private capacity(state: Pick<StoredExecution, 'projectId' | 'executionId'>): TopologyCapacitySnapshot {
    return readAdaptiveCapacity(this.hive, state);
  }
  private snapshot(state: StoredExecution, event: AdaptiveCoordinationEvent, capacity = this.capacity(state)): TopologyEvaluationSnapshot {
    const project = this.hive.getProject(state.projectId);
    return { request: this.hive.getMessageById(state.rootMessageId).body,
      project: { slug: project.slug, name: project.name },
      current: { topology: state.currentTopology, workerBudget: state.workerBudget,
        desiredTopology: state.desiredTopology, desiredWorkers: state.desiredWorkers },
      capacity, execution: { orchestratedOnly: state.orchestratedOnly, lockScope: state.lockScope, lockedTopology: state.lockedTopology },
      tasks: { active: capacity.activeTasks, activeWorkers: capacity.activeWorkers, blockers: capacity.blockers,
        openDependencies: capacity.openDependencies, workstreams: capacity.workstreams },
      recentCoordinationEvents: state.recentEvents.map(cleanEvent),
      trigger: { ...cleanEvent(event), summary: event.summary?.trim().slice(0, 400) }, previousDecision: state.recommendation };
  }
  private record(state: StoredExecution, decision: AdaptiveTopologyDecision, from: AdaptiveTopology,
    kind: AdaptiveRoutingEvent['kind'], changed = false): AdaptiveRoutingEvent {
    return { id: randomUUID(), executionId: state.executionId, channelId: state.channelId, projectId: state.projectId,
      createdAt: state.updatedAt, kind, fromTopology: from, targetTopology: decision.targetTopology,
      appliedTopology: state.currentTopology, targetWorkers: decision.targetWorkers, appliedWorkers: state.workerBudget,
      confidence: decision.confidence, reason: decision.reason, providerStatus: decision.providerStatus,
      applied: changed, warning: state.warning };
  }
  private saveEvent(event: AdaptiveRoutingEvent) {
    this.hive.db.prepare(`INSERT INTO adaptive_topology_events(id,execution_id,channel_id,project_id,created_at,snapshot)
      VALUES(?,?,?,?,?,?)`).run(event.id, event.executionId, event.channelId, event.projectId, event.createdAt, JSON.stringify(event));
    this.hive.db.prepare(`DELETE FROM adaptive_topology_events WHERE channel_id=? AND rowid NOT IN
      (SELECT rowid FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 500)`).run(event.channelId, event.channelId);
  }
  private commit(state: StoredExecution, event: AdaptiveRoutingEvent, evidenceId?: string) {
    immediateTransaction(this.hive.db, () => {
      this.save(state); this.saveEvent(event);
      if (evidenceId) this.hive.db.prepare('INSERT OR IGNORE INTO adaptive_topology_evaluated(execution_id,event_id) VALUES(?,?)')
        .run(state.executionId, evidenceId);
    });
    this.publish(state, event);
  }
  private publish(state: StoredExecution, event: AdaptiveRoutingEvent) {
    this.hive.bus.emit('adaptive-routing', { channelId: state.channelId, state: publicState(state), event });
  }
  private assertEventActor(actor: Agent, event: AdaptiveCoordinationEvent) {
    if (actor.id !== event.actorId || actor.role !== event.actorRole || !['brain', 'worker'].includes(actor.role))
      throw new HiveError(403, 'Routing event identity does not match the authenticated actor');
    if (event.channelId) {
      const channel = this.hive.getChannel(event.channelId, actor.projectId);
      if (!this.hive.canSeeChannel(actor, channel) || !this.hive.canPost(actor, channel)) throw new HiveError(403, 'Cannot coordinate in this channel');
    }
    if (event.taskId) {
      const task = this.hive.tasks.get(actor, event.taskId);
      if (actor.id !== task.assignerId && actor.id !== task.workerId) throw new HiveError(403, 'Only task participants can affect execution routing');
    }
    if (event.workerName) {
      const worker = this.hive.getAgentByName(event.workerName);
      if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId) throw new HiveError(400, 'Select a worker in the current project');
    }
  }
  private resolveState(actor: Agent, event?: AdaptiveCoordinationEvent): StoredExecution | null {
    if (!actor.projectId) return null;
    let brainId = actor.role === 'brain' ? actor.id : null;
    if (event?.taskId) {
      const task = this.hive.tasks.get(actor, event.taskId); brainId = task.assignerId;
      const link = this.hive.db.prepare('SELECT execution_id FROM adaptive_topology_tasks WHERE task_id=?').get(task.id);
      if (link) {
        const row = this.hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE execution_id=? AND project_id=?')
          .get(String(link.execution_id), actor.projectId);
        return row ? JSON.parse(String(row.snapshot)) as StoredExecution : null;
      }
    }
    if (!brainId && event?.channelId) {
      const channel = this.hive.getChannel(event.channelId, actor.projectId);
      const coordinator = this.hive.rooms.peek(channel.id)?.coordinatorId;
      const brains = channel.memberIds.map(id => this.hive.getAgent(id)).filter(a => a.role === 'brain');
      if (coordinator) brainId = coordinator;
      else if (channel.type === 'dm' && brains.length === 1) brainId = brains[0]!.id;
    }
    if (!brainId) return null;
    const rows = this.hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE brain_id=? AND project_id=?').all(brainId, actor.projectId);
    if (rows.length > 1) throw new HiveError(409, 'Ambiguous execution: use the task thread');
    return rows[0] ? JSON.parse(String(rows[0].snapshot)) as StoredExecution : null;
  }
  private enabledOrLocked(state: StoredExecution): boolean { return Boolean(loadAdaptiveRouting(this.hive.home)?.enabled || state.lockedTopology); }
  private async evaluateStable(state: StoredExecution, event: AdaptiveCoordinationEvent, config: AdaptiveRoutingFile) {
    let capacity = this.capacity(state), decision: AdaptiveTopologyDecision | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const signature = fingerprint(capacity.workers.available);
      decision = await evaluateAdaptiveTopology(this.snapshot(state, event, capacity), config, { signal: this.abort.signal });
      const next = this.capacity(state);
      if (decision.providerStatus !== 'ok' || signature === fingerprint(next.workers.available)) return { decision, capacity: next };
      capacity = next;
    }
    return { capacity, decision: { ...decision!, providerStatus: 'unavailable' as const, confidence: null,
      reason: 'capacity_changed_during_evaluation_preserve_current', targetTopology: state.currentTopology, targetWorkers: state.workerBudget } };
  }
  private async revalidateStored(state: StoredExecution, event: AdaptiveCoordinationEvent): Promise<StoredExecution> {
    const config = loadAdaptiveRouting(this.hive.home);
    if (!config?.enabled || this.stopped) return state;
    if (event.eventId && this.hive.db.prepare('SELECT 1 FROM adaptive_topology_evaluated WHERE execution_id=? AND event_id=?')
      .get(state.executionId, event.eventId)) return state;
    const from = state.currentTopology, revision = state.revision ?? 0;
    const { decision, capacity } = await this.evaluateStable(state, event, config);
    const latest = this.row(state.channelId);
    if (!latest || latest.executionId !== state.executionId || (latest.revision ?? 0) !== revision ||
      !loadAdaptiveRouting(this.hive.home)?.enabled || this.stopped) return latest ?? state;
    const forced: TopologyTarget | null = state.lockedTopology ? { topology: state.lockedTopology,
      workers: state.lockedTopology === 'single' ? 0 : state.lockedTopology === state.currentTopology
        ? state.workerBudget : Math.max(minimumTopologyWorkers(state.lockedTopology), state.desiredWorkers ?? 0) } : null;
    const next = advanceTopologyPolicy(policyOf(state), { target: { topology: decision.targetTopology, workers: decision.targetWorkers },
      confidence: decision.confidence, available: decision.providerStatus === 'ok' }, safetyOf(capacity), forced);
    state.currentTopology = next.applied.topology; state.workerBudget = next.applied.workers;
    state.desiredTopology = next.pending?.topology ?? null; state.desiredWorkers = next.pending?.workers ?? null;
    state.confirmations = next.confirmation.count; state.confirmationHighCount = next.confirmation.highCount;
    state.confirmationTopology = next.confirmation.target?.topology ?? null; state.confirmationWorkers = next.confirmation.target?.workers ?? null;
    state.eventsSinceChange = next.eventsSinceChange; state.recommendation = decision;
    state.providerAvailable = decision.providerStatus === 'ok';
    state.warning = !state.providerAvailable ? 'Jev unavailable · execution mode is not being revalidated' : null;
    if (!forced && decision.providerStatus === 'ok' && capacity.workers.usableForExecution === 0 && (decision.needsOrchestration || state.orchestratedOnly)) {
      state.warning = 'Orchestration needed · no workers available'; state.desiredTopology = config.topologyFallback;
      state.desiredWorkers = minimumTopologyWorkers(config.topologyFallback);
    }
    state.recentEvents = [...state.recentEvents, cleanEvent(event)].slice(-8);
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = revision + 1;
    this.commit(state, this.record(state, decision, from, next.changed ? 'transition' : state.warning ? 'warning' : 'evaluation', next.changed), event.eventId);
    return state;
  }
  async revalidateForActor(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    this.assertEventActor(actor, event);
    const state = this.resolveState(actor, event);
    if (!state || !this.enabledOrLocked(state)) return null;
    const updated = await this.queued(state.channelId, () => this.revalidateStored(this.row(state.channelId) ?? state, event));
    return this.enabledOrLocked(updated) ? compactPolicy(updated) : null;
  }
  private async revalidateProject(projectId: string, event: AdaptiveCoordinationEvent, exceptExecution?: string) {
    const rows = this.hive.db.prepare('SELECT snapshot FROM adaptive_topology_executions WHERE project_id=?').all(projectId);
    for (const row of rows) {
      const state = JSON.parse(String(row.snapshot)) as StoredExecution;
      if (state.executionId === exceptExecution) continue;
      await this.queued(state.channelId, () => this.revalidateStored(this.row(state.channelId) ?? state, event));
    }
  }
  private assertDelegation(state: StoredExecution, event: AdaptiveCoordinationEvent) {
    if (event.kind !== 'delegation_attempt' || !this.enabledOrLocked(state)) return;
    if (compactPolicy(state).delegationPaused) throw new HiveError(409, 'Adaptive de-escalation pending; finish existing work before new delegation');
    if (state.currentTopology === 'single') throw new HiveError(409, 'Adaptive routing retains Single; new delegation is blocked');
    if (event.usesRoom === true && state.currentTopology !== 'brain_multi_room') throw new HiveError(409, `Applied topology ${state.currentTopology} does not permit new room work`);
    if (event.usesRoom === false && state.currentTopology === 'brain_multi_room') throw new HiveError(409, 'Applied topology is Room; new work must use the room contract');
    const worker = event.workerName ? this.hive.getAgentByName(event.workerName) : null;
    if (worker) {
      const capacity = this.capacity(state), candidate = capacity.workers.available.find(w => w.id === worker.id);
      if (!candidate) throw new HiveError(409, 'Selected worker is not available for this execution');
      if (!candidate.committed && capacity.activeWorkers >= state.workerBudget) throw new HiveError(409, `Applied worker budget is ${state.workerBudget}; no additional slot is available`);
    }
  }
  async beforeBrainAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    if (actor.role !== 'brain') return null;
    const tokenHash = this.hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash;
    const state = await this.revalidateForActor(actor, event);
    if (tokenHash !== this.hive.db.prepare('SELECT token_hash FROM agents WHERE id=?').get(actor.id)?.token_hash) throw new HiveError(401, 'Credentials changed during routing; rejoin before retrying');
    if (!state) return null;
    const current = this.resolveState(actor, event);
    if (current) this.assertDelegation(current, event);
    return current && this.enabledOrLocked(current) ? compactPolicy(current) : null;
  }
  async afterAgentAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    if (!['brain', 'worker'].includes(actor.role)) return null;
    return this.revalidateForActor(actor, event);
  }
  async capacityChanged(actor: Agent, eventId: string, exceptExecution?: string): Promise<void> {
    if (!actor.projectId || !['brain','worker'].includes(actor.role)) return;
    await this.revalidateProject(actor.projectId, { kind: 'capacity_change', actorId: actor.id,
      actorRole: actor.role as 'brain' | 'worker', eventId: coordinationEventId(actor.id, 'capacity', eventId) }, exceptExecution);
  }
  forAgent(actor: Agent): AdaptiveAgentPolicy | null {
    const state = this.resolveState(actor);
    return state && this.enabledOrLocked(state) ? compactPolicy(state) : null;
  }
  private feasibleFallback(config: AdaptiveRoutingFile, capacity: AdaptiveWorkerCapacity): AdaptiveTopology {
    if (capacity.usableForExecution >= minimumTopologyWorkers(config.topologyFallback)) return config.topologyFallback;
    return capacity.usableForExecution >= 1 ? 'brain_one_worker' : 'single';
  }
  private manualBudget(topology: AdaptiveTopology, proposed: number, capacity: AdaptiveWorkerCapacity): number {
    return topology === 'single' ? 0 : topology === 'brain_one_worker' ? 1 : Math.max(2, Math.min(proposed || 2, capacity.usableForExecution));
  }
  async routeHumanRequest(human: Agent, input: HumanMessageInput, rawMode: string | undefined,
    rawScope: string | undefined, persistReceipt?: (message: Message) => void) {
    if (human.role !== 'human') throw new HiveError(403, 'Only Human starts adaptive execution');
    const channel = this.hive.getChannel(input.channel);
    const brains = channel.memberIds.map(id => this.hive.getAgent(id)).filter(a => a.role === 'brain');
    if (channel.type !== 'dm' || !channel.memberIds.includes(HUMAN_ID) || brains.length !== 1) throw new HiveError(400, 'Adaptive topology requires a Human-to-brain DM');
    const mode = modeOf(rawMode), scope = scopeOf(rawScope), brain = brains[0]!;
    const manual = ADAPTIVE_TOPOLOGIES.includes(mode as AdaptiveTopology) ? mode as AdaptiveTopology : null;
    if (scope !== 'none' && !manual) throw new HiveError(400, 'Locks require an explicit topology');
    return this.queued(channel.id, async () => {
      if (this.hive.hasActiveSendRequest(human, channel.id, input.requestId)) return null;
      const config = loadAdaptiveRouting(this.hive.home), inherited = manual ? null : this.conversationLock(channel.id);
      if (!config?.enabled && mode === 'auto' && !inherited) return null;
      const previous = this.row(channel.id);
      if (previous) {
        const outstanding = this.capacity(previous);
        if (outstanding.activeTasks > 0 || (outstanding.unreconciledClaims ?? 0) > 0) throw new HiveError(409, 'The current execution still has delegated work; continue in its thread or reconcile it before a new request');
      }
      const locked = manual ?? inherited;
      const lockScope: AdaptiveLockScope = manual ? scope : inherited ? 'conversation' : 'none';
      const executionId = `execution-${randomUUID()}`, project = this.hive.getProject(channel.projectId);
      let capacity = this.capacity({ projectId: channel.projectId, executionId });
      const makeSnapshot = (): TopologyEvaluationSnapshot => ({ request: input.body,
        project: { slug: project.slug, name: project.name }, current: null, capacity,
        execution: { orchestratedOnly: mode === 'orchestrated_auto', lockScope, lockedTopology: locked },
        tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
        recentCoordinationEvents: [], trigger: { kind: 'human_request' }, previousDecision: null });
      let decision = fallbackDecision(locked ?? 'single', minimumTopologyWorkers(locked ?? 'single'));
      let stable = !config?.enabled;
      if (config?.enabled) for (let attempt = 0; attempt < 3; attempt++) {
        const signature = fingerprint(capacity.workers.available);
        decision = await evaluateAdaptiveTopology(makeSnapshot(), config, { signal: this.abort.signal });
        capacity = this.capacity({ projectId: channel.projectId, executionId });
        stable = signature === fingerprint(capacity.workers.available);
        if (decision.providerStatus !== 'ok' || stable) break;
      }
      if (this.stopped) throw new HiveError(503, 'Server is shutting down');
      // The Human toggle/lock wins over an in-flight classifier request.
      const currentConfig = loadAdaptiveRouting(this.hive.home);
      if (!currentConfig?.enabled && config?.enabled && !locked) return null;
      if (fingerprint(previous) !== fingerprint(this.row(channel.id)) || inherited !== (manual ? null : this.conversationLock(channel.id)))
        throw new HiveError(409, 'Human routing state changed; review and retry the request');
      if (decision.providerStatus === 'ok' && (!stable || !validTopologyTarget({ topology: decision.targetTopology, workers: decision.targetWorkers }, capacity.workers.usableForExecution)))
        decision = { ...decision, providerStatus: 'unavailable', confidence: null, reason: 'capacity_changed_during_initial_routing', targetTopology: 'single', targetWorkers: 0 };
      const uncertain = decision.providerStatus !== 'ok' || (decision.confidence ?? 0) < MIN_TOPOLOGY_CONFIDENCE;
      let actual = locked ?? decision.targetTopology;
      if (!locked && uncertain) actual = currentConfig?.fallback === 'single' ? 'single'
        : currentConfig ? this.feasibleFallback(currentConfig, capacity.workers) : 'single';
      if (!locked && mode === 'orchestrated_auto' && actual === 'single' && capacity.workers.usableForExecution > 0)
        actual = currentConfig ? this.feasibleFallback(currentConfig, capacity.workers) : 'brain_one_worker';
      const required = minimumTopologyWorkers(actual);
      if (manual && required > capacity.workers.usableForExecution) throw new HiveError(409, `${manual} needs ${required} available workers; only ${capacity.workers.usableForExecution} are available`);
      let budget = locked || uncertain || actual !== decision.targetTopology
        ? this.manualBudget(actual, decision.targetWorkers, capacity.workers) : decision.targetWorkers;
      let desired: TopologyTarget | null = null;
      let warning = decision.providerStatus === 'unavailable' ? 'Jev unavailable · initial mode used fallback' : null;
      if (required > capacity.workers.usableForExecution || budget > capacity.workers.usableForExecution) {
        desired = { topology: actual, workers: required }; actual = 'single'; budget = 0;
        warning = 'Requested topology is waiting for worker capacity';
      }
      if (!locked && capacity.workers.usableForExecution === 0 && (decision.needsOrchestration || mode === 'orchestrated_auto')) {
        const target = currentConfig?.topologyFallback ?? 'brain_one_worker';
        desired = { topology: target, workers: minimumTopologyWorkers(target) }; warning = 'Orchestration needed · no workers available';
      }
      const policy = initialTopologyPolicy({ topology: actual, workers: budget });
      const state: StoredExecution = { executionId, channelId: channel.id, projectId: channel.projectId, brainId: brain.id, rootMessageId: '',
        currentTopology: actual, workerBudget: budget, desiredTopology: desired?.topology ?? null, desiredWorkers: desired?.workers ?? null,
        lockedTopology: locked, lockScope, orchestratedOnly: mode === 'orchestrated_auto', providerAvailable: decision.providerStatus !== 'unavailable',
        warning, recommendation: decision, confirmations: 0, confirmationHighCount: 0, confirmationTopology: null, confirmationWorkers: null,
        eventsSinceChange: policy.eventsSinceChange, updatedAt: Date.now(), recentEvents: [], revision: 1 };
      let item!: AdaptiveRoutingEvent;
      const delivered = this.hive.postAdaptiveRequest(human, input, topologyDirective(state), `adaptive-${executionId}`, persistReceipt, message => {
        state.rootMessageId = message.id;
        if (manual && scope === 'conversation') this.conversationLockWrite(channel.id, manual);
        this.save(state);
        if (previous) this.hive.db.prepare('DELETE FROM adaptive_topology_evaluated WHERE execution_id=?').run(previous.executionId);
        item = this.record(state, decision, actual, warning ? 'warning' : locked ? 'lock' : 'evaluation', false); this.saveEvent(item);
      });
      this.publish(state, item);
      return { ...delivered, routing: decision, state: publicState(state) };
    });
  }
  view(actor: Agent, channelId: string): AdaptiveRoutingView {
    if (actor.role !== 'human') throw new HiveError(403, 'Adaptive routing timeline is Human-only');
    const channel = this.hive.getChannel(channelId);
    if (!this.hive.canSeeChannel(actor, channel)) throw new HiveError(403, 'Cannot read routing state');
    const state = this.row(channel.id);
    const events = this.hive.db.prepare('SELECT snapshot FROM adaptive_topology_events WHERE channel_id=? ORDER BY rowid DESC LIMIT 100')
      .all(channel.id).map(row => JSON.parse(String(row.snapshot)) as AdaptiveRoutingEvent).reverse();
    return { state: state ? publicState(state) : null, events };
  }
  setLock(actor: Agent, channelId: string, raw: unknown): AdaptiveRoutingView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human changes routing locks');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HiveError(400, 'Expected lock settings');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !['scope','topology'].includes(key)) || typeof input.scope !== 'string') throw new HiveError(400, 'Expected an explicit lock scope');
    const scope = scopeOf(input.scope);
    const topology = typeof input.topology === 'string' && ADAPTIVE_TOPOLOGIES.includes(input.topology as AdaptiveTopology) ? input.topology as AdaptiveTopology : null;
    if (scope !== 'none' && !topology) throw new HiveError(400, 'Choose a topology to lock');
    const state = this.row(this.hive.getChannel(channelId).id);
    if (!state) throw new HiveError(404, 'No adaptive execution in this DM');
    const from = state.currentTopology;
    state.lockScope = scope; state.lockedTopology = scope === 'none' ? null : topology;
    const capacity = this.capacity(state);
    if (scope === 'none') { state.desiredTopology = null; state.desiredWorkers = null; }
    else {
      const target = { topology: topology!, workers: this.manualBudget(topology!, state.workerBudget, capacity.workers) };
      state.desiredTopology = target.topology; state.desiredWorkers = target.workers;
      if (topologyCheckpointSafe(target, safetyOf(capacity))) {
        state.currentTopology = target.topology; state.workerBudget = target.workers;
        state.desiredTopology = null; state.desiredWorkers = null; state.eventsSinceChange = 0;
      }
    }
    state.confirmations = 0; state.confirmationHighCount = 0; state.confirmationTopology = null; state.confirmationWorkers = null;
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = (state.revision ?? 0) + 1;
    const decision = { ...fallbackDecision(topology ?? state.currentTopology, state.desiredWorkers ?? state.workerBudget), reason: scope === 'none' ? 'human_unlock' : 'human_lock' };
    const item = this.record(state, decision, from, 'lock', from !== state.currentTopology);
    immediateTransaction(this.hive.db, () => {
      if (scope === 'none' || scope === 'conversation') this.conversationLockWrite(channelId, scope === 'none' ? null : topology);
      this.save(state); this.saveEvent(item);
    });
    this.publish(state, item); return this.view(actor, channelId);
  }
}
