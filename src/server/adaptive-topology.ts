import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AdaptiveRuntimeDeps } from "./services/ports.ts";
import { parseMentions } from '../shared/mentions.ts';
import { HiveError, type Agent, type Channel, type Message, type ThreadStatus } from '../shared/types.ts';
import { ADAPTIVE_TOPOLOGIES, type AdaptiveExecutionState, type AdaptiveLockScope,
  type AdaptiveRoutingEvent, type AdaptiveRoutingMode, type AdaptiveRoutingView,
  type AdaptiveTopology, type AdaptiveTopologyDecision, type AdaptiveWorkerCapacity } from '../shared/adaptive-topology.ts';
import { loadAdaptiveRouting, type AdaptiveRoutingFile } from './adaptive-config.ts';
import { advanceTopologyPolicy, initialTopologyPolicy, minimumTopologyWorkers, topologyCheckpointSafe,
  topologyIsEscalation, validTopologyTarget,
  type TopologyTarget, type TopologyPolicyState, type TopologySafety } from '../shared/adaptive-topology-policy.ts';
import { ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
  type TopologyCapacitySnapshot, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { AdaptiveObservationStores, observeTopologyEvaluation } from './adaptive-evidence-observer.ts';
import { openDelegations, readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import { AdaptiveAdmission, coordinationEventId } from './adaptive-topology-admission.ts';
import { AdaptiveTopologyStore } from './adaptive-topology-store.ts';
import type { JevCallSummary } from '../shared/jev-calls.ts';
import { jevDecisionActionable, jevNotUsedLabel, topologyName } from '../shared/jev-outcome.ts';

export { evaluateAdaptiveTopology, ADAPTIVE_TOPOLOGY_CONTRACT_VERSION } from './adaptive-topology-provider.ts';
// Workers never drive Jev: only Human requests and brain coordination are evaluated.
export type AdaptiveCoordinationEvent = {
  kind: 'brain_message' | 'human_message' | 'delegation_attempt' | 'task_event' | 'room_event' | 'capacity_change';
  actorId: string; actorRole: 'brain' | 'human'; channelId?: string; taskId?: string; threadId?: string;
  eventType?: string; summary?: string; workerName?: string; usesRoom?: boolean; eventId?: string;
  /** Brain-declared attribution; required for delegation while the brain has active executions. */
  executionId?: string;
};
export type AdaptiveAgentPolicy = {
  executionId: string; currentTopology: AdaptiveTopology; workerBudget: number;
  delegationPaused: boolean; locked: boolean;
};
type StoredExecution = AdaptiveExecutionState & {
  recentEvents: AdaptiveCoordinationEvent[]; confirmationHighCount?: number; revision?: number;
  /** The Human message classified as the request; rootMessageId is its thread root. */
  requestMessageId?: string;
  /**
   * Set when a newer Human request replaced this execution while it still had delegated work: the successor's
   * executionId, or 'human_message' for an unrouted request. It keeps draining until that work ends.
   * Mirrors the `current=0` column, which is the authority for lookups.
   */
  supersededBy?: string | null;
};
export type RoutedHumanMessage = {
  message: Message; routingMessage: Message | undefined; routingMessages: Message[];
  routing: AdaptiveTopologyDecision; routings: AdaptiveTopologyDecision[];
  state: AdaptiveExecutionState; states: AdaptiveExecutionState[];
};
type HumanMessageInput = {
  channel: string; body: string; requestId?: string; threadId?: string | null;
  eventType?: Message['eventType']; traceId?: string; causeMessageId?: string;
  attachmentIds?: string[]; recipients?: string[]; source?: 'hive' | 'telegram';
};
// Only non-secret capacity/execution snapshots are fingerprinted. Compare settings in memory instead.
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function requestText(message: Pick<Message, 'body' | 'source'>): string {
  return message.source === 'telegram' ? message.body.replace(/^\[[^\]\r\n]*\]\s?/, '') : message.body;
}
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
  const { recentEvents: _recent, confirmationHighCount: _high, requestMessageId: _request, ...state } = stored;
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
  return { kind: event.kind, actorId: event.actorId, actorRole: event.actorRole, channelId: event.channelId,
    taskId: event.taskId, eventType: event.eventType, workerName: event.workerName, usesRoom: event.usesRoom, eventId: event.eventId };
}
function fallbackDecision(topology: AdaptiveTopology, workers: number): AdaptiveTopologyDecision {
  return { routeId: `route-${randomUUID()}`, contractVersion: ADAPTIVE_TOPOLOGY_CONTRACT_VERSION,
    targetTopology: topology, targetWorkers: workers, confidence: null, reason: 'jev_disabled_manual_override',
    providerStatus: 'bypassed', model: null, latencyMs: 0, inputTokens: null, outputTokens: null,
    singleSufficient: null, needsOrchestration: null };
}
export function topologyDirective(state: Pick<AdaptiveExecutionState,
  'executionId' | 'currentTopology' | 'workerBudget' | 'lockScope' | 'orchestratedOnly'>, brainName?: string): string {
  const labels: Record<AdaptiveTopology, string> = { single: 'SINGLE', brain_one_worker: 'BRAIN+1', brain_multi_dm: 'MULTI-DM', brain_multi_room: 'ROOM' };
  const instructions: Record<AdaptiveTopology, string> = {
    single: 'Execute this request in the brain session. Do not delegate while Single is active.',
    brain_one_worker: 'Delegate to at most one worker using a structured task/DM.',
    brain_multi_dm: 'Use independent structured tasks/DMs within the worker budget.',
    brain_multi_room: 'Use a Human-authorized room for new delegated work. Existing DM tasks may finish in place.',
  };
  return [`[Hivemind adaptive topology · ${labels[state.currentTopology]} · ${state.executionId}]`,
    brainName ? `Brain: @${brainName}.` : '',
    instructions[state.currentTopology], `Worker budget: ${state.workerBudget}. The brain chooses the subtasks and specific workers.`,
    `Pass executionId "${state.executionId}" on every coordination action for this request; delegation without it is rejected while an execution is active.`,
    'Hivemind revalidates Jev at coordination boundaries; follow the applied policy, not a hypothetical recommendation.',
    state.lockScope === 'none' ? '' : `Human lock: ${state.lockScope}.`].filter(Boolean).join('\n');
}

const parseExecution = (row: Record<string, unknown>) => JSON.parse(String(row.snapshot)) as StoredExecution;
/** Other executions revalidated at once after a capacity change; each channel still runs one at a time. */
const PROJECT_REVALIDATION_CONCURRENCY = 4;

export class AdaptiveTopologyRuntime {
  private serial = new Map<string, Promise<void>>();
  private stopped = false;
  private abort = new AbortController();
  /** Permits, per-brain lanes and post-commit follow-ups of adaptive actions; permits are dropped on stop(). */
  readonly admission = new AdaptiveAdmission();
  /** Evidence and Jev call history stores for this hive's database. */
  readonly observations: AdaptiveObservationStores;
  /** Executions, locks, routing events and delegation links (every adaptive_topology_* statement). */
  readonly store: AdaptiveTopologyStore;
  /** Hive calls this after every committed message (the name predates worker reports). */
  humanMessageCommitted(message: Message): void {
    if (this.stopped) return;
    // Any activity may be the end of a draining execution's work (e.g. a worker declining its task).
    if (message.authorRole === 'worker' && message.kind === 'chat') this.workerReported(message);
    this.settleDrained(this.deps.channels.getChannel(message.channelId).projectId);
    if (message.kind !== 'chat') return;
    if (message.authorRole !== 'human' || message.threadId) return;
    // A new Human request to the same brain in the same channel replaces its previous execution,
    // and a legacy (unrouted) request must not resurrect an older execution on re-enable.
    const channel = this.deps.channels.getChannel(message.channelId);
    for (const brain of this.requestOwners(channel, message.body).owners) {
      const state = this.row(channel.id, brain.id);
      if (!state || state.completedAt || state.rootMessageId === message.id) continue;
      if (message.seq <= this.deps.messageQueries.getMessageById(state.rootMessageId).seq) continue;
      const item = this.deps.storage.transaction(() => this.retire(state, null));
      if (item) this.publish(state, item);
    }
  }
  /**
   * A free-form delegation also ends when its worker reports the outcome in the delegation thread: a decision, or an
   * acknowledgement carrying evidence. A bare acknowledgement only confirms receipt. There is no idle timeout.
   */
  private workerReported(message: Message) {
    const finished = message.eventType === 'decision' || (message.eventType === 'acknowledgement' && Boolean(message.attachments?.length));
    if (!finished || !message.threadId) return;
    this.store.releaseDelegation(message.threadId, message.authorId);
  }
  /** Which brains own a Human request: room coordinator, then mentioned brains, then the only brain. */
  requestOwners(channel: Channel, body: string): { brains: Agent[]; owners: Agent[] } {
    const brains = channel.memberIds.map(id => this.deps.identity.getAgent(id)).filter(agent => agent.role === 'brain');
    if (!brains.length) return { brains, owners: [] };
    const coordinator = this.deps.rooms.peek(channel.id)?.coordinatorId;
    const lead = coordinator ? brains.find(brain => brain.id === coordinator) : undefined;
    if (lead) return { brains, owners: [lead] };
    const mentioned = new Set(parseMentions(body, brains));
    const named = brains.filter(brain => mentioned.has(brain.id));
    if (named.length) return { brains, owners: named };
    return { brains, owners: brains.length === 1 ? brains : [] };
  }
  constructor(private readonly deps: AdaptiveRuntimeDeps) {
    this.observations = new AdaptiveObservationStores(deps.storage, health => deps.bus.emit('evidence-health', health));
    this.store = new AdaptiveTopologyStore(deps.storage);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort();
    await Promise.allSettled(this.serial.values());
    this.admission.dispose();
    // A graceful restart persists held gap markers when the store accepts writes again; a crash cannot.
    this.observations.collector.flush(() => this.observations.evidence);
  }
  private queued<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const next = (this.serial.get(key) ?? Promise.resolve()).then(work);
    const settled = next.then(() => undefined, () => undefined).finally(() => {
      if (this.serial.get(key) === settled) this.serial.delete(key);
    });
    this.serial.set(key, settled); return next;
  }
  private displayState(state: StoredExecution): AdaptiveExecutionState {
    const enabled = Boolean(loadAdaptiveRouting(this.deps.home)?.enabled);
    const display: AdaptiveExecutionState = { ...publicState(state), current: !state.supersededBy,
      monitoring: state.completedAt ? 'completed' : !enabled ? 'disabled'
        : state.providerAvailable ? 'active' : state.recommendation?.providerStatus === 'unavailable' ? 'unavailable' : 'pending' };
    if (state.supersededBy && !state.completedAt) {
      // The Human sees which older request is still finishing and how much delegated work keeps it open.
      const delegations = new Set(openDelegations(this.deps, { executionId: state.executionId }).map(row => String(row.root_id))).size;
      display.openWork = { tasks: Math.max(0, this.capacity(state).activeTasks - delegations), delegations };
      const request = this.deps.messageQueries.getMessageById(state.requestMessageId ?? state.rootMessageId);
      const text = requestText(request).replace(/\s+/g, ' ').trim();
      display.requestExcerpt = text.length > 140 ? `${text.slice(0, 139)}…` : text;
    }
    const jevCalled = Boolean(state.recommendation && state.recommendation.providerStatus !== 'bypassed');
    const evidence = this.observations.capture(state.executionId, jevCalled);
    if (evidence) display.evidence = evidence;
    return display;
  }
  /** The brain's current execution in this channel; draining predecessors are reached by id, task or thread. */
  private row(channel: string, brain: string): StoredExecution | null {
    const row = this.store.currentExecution(channel, brain);
    return row ? parseExecution(row) : null;
  }
  /** Every execution in the channel, current ones and those still draining or superseded. */
  private rows(channel: string): StoredExecution[] {
    return this.store.channelExecutions(channel).map(parseExecution);
  }
  private byExecution(executionId: string): StoredExecution | null {
    const row = this.store.execution(executionId);
    return row ? parseExecution(row) : null;
  }
  /** Executions whose policy currently binds this brain: current ones first, then those still draining. */
  private activeFor(brainId: string, projectId: string): StoredExecution[] {
    return this.store.brainExecutions(brainId, projectId).map(parseExecution).filter(state => this.enabledOrLocked(state));
  }
  /** Inserting a new execution requires its (channel, brain) predecessor to be retired first (unique current). */
  private save(state: StoredExecution) {
    this.store.saveExecution(state);
  }
  private forget(executionId: string) {
    this.store.forgetExecution(executionId);
  }
  /** Delegated work that keeps an execution alive after the Human moved on. */
  private outstanding(state: Pick<StoredExecution, 'projectId' | 'executionId'>): boolean {
    const capacity = this.capacity(state);
    return capacity.activeTasks > 0 || (capacity.unreconciledClaims ?? 0) > 0;
  }
  /**
   * A newer Human request retires the brain's current execution. Idle work is replaced (or, for an unrouted
   * request, completed) as before; delegated work keeps it alive as a draining execution beside its successor,
   * so its workers, commitments and executionId stay valid. Runs inside the caller's transaction.
   */
  private retire(previous: StoredExecution, successor: string | null): AdaptiveRoutingEvent | null {
    if (previous.completedAt || !this.outstanding(previous)) {
      if (successor) { this.forget(previous.executionId); return null; }
      if (previous.completedAt) return null;
      return this.completeInside(previous, 'superseded_by_human_request');
    }
    // Its applied policy (and any Human lock) keeps governing the work it already delegated.
    this.touchState(previous); previous.supersededBy = successor ?? 'human_message';
    const item = this.record(previous, { ...fallbackDecision(previous.currentTopology, previous.workerBudget), reason: 'superseded_draining_delegated_work' },
      previous.currentTopology, 'status');
    this.save(previous); this.saveEvent(item); return item;
  }
  /** Superseded executions that already finished are kept (for the panel) only until the brain's next request. */
  private pruneSuperseded(channel: string, brain: string) {
    for (const executionId of this.store.finishedSupersededIds(channel, brain)) this.forget(executionId);
  }
  /** Completes draining executions whose delegated work has ended; nothing else can end them. */
  private settleDrained(projectId: string) {
    if (this.stopped) return;
    const draining = this.store.drainingExecutions(projectId).map(parseExecution);
    for (const state of draining) if (!this.outstanding(state)) this.complete(state, 'delegated_work_drained');
  }
  private conversationLock(channel: string, brain: string): AdaptiveTopology | null {
    const topology = this.store.conversationLock(channel, brain);
    return typeof topology === 'string' && ADAPTIVE_TOPOLOGIES.includes(topology as AdaptiveTopology) ? topology as AdaptiveTopology : null;
  }
  private conversationLockWrite(channel: string, brain: string, topology: AdaptiveTopology | null) {
    this.store.setConversationLock(channel, brain, topology);
  }
  private capacity(state: Pick<StoredExecution, 'projectId' | 'executionId'>): TopologyCapacitySnapshot { return readAdaptiveCapacity(this.deps, state); }
  private snapshot(state: StoredExecution, event: AdaptiveCoordinationEvent, capacity = this.capacity(state)): TopologyEvaluationSnapshot {
    const project = this.deps.projects.getProject(state.projectId);
    return { request: requestText(this.deps.messageQueries.getMessageById(state.requestMessageId ?? state.rootMessageId)), project: { slug: project.slug, name: project.name },
      current: { topology: state.currentTopology, workerBudget: state.workerBudget, desiredTopology: state.desiredTopology, desiredWorkers: state.desiredWorkers },
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
      confidence: decision.confidence, reason: decision.reason, providerStatus: decision.providerStatus, applied: changed, warning: state.warning,
      routeId: decision.routeId, ...(decision.incoherent ? { incoherent: decision.incoherent } : {}) };
  }
  private readonly callRecorded = (summary: JevCallSummary) => this.deps.bus.emit('jev-call', summary);
  private saveEvent(event: AdaptiveRoutingEvent) {
    const settled = this.observations.jevCalls.settle(event);
    // Published after the caller's transaction; a rolled-back event leaves the call unsettled on reload.
    if (settled) queueMicrotask(() => this.deps.bus.emit('jev-call', settled));
    this.store.saveEvent(event);
  }
  private commit(state: StoredExecution, event: AdaptiveRoutingEvent, evidenceId?: string) {
    this.deps.storage.transaction(() => {
      this.save(state); this.saveEvent(event);
      if (evidenceId) this.store.markEvaluated(state.executionId, evidenceId);
    });
    this.publish(state, event);
  }
  private publish(state: StoredExecution, event: AdaptiveRoutingEvent) {
    // A draining execution publishes its own state flagged `current: false`; the panel lists it beside the current one.
    this.deps.bus.emit('adaptive-routing', { channelId: state.channelId, state: this.displayState(state), event });
  }
  private assertEventActor(actor: Agent, event: AdaptiveCoordinationEvent) {
    if (actor.id !== event.actorId || actor.role !== event.actorRole || actor.role !== 'brain') throw new HiveError(403, 'Routing event identity does not match the authenticated actor');
    if (event.channelId) {
      const channel = this.deps.channels.getChannel(event.channelId, actor.projectId);
      if (!this.deps.channels.canSeeChannel(actor, channel) || !this.deps.channels.canPost(actor, channel)) throw new HiveError(403, 'Cannot coordinate in this channel');
    }
    if (event.taskId) {
      const task = this.deps.tasks.get(actor, event.taskId);
      if (actor.id !== task.assignerId && actor.id !== task.workerId) throw new HiveError(403, 'Only task participants can affect execution routing');
    }
    if (event.workerName) {
      const worker = this.deps.identity.getAgentByName(event.workerName);
      if (!worker || worker.role !== 'worker' || worker.projectId !== actor.projectId) throw new HiveError(400, 'Select a worker in the current project');
    }
  }
  /**
   * A brain may coordinate several Human requests at once. Delegation must name its execution;
   * other actions are attributed only from explicit structure (task, thread, channel), never guessed.
   */
  private resolveState(actor: Agent, event?: AdaptiveCoordinationEvent): StoredExecution | null {
    if (actor.role !== 'brain' || !actor.projectId) return null;
    const active = this.activeFor(actor.id, actor.projectId);
    const list = () => active.map(state => state.executionId).join(', ');
    if (event?.executionId) {
      const state = this.byExecution(event.executionId);
      if (state && (state.brainId !== actor.id || state.projectId !== actor.projectId)) throw new HiveError(403, 'This adaptive execution belongs to another brain');
      if (state && this.enabledOrLocked(state)) {
        if (event.taskId) {
          const link = this.store.taskExecution(event.taskId);
          if (link !== undefined && link !== state.executionId) throw new HiveError(409, 'This task belongs to another adaptive execution');
        }
        return state;
      }
      if (!active.length) return null;
      throw new HiveError(state ? 409 : 404, `${state ? 'Adaptive execution is no longer active' : 'Unknown adaptive execution'}; use one of: ${list()}`);
    }
    if (!active.length || !event) return null;
    if (event.kind === 'delegation_attempt')
      throw new HiveError(400, `executionId is required for delegation while adaptive executions are active: ${list()}`);
    const mine = (executionId: unknown) => active.find(state => state.executionId === String(executionId)) ?? null;
    if (event.taskId) {
      const link = this.store.taskExecution(event.taskId);
      if (link !== undefined) return mine(link);
    }
    if (event.threadId) {
      const rooted = active.find(state => state.rootMessageId === event.threadId);
      if (rooted) return rooted;
      const delegated = this.store.threadExecutions(event.threadId);
      if (delegated.length === 1) return mine(delegated[0]!);
      if (delegated.length > 1) return null;
    }
    // A channel alone names only the current request; a draining one needs its id, task or thread.
    return event.channelId ? active.find(state => state.channelId === event.channelId && !state.supersededBy) ?? null : null;
  }
  private enabledOrLocked(state: StoredExecution): boolean { return !state.completedAt && Boolean(loadAdaptiveRouting(this.deps.home)?.enabled || state.lockedTopology); }
  private async evaluateStable(state: StoredExecution, event: AdaptiveCoordinationEvent, config: AdaptiveRoutingFile) {
    let capacity = this.capacity(state), decision: AdaptiveTopologyDecision | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const signature = fingerprint(capacity.workers.available);
      decision = await observeTopologyEvaluation(this.observations,
        { executionId: state.executionId, channelId: state.channelId, projectId: state.projectId, phase: 'continuous' },
        this.snapshot(state, event, capacity), config, { signal: this.abort.signal },
        { context: { brainId: state.brainId, phase: 'continuous', trigger: { kind: event.kind, eventType: event.eventType ?? null } }, recorded: this.callRecorded });
      const next = this.capacity(state);
      if (decision.providerStatus !== 'ok' || signature === fingerprint(next.workers.available)) return { decision, capacity: next };
      capacity = next;
    }
    return { capacity, decision: { ...decision!, providerStatus: 'unavailable' as const, confidence: null,
      reason: 'capacity_changed_during_evaluation_preserve_current', targetTopology: state.currentTopology, targetWorkers: state.workerBudget } };
  }
  private async revalidateStored(state: StoredExecution, event: AdaptiveCoordinationEvent): Promise<StoredExecution> {
    const config = loadAdaptiveRouting(this.deps.home);
    if (this.stopped || state.completedAt) return state;
    if (!config?.enabled) {
      // A Human-requested drain must still finish when the optional classifier is off.
      if (state.lockedTopology && state.desiredTopology) {
        const target = { topology: state.lockedTopology, workers: state.desiredWorkers ?? minimumTopologyWorkers(state.lockedTopology) };
        if (topologyCheckpointSafe(target, safetyOf(this.capacity(state)))) {
          const from = state.currentTopology;
          state.currentTopology = target.topology; state.workerBudget = target.workers;
          state.desiredTopology = null; state.desiredWorkers = null;
          this.touchState(state);
          this.commit(state, this.record(state, { ...fallbackDecision(target.topology, target.workers), reason: 'human_drain_completed' }, from, 'lock', true));
        }
      }
      return state;
    }
    if (event.eventId && this.store.wasEvaluated(state.executionId, event.eventId)) return state;
    const from = state.currentTopology, revision = state.revision ?? 0;
    const { decision, capacity } = await this.evaluateStable(state, event, config);
    const latest = this.byExecution(state.executionId);
    if (!latest || (latest.revision ?? 0) !== revision || !isDeepStrictEqual(config, loadAdaptiveRouting(this.deps.home)) || this.stopped) return latest ?? state;
    const forced: TopologyTarget | null = state.lockedTopology ? { topology: state.lockedTopology,
      workers: state.lockedTopology === 'single' ? 0 : state.lockedTopology === state.currentTopology ? state.workerBudget : Math.max(minimumTopologyWorkers(state.lockedTopology), state.desiredWorkers ?? 0) } : null;
    const next = advanceTopologyPolicy(policyOf(state), { target: { topology: decision.targetTopology, workers: decision.targetWorkers },
      confidence: decision.confidence, available: decision.providerStatus === 'ok', incoherent: Boolean(decision.incoherent) }, safetyOf(capacity), forced);
    state.currentTopology = next.applied.topology; state.workerBudget = next.applied.workers;
    state.desiredTopology = next.pending?.topology ?? null; state.desiredWorkers = next.pending?.workers ?? null;
    state.confirmations = next.confirmation.count; state.confirmationHighCount = next.confirmation.highCount;
    state.confirmationTopology = next.confirmation.target?.topology ?? null; state.confirmationWorkers = next.confirmation.target?.workers ?? null;
    state.eventsSinceChange = next.eventsSinceChange; state.recommendation = decision;
    // An uncertain or incoherent answer is still an answer: Jev stays available and the policy simply keeps the mode.
    state.providerAvailable = decision.providerStatus === 'ok';
    state.warning = !state.providerAvailable ? `${jevNotUsedLabel(decision) ?? 'Jev answer not used'} · current mode kept, not revalidated` : null;
    if (!forced && decision.providerStatus === 'ok' && capacity.workers.usableForExecution === 0 && (decision.needsOrchestration || state.orchestratedOnly)) {
      state.warning = 'Orchestration needed · no workers available'; state.desiredTopology = config.topologyFallback; state.desiredWorkers = minimumTopologyWorkers(config.topologyFallback);
    }
    state.recentEvents = [...state.recentEvents, cleanEvent(event)].slice(-8);
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = revision + 1;
    this.commit(state, this.record(state, decision, from, next.changed ? 'transition' : state.warning ? 'warning' : 'evaluation', next.changed), event.eventId);
    return state;
  }
  async revalidateForActor(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    if (actor.role !== 'brain') return null;
    this.assertEventActor(actor, event);
    const state = this.resolveState(actor, event);
    if (!state || !this.enabledOrLocked(state)) return null;
    const updated = await this.revalidateQueued(state, event);
    return this.enabledOrLocked(updated) ? compactPolicy(updated) : null;
  }
  private revalidateQueued(state: StoredExecution, event: AdaptiveCoordinationEvent): Promise<StoredExecution> {
    return this.queued(state.channelId, () => this.revalidateLatest(state, event));
  }
  /** Revalidates the stored version of an execution, current or draining; a replaced one is left alone. */
  private revalidateLatest(state: StoredExecution, event: AdaptiveCoordinationEvent): Promise<StoredExecution> | StoredExecution {
    const latest = this.byExecution(state.executionId);
    return latest ? this.revalidateStored(latest, event) : state;
  }
  /**
   * Revalidates every other execution of the project, at most PROJECT_REVALIDATION_CONCURRENCY Jev calls at a time.
   * Each still goes through its channel queue; one failure never stops the others and is reported once all settle.
   */
  private async revalidateProject(projectId: string, event: AdaptiveCoordinationEvent, exceptExecution?: string) {
    const states = this.store.projectExecutions(projectId)
      .map(parseExecution).filter(state => state.executionId !== exceptExecution);
    const failures: unknown[] = [];
    let next = 0;
    const lane = async () => {
      while (next < states.length) {
        const state = states[next++]!;
        try { await this.revalidateQueued(state, event); } catch (error) { failures.push(error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROJECT_REVALIDATION_CONCURRENCY, states.length) }, lane));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} executions failed capacity revalidation`);
  }
  private assertDelegation(state: StoredExecution, event: AdaptiveCoordinationEvent) {
    if (event.kind !== 'delegation_attempt' || !this.enabledOrLocked(state)) return;
    if (compactPolicy(state).delegationPaused) throw new HiveError(409, 'Adaptive de-escalation pending; finish existing work before new delegation');
    if (state.currentTopology === 'single') throw new HiveError(409, 'Adaptive routing retains Single; new delegation is blocked');
    if (event.usesRoom === true && state.currentTopology !== 'brain_multi_room') throw new HiveError(409, `Applied topology ${state.currentTopology} does not permit new room work`);
    if (event.usesRoom === false && state.currentTopology === 'brain_multi_room') throw new HiveError(409, 'Applied topology is Room; new work must use the room contract');
    const worker = event.workerName ? this.deps.identity.getAgentByName(event.workerName) : null;
    if (worker) {
      const capacity = this.capacity(state), candidate = capacity.workers.available.find(w => w.id === worker.id);
      if (!candidate) throw new HiveError(409, 'Selected worker is not available for this execution');
      if (!candidate.committed && capacity.activeWorkers >= state.workerBudget) throw new HiveError(409, `Applied worker budget is ${state.workerBudget}; no additional slot is available`);
    }
  }
  async beforeBrainAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    if (actor.role !== 'brain') return null;
    const tokenHash = this.deps.identity.sessionFingerprint(actor.id);
    const policy = await this.revalidateForActor(actor, event);
    if (tokenHash !== this.deps.identity.sessionFingerprint(actor.id)) throw new HiveError(401, 'Credentials changed during routing; rejoin before retrying');
    if (!policy) return null;
    const current = this.byExecution(policy.executionId);
    if (current) this.assertDelegation(current, event);
    return current && this.enabledOrLocked(current) ? compactPolicy(current) : null;
  }
  async afterAgentAction(actor: Agent, event: AdaptiveCoordinationEvent): Promise<AdaptiveAgentPolicy | null> {
    return this.revalidateForActor(actor, event);
  }
  /** Only brain coordination changes capacity for routing; worker activity never triggers Jev. */
  async capacityChanged(actor: Agent, eventId: string, exceptExecution?: string): Promise<void> {
    if (!actor.projectId || actor.role !== 'brain') return;
    try {
      await this.revalidateProject(actor.projectId, { kind: 'capacity_change', actorId: actor.id,
        actorRole: 'brain', eventId: coordinationEventId(actor.id, 'capacity', eventId) }, exceptExecution);
    } finally { this.settleDrained(actor.projectId); }
  }
  /**
   * Routing that follows a committed action failed: the Human audit gets a `warning` event on the execution the
   * action belongs to, when it can still be resolved. The execution itself is not changed. Never throws.
   */
  recordRoutingWarning(actor: Agent, event: AdaptiveCoordinationEvent, warning: string): AdaptiveRoutingEvent | null {
    if (this.stopped || actor.role !== 'brain') return null;
    try {
      const state = this.resolveState(actor, event);
      if (!state) return null;
      const decision = { ...fallbackDecision(state.currentTopology, state.workerBudget), reason: 'post_commit_routing_failed' };
      const item: AdaptiveRoutingEvent = { ...this.record(state, decision, state.currentTopology, 'warning'),
        createdAt: Math.max(Date.now(), state.updatedAt), warning };
      this.deps.storage.transaction(() => this.saveEvent(item));
      this.publish(state, item);
      return item;
    } catch (error) {
      console.error(`Adaptive routing warning for ${actor.name} was not recorded`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }
  /** Compact policy for one execution, or the brain's only active execution when none is named. */
  forAgent(actor: Agent, executionId?: string): AdaptiveAgentPolicy | null {
    if (actor.role !== 'brain' || !actor.projectId) return null;
    if (executionId) {
      const state = this.byExecution(executionId);
      return state && state.brainId === actor.id && this.enabledOrLocked(state) ? compactPolicy(state) : null;
    }
    const active = this.activeFor(actor.id, actor.projectId);
    return active.length === 1 ? compactPolicy(active[0]!) : null;
  }
  policiesFor(actor: Agent): AdaptiveAgentPolicy[] {
    return actor.role === 'brain' && actor.projectId ? this.activeFor(actor.id, actor.projectId).map(compactPolicy) : [];
  }
  hasActive(actor: Agent): boolean { return this.policiesFor(actor).length > 0; }
  private feasibleFallback(config: AdaptiveRoutingFile, capacity: AdaptiveWorkerCapacity): AdaptiveTopology {
    if (capacity.usableForExecution >= minimumTopologyWorkers(config.topologyFallback)) return config.topologyFallback;
    return capacity.usableForExecution >= 1 ? 'brain_one_worker' : 'single';
  }
  private manualBudget(topology: AdaptiveTopology, proposed: number, capacity: AdaptiveWorkerCapacity): number {
    return topology === 'single' ? 0 : topology === 'brain_one_worker' ? 1 : Math.max(2, Math.min(proposed || 2, capacity.usableForExecution));
  }
  /**
   * Every Human message addressed to a brain passes through Jev before delivery. Returns null when
   * the caller should post the message itself (no brain, disabled, or evaluated in place).
   */
  async routeHumanRequest(human: Agent, input: HumanMessageInput, rawMode?: string, rawScope?: string,
    persistReceipt?: (message: Message) => void, routingRequest?: string): Promise<RoutedHumanMessage | null> {
    if (human.role !== 'human') throw new HiveError(403, 'Only Human starts adaptive execution');
    const channel = this.deps.channels.getChannel(input.channel);
    const explicit = (rawMode ?? 'auto') !== 'auto' || (rawScope ?? 'none') !== 'none';
    const { brains, owners } = this.requestOwners(channel, input.body);
    if (!brains.length) {
      if (explicit) throw new HiveError(400, 'Explicit routing needs a channel with a brain');
      return null;
    }
    if (this.deps.messages.hasActiveSendRequest(human, channel.id, input.requestId)) return null;
    const request = routingRequest ?? requestText(input);
    if (input.threadId) {
      if (explicit) throw new HiveError(400, 'Explicit routing is only valid for a new top-level request; use the routing panel to lock an active execution');
      return this.routeHumanReply(human, channel, input, request, persistReceipt);
    }
    if (!owners.length) {
      if (explicit) throw new HiveError(400, 'Several brains share this channel; @mention the brain(s) that should handle this request');
      await this.observe(channel, request);
      return null;
    }
    return this.startExecutions(human, input, rawMode, rawScope, persistReceipt, routingRequest, owners);
  }
  /** A Human thread reply revalidates, reopens, or starts the execution of each owning brain. */
  private async routeHumanReply(human: Agent, channel: Channel, input: HumanMessageInput, request: string,
    persistReceipt?: (message: Message) => void): Promise<RoutedHumanMessage | null> {
    const threadId = input.threadId!;
    // A draining execution keeps its thread; a finished superseded one is history, not a reply target.
    const rooted = this.rows(channel.id).filter(state => state.rootMessageId === threadId && !(state.supersededBy && state.completedAt));
    const owners = rooted.length ? [...new Set(rooted.map(state => state.brainId))].map(id => this.deps.identity.getAgent(id)) : this.requestOwners(channel, input.body).owners;
    if (!owners.length) { await this.observe(channel, request); return null; }
    const event: AdaptiveCoordinationEvent = { kind: 'human_message', actorId: human.id, actorRole: 'human', channelId: channel.id,
      threadId, summary: request, eventId: coordinationEventId(human.id, 'human-message', input.requestId ?? randomUUID()) };
    const fresh: Agent[] = [], revalidate: StoredExecution[] = [];
    const executionOf = (brain: Agent) => rooted.find(state => state.brainId === brain.id) ?? this.row(channel.id, brain.id);
    for (const brain of owners) {
      let state = executionOf(brain);
      if (state?.completedAt && state.rootMessageId === threadId) {
        // Completed delegated work is never reopened; the reply then starts a new execution instead.
        try { this.reopen(human, threadId); } catch (error) { if (!(error instanceof HiveError) || error.status !== 409) throw error; }
        state = this.byExecution(state.executionId);
      }
      if (state && !state.completedAt) {
        if (this.enabledOrLocked(state)) revalidate.push(state);
      } else if (loadAdaptiveRouting(this.deps.home)?.enabled || this.conversationLock(channel.id, brain.id)) fresh.push(brain);
    }
    // Owners are classified in parallel; each result is still fenced by its own execution revision.
    if (revalidate.length) await this.queued(channel.id, () => Promise.all(revalidate.map(state => this.revalidateLatest(state, event))));
    if (!fresh.length || this.stopped) return null;
    return this.startExecutions(human, input, 'auto', 'none', persistReceipt, request, fresh);
  }
  /** Reopening follows the thread: a completed thread is reopened with its executions. */
  private reopen(human: Agent, threadId: string) {
    if (this.deps.messageQueries.threadStatus(threadId) === 'done') {
      this.deps.messages.setThreadStatus(human, threadId, 'open'); return;
    }
    const published = this.deps.storage.transaction(() => this.threadStatusChange(human, threadId, 'open'));
    published?.();
  }
  /** No single owning brain: Jev still classifies the request, but nothing is enforced. */
  private async observe(channel: Channel, request: string) {
    const config = loadAdaptiveRouting(this.deps.home);
    if (!config?.enabled || this.stopped) return;
    const executionId = `observation-${randomUUID()}`, project = this.deps.projects.getProject(channel.projectId);
    const capacity = this.capacity({ projectId: channel.projectId, executionId });
    const decision = await observeTopologyEvaluation(this.observations,
      { executionId, channelId: channel.id, projectId: channel.projectId, phase: 'initial' },
      { request, project: { slug: project.slug, name: project.name }, current: null, capacity,
        execution: { orchestratedOnly: false, lockScope: 'none', lockedTopology: null },
        tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
        recentCoordinationEvents: [], trigger: { kind: 'human_request', owner: 'ambiguous' }, previousDecision: null },
      config, { signal: this.abort.signal },
      { context: { brainId: null, phase: 'observation', trigger: { kind: 'observation', eventType: null } }, recorded: this.callRecorded });
    if (this.stopped) return;
    const event: AdaptiveRoutingEvent = { id: randomUUID(), executionId, channelId: channel.id, projectId: channel.projectId,
      createdAt: Date.now(), kind: 'observation', fromTopology: 'single', targetTopology: decision.targetTopology,
      appliedTopology: 'single', targetWorkers: decision.targetWorkers, appliedWorkers: 0, confidence: decision.confidence,
      reason: decision.reason, providerStatus: decision.providerStatus, applied: false,
      warning: 'No single owning brain · recommendation only', routeId: decision.routeId };
    this.deps.storage.transaction(() => this.saveEvent(event));
    this.deps.bus.emit('adaptive-routing', { channelId: channel.id, state: null, event });
  }
  private async planExecution(channel: Channel, brain: Agent, input: HumanMessageInput, mode: AdaptiveRoutingMode,
    scope: AdaptiveLockScope, manual: AdaptiveTopology | null, config: AdaptiveRoutingFile | null, routingRequest?: string) {
    const inherited = manual ? null : this.conversationLock(channel.id, brain.id);
    if (!config?.enabled && mode === 'auto' && !inherited) return null;
    // A previous execution with delegated work is never a reason to reject the Human: it drains beside the new one.
    const previous = this.row(channel.id, brain.id);
    const locked = manual ?? inherited;
    const lockScope: AdaptiveLockScope = manual ? scope : inherited ? 'conversation' : 'none';
    const executionId = `execution-${randomUUID()}`, project = this.deps.projects.getProject(channel.projectId);
    let capacity = this.capacity({ projectId: channel.projectId, executionId });
    const makeSnapshot = (): TopologyEvaluationSnapshot => ({ request: routingRequest ?? requestText(input),
      project: { slug: project.slug, name: project.name }, current: null, capacity,
      execution: { orchestratedOnly: mode === 'orchestrated_auto', lockScope, lockedTopology: locked },
      tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
      recentCoordinationEvents: [], trigger: { kind: 'human_request' }, previousDecision: null });
    let decision = fallbackDecision(locked ?? 'single', minimumTopologyWorkers(locked ?? 'single'));
    let stable = !config?.enabled;
    if (config?.enabled) for (let attempt = 0; attempt < 3; attempt++) {
      const signature = fingerprint(capacity.workers.available);
      decision = await observeTopologyEvaluation(this.observations,
        { executionId, channelId: channel.id, projectId: channel.projectId, phase: 'initial' },
        makeSnapshot(), config, { signal: this.abort.signal },
        { context: { brainId: brain.id, phase: 'initial', trigger: { kind: input.threadId ? 'human_message' : 'human_request', eventType: null } }, recorded: this.callRecorded });
      capacity = this.capacity({ projectId: channel.projectId, executionId });
      stable = signature === fingerprint(capacity.workers.available);
      if (decision.providerStatus !== 'ok' || stable) break;
    }
    return { brain, previous, inherited, locked, lockScope, executionId, capacity, decision, stable };
  }
  private async startExecutions(human: Agent, input: HumanMessageInput, rawMode: string | undefined,
    rawScope: string | undefined, persistReceipt: ((message: Message) => void) | undefined, routingRequest: string | undefined,
    owners: Agent[]): Promise<RoutedHumanMessage | null> {
    const channel = this.deps.channels.getChannel(input.channel);
    const mode = modeOf(rawMode), scope = scopeOf(rawScope);
    const manual = ADAPTIVE_TOPOLOGIES.includes(mode as AdaptiveTopology) ? mode as AdaptiveTopology : null;
    if (scope !== 'none' && !manual) throw new HiveError(400, 'Locks require an explicit topology');
    return this.queued(channel.id, async () => {
      if (this.deps.messages.hasActiveSendRequest(human, channel.id, input.requestId)) return null;
      const config = loadAdaptiveRouting(this.deps.home);
      // Owners are classified in parallel: a Human send waits for the slowest brain, not the sum. No total deadline.
      const plans = (await Promise.all(owners.map(brain => this.planExecution(channel, brain, input, mode, scope, manual, config, routingRequest))))
        .filter(plan => plan !== null);
      if (!plans.length) return null;
      if (this.stopped) throw new HiveError(503, 'Server is shutting down');
      const currentConfig = loadAdaptiveRouting(this.deps.home);
      const states: Array<{ state: StoredExecution; decision: AdaptiveTopologyDecision; warning: string | null; plan: typeof plans[number] }> = [];
      for (const plan of plans) {
        const { brain, previous, inherited, locked, lockScope, executionId, capacity } = plan;
        let { decision } = plan;
        if (!currentConfig?.enabled && config?.enabled && !locked) continue;
        if (!isDeepStrictEqual(config, currentConfig)) throw new HiveError(409, 'Jev settings changed during initial routing; retry with the current configuration');
        if (fingerprint(previous) !== fingerprint(this.row(channel.id, brain.id)) || inherited !== (manual ? null : this.conversationLock(channel.id, brain.id))) throw new HiveError(409, 'Human routing state changed; review and retry the request');
        if (decision.providerStatus === 'ok' && (!plan.stable || !validTopologyTarget({ topology: decision.targetTopology, workers: decision.targetWorkers }, capacity.workers.usableForExecution)))
          decision = { ...decision, providerStatus: 'unavailable', confidence: null, reason: 'capacity_changed_during_initial_routing', targetTopology: 'single', targetWorkers: 0 };
        // Unavailable, rejected, stale, below MIN_TOPOLOGY_CONFIDENCE or incoherent: the fallback applies (#209).
        const uncertain = !jevDecisionActionable(decision);
        let actual = locked ?? decision.targetTopology;
        if (!locked && uncertain) actual = currentConfig?.fallback === 'single' ? 'single' : currentConfig ? this.feasibleFallback(currentConfig, capacity.workers) : 'single';
        if (!locked && mode === 'orchestrated_auto' && actual === 'single' && capacity.workers.usableForExecution > 0) actual = currentConfig ? this.feasibleFallback(currentConfig, capacity.workers) : 'brain_one_worker';
        const required = minimumTopologyWorkers(actual);
        if (manual && required > capacity.workers.usableForExecution) throw new HiveError(409, `${manual} needs ${required} available workers; only ${capacity.workers.usableForExecution} are available`);
        let budget = locked || uncertain || actual !== decision.targetTopology ? this.manualBudget(actual, decision.targetWorkers, capacity.workers) : decision.targetWorkers;
        let desired: TopologyTarget | null = null;
        // Says precisely why Jev's answer was not used, and which mode was used instead. A Human lock is authoritative:
        // an uncertain answer is then irrelevant, and only a failed call is surfaced.
        const notUsed = jevNotUsedLabel(decision);
        let warning = !notUsed ? null : !locked ? `${notUsed} · used fallback ${topologyName(actual)}`
          : decision.providerStatus === 'unavailable' ? `${notUsed} · your ${topologyName(locked)} lock applies` : null;
        if (required > capacity.workers.usableForExecution || budget > capacity.workers.usableForExecution) {
          desired = { topology: actual, workers: required }; actual = 'single'; budget = 0; warning = 'Requested topology is waiting for worker capacity';
        }
        if (!locked && capacity.workers.usableForExecution === 0 && (decision.needsOrchestration || mode === 'orchestrated_auto')) {
          const target = currentConfig?.topologyFallback ?? 'brain_one_worker';
          desired = { topology: target, workers: minimumTopologyWorkers(target) }; warning = 'Orchestration needed · no workers available';
        }
        const policy = initialTopologyPolicy({ topology: actual, workers: budget });
        const state: StoredExecution = { executionId, channelId: channel.id, projectId: channel.projectId, brainId: brain.id, rootMessageId: '',
          currentTopology: actual, workerBudget: budget, desiredTopology: desired?.topology ?? null, desiredWorkers: desired?.workers ?? null,
          lockedTopology: locked, lockScope, orchestratedOnly: mode === 'orchestrated_auto', providerAvailable: decision.providerStatus === 'ok',
          warning, recommendation: decision, confirmations: 0, confirmationHighCount: 0, confirmationTopology: null, confirmationWorkers: null,
          eventsSinceChange: policy.eventsSinceChange, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1), recentEvents: [], revision: (previous?.revision ?? 0) + 1, completedAt: null };
        states.push({ state, decision, warning, plan });
      }
      if (!states.length) return null;
      // Group channels address each directive to its brain only, so workers are not woken by it.
      const directives = states.map(({ state, plan }) => ({ body: topologyDirective(state, plan.brain.name),
        requestId: `adaptive-${state.executionId}`, recipients: channel.type === 'dm' ? undefined : [plan.brain.name] }));
      const items: AdaptiveRoutingEvent[] = [], retired: Array<[StoredExecution, AdaptiveRoutingEvent]> = [];
      const delivered = this.deps.messages.postAdaptiveRequest(human, input, directives, persistReceipt, message => {
        for (const { state, decision, warning, plan } of states) {
          state.rootMessageId = message.threadId ?? message.id; state.requestMessageId = message.id;
          if (manual && scope === 'conversation') this.conversationLockWrite(channel.id, plan.brain.id, manual);
          this.pruneSuperseded(channel.id, plan.brain.id);
          if (plan.previous) {
            const item = this.retire(plan.previous, state.executionId);
            if (item) retired.push([plan.previous, item]);
          }
          this.save(state);
          const item = this.record(state, decision, state.currentTopology, warning ? 'warning' : plan.locked ? 'lock' : 'evaluation', false);
          this.saveEvent(item); items.push(item);
        }
      });
      for (const [state, item] of retired) this.publish(state, item);
      states.forEach(({ state }, index) => this.publish(state, items[index]!));
      const display = states.map(({ state }) => this.displayState(state));
      return { message: delivered.message, routingMessage: delivered.routingMessages[0], routingMessages: delivered.routingMessages,
        routing: states[0]!.decision, routings: states.map(item => item.decision), state: display[0]!, states: display };
    });
  }
  private touchState(state: StoredExecution) {
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = (state.revision ?? 0) + 1;
  }
  settingsChanged(): void {
    for (const row of this.store.allExecutions()) {
      const state = JSON.parse(String(row.snapshot)) as StoredExecution;
      if (state.completedAt) continue;
      this.touchState(state); state.providerAvailable = false; state.warning = null;
      state.confirmations = 0; state.confirmationHighCount = 0; state.confirmationTopology = null; state.confirmationWorkers = null;
      const decision = { ...fallbackDecision(state.currentTopology, state.workerBudget), reason: 'jev_settings_changed' };
      state.recommendation = decision;
      this.commit(state, this.record(state, decision, state.currentTopology, 'status'));
    }
  }
  private completeInside(state: StoredExecution, reason: string): AdaptiveRoutingEvent {
    this.touchState(state); state.completedAt = state.updatedAt;
    state.desiredTopology = null; state.desiredWorkers = null;
    state.lockedTopology = null; state.lockScope = 'none'; state.warning = null;
    const item = this.record(state, { ...fallbackDecision(state.currentTopology, state.workerBudget), reason }, state.currentTopology, 'status');
    this.save(state); this.saveEvent(item); return item;
  }
  private complete(state: StoredExecution, reason: string): void {
    this.publish(state, this.deps.storage.transaction(() => this.completeInside(state, reason)));
  }
  /** Invoked inside Hive's thread transaction; returns a post-commit notification. */
  threadStatusChange(actor: Agent, threadId: string, status: ThreadStatus | null): (() => void) | null {
    const projectId = this.deps.channels.getChannel(this.deps.messageQueries.getMessageById(threadId).channelId).projectId;
    // Closing a delegation thread may be the last work of a draining execution.
    const settle = () => this.settleDrained(projectId);
    const rooted = this.store.rootedExecutions(threadId).map(parseExecution);
    if (!rooted.length) return settle;
    // Human closes every brain's execution on this request; a brain closes only its own.
    const owned = actor.role === 'human' ? rooted : rooted.filter(state => state.brainId === actor.id);
    if (!owned.length) throw new HiveError(403, 'Only Human or the coordinating brain closes this execution');
    const complete = status === 'done';
    const published: Array<[StoredExecution, AdaptiveRoutingEvent]> = [];
    for (const state of owned) {
      if (complete === Boolean(state.completedAt)) continue;
      // A superseded execution is history once finished; the Human continues through the current one.
      if (!complete && state.supersededBy) continue;
      let released = 0;
      if (complete) {
        const capacity = this.capacity(state), open = openDelegations(this.deps, { executionId: state.executionId });
        // The Human may close a request over free-form delegations (they are released below); structured tasks
        // and claims have their own lifecycle and must still be finished or reconciled.
        const freeForm = actor.role === 'human' ? open : [];
        const tasks = capacity.activeTasks - new Set(freeForm.map(row => String(row.root_id))).size;
        const blockers = capacity.blockers - freeForm.filter(row => row.status === 'blocked').length;
        if (tasks || blockers || capacity.openDependencies || capacity.unreconciledClaims)
          throw new HiveError(409, 'Finish delegated work and reconcile claims before completing this execution');
        released = freeForm.length;
        if (released) this.store.releaseExecutionDelegations(state.executionId);
      }
      this.touchState(state); state.completedAt = complete ? state.updatedAt : null;
      state.desiredTopology = null; state.desiredWorkers = null;
      state.confirmations = 0; state.confirmationHighCount = 0; state.confirmationTopology = null; state.confirmationWorkers = null;
      if (complete) { state.lockedTopology = null; state.lockScope = 'none'; state.warning = null; }
      const decision = { ...fallbackDecision(state.currentTopology, state.workerBudget), reason: complete ? 'execution_completed' : 'execution_reopened' };
      const item = this.record(state, decision, state.currentTopology, 'status');
      if (released) item.warning = `Human completed the request · released ${released} open delegation${released === 1 ? '' : 's'} without a worker report`;
      this.save(state); this.saveEvent(item);
      if (complete) this.store.clearEvaluated(state.executionId);
      published.push([state, item]);
    }
    return () => { for (const [state, item] of published) this.publish(state, item); settle(); };
  }
  view(actor: Agent, channelId: string): AdaptiveRoutingView {
    if (actor.role !== 'human') throw new HiveError(403, 'Adaptive routing timeline is Human-only');
    const channel = this.deps.channels.getChannel(channelId);
    if (!this.deps.channels.canSeeChannel(actor, channel)) throw new HiveError(403, 'Cannot read routing state');
    // Current executions (one per brain) and draining predecessors, flagged `current: false`.
    const executions = this.rows(channel.id).map(state => this.displayState(state));
    // The primary execution is the most recently updated current one still running, else the latest current.
    const state = executions.filter(item => item.current).sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.updatedAt - a.updatedAt)[0] ?? null;
    const events = this.store.recentEvents(channel.id).map(row => JSON.parse(String(row.snapshot)) as AdaptiveRoutingEvent).reverse();
    return { state, executions, events, collector: this.observations.collectorHealth() };
  }
  setLock(actor: Agent, channelId: string, raw: unknown): AdaptiveRoutingView {
    if (actor.role !== 'human') throw new HiveError(403, 'Only Human changes routing locks');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HiveError(400, 'Expected lock settings');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !['scope','topology','expectedExecutionId','expectedRevision'].includes(key)) || typeof input.scope !== 'string') throw new HiveError(400, 'Expected an explicit lock scope');
    const scope = scopeOf(input.scope);
    const topology = typeof input.topology === 'string' && ADAPTIVE_TOPOLOGIES.includes(input.topology as AdaptiveTopology) ? input.topology as AdaptiveTopology : null;
    if (scope !== 'none' && !topology) throw new HiveError(400, 'Choose a topology to lock');
    const executions = this.rows(this.deps.channels.getChannel(channelId).id);
    if (!executions.length) throw new HiveError(404, 'No adaptive execution in this channel');
    const expected = input.expectedExecutionId, current = executions.filter(item => !item.supersededBy);
    if (expected === undefined && current.length !== 1) throw new HiveError(400, 'Several executions are active here; choose the execution to lock');
    const state = expected === undefined ? current[0]! : executions.find(item => item.executionId === expected);
    if (!state) throw new HiveError(409, 'Execution changed; reload the routing panel');
    if (state.completedAt) throw new HiveError(409, 'This execution has completed; start a new request');
    if (state.supersededBy) throw new HiveError(409, 'This execution is finishing older work; lock the current request instead');
    if (input.expectedRevision !== undefined && input.expectedRevision !== (state.revision ?? 0))
      throw new HiveError(409, 'Routing changed; reload before applying a Human lock');
    if (scope === state.lockScope && (scope === 'none' ? state.lockedTopology === null && this.conversationLock(state.channelId, state.brainId) === null : topology === state.lockedTopology)) return this.view(actor, channelId);
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
    this.deps.storage.transaction(() => {
      if (scope === 'none' || scope === 'conversation') this.conversationLockWrite(state.channelId, state.brainId, scope === 'none' ? null : topology);
      this.save(state); this.saveEvent(item);
    });
    this.publish(state, item); return this.view(actor, channelId);
  }
}
