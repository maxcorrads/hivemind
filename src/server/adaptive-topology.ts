import { randomUUID } from 'node:crypto';
import type { AdaptiveRuntimeDeps } from "./services/ports.ts";
import { parseMentions } from '../shared/mentions.ts';
import { HiveError, type Agent, type Channel, type Message, type ThreadStatus } from '../shared/types.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView,
  AdaptiveTopologyDecision, JevAdvice } from '../shared/adaptive-topology.ts';
import type { JevCallSummary, JevCallTrigger } from '../shared/jev-calls.ts';
import { jevAdvice } from '../shared/jev-outcome.ts';
import { loadAdaptiveRouting, type AdaptiveRoutingFile } from './adaptive-config.ts';
import type { TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { AdaptiveObservationStores, observeTopologyEvaluation } from './adaptive-evidence-observer.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import { AdaptiveTopologyStore } from './adaptive-topology-store.ts';

export { evaluateAdaptiveTopology, ADAPTIVE_TOPOLOGY_CONTRACT_VERSION } from './adaptive-topology-provider.ts';

/**
 * A brain action Jev is asked about (#211). Workers never trigger Jev. `channelId` and `threadId` only help find the
 * Human request the action belongs to; nothing is checked or enforced.
 */
export type BrainAction = {
  kind: Exclude<JevCallTrigger['kind'], 'human_request' | 'human_message' | 'capacity_change' | 'observation'>;
  channelId?: string; threadId?: string; taskId?: string; eventType?: string; summary?: string;
};
type StoredExecution = AdaptiveExecutionState & {
  /** The Human message classified as the request; rootMessageId is its thread root. */
  requestMessageId?: string;
  /** The last brain actions Jev saw for this request (kind, eventType and a short summary only). */
  recentEvents: Array<{ kind: string; eventType?: string; summary?: string }>;
};
export type RoutedHumanMessage = {
  message: Message;
  /** One per brain that owns the request, with the advice Jev gave it. */
  states: AdaptiveExecutionState[];
};
type HumanMessageInput = {
  channel: string; body: string; requestId?: string; threadId?: string | null;
  eventType?: Message['eventType']; traceId?: string; causeMessageId?: string;
  attachmentIds?: string[]; recipients?: string[]; source?: 'hive' | 'telegram';
};

function requestText(message: Pick<Message, 'body' | 'source'>): string {
  return message.source === 'telegram' ? message.body.replace(/^\[[^\]\r\n]*\]\s?/, '') : message.body;
}
const parse = (row: Record<string, unknown>) => JSON.parse(String(row.snapshot)) as StoredExecution;
const summary = (text: string | undefined) => text?.trim().slice(0, 400) || undefined;

/**
 * Jev as a non-binding advisor to brains (#211).
 *
 * Every Human message addressed to a brain and every brain action is sent to Jev synchronously (bounded by the provider
 * timeout); the advice is returned to the brain in the response to its action. Hivemind never applies, enforces or
 * locks a topology, never blocks an action because of Jev, and posts no message of its own. Calls are grouped per
 * Human request (execution) only for the Human-only Routing log and evidence.
 */
export class AdaptiveTopologyRuntime {
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Evidence and Jev call history stores for this hive's database. */
  readonly observations: AdaptiveObservationStores;
  /** Executions (the request each brain serves, with the latest advice) and the Human-only advice audit. */
  readonly store: AdaptiveTopologyStore;

  constructor(private readonly deps: AdaptiveRuntimeDeps) {
    this.observations = new AdaptiveObservationStores(deps.storage, health => deps.bus.emit('evidence-health', health));
    this.store = new AdaptiveTopologyStore(deps.storage);
  }

  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort();
    await Promise.allSettled(this.inFlight);
    // A graceful restart persists held gap markers when the store accepts writes again; a crash cannot.
    this.observations.collector.flush(() => this.observations.evidence);
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

  private enabled(): AdaptiveRoutingFile | null {
    const config = loadAdaptiveRouting(this.deps.home);
    return config?.enabled && !this.stopped ? config : null;
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => undefined);
    return work;
  }
  private readonly callRecorded = (call: JevCallSummary) => this.deps.bus.emit('jev-call', call);

  /** One Jev call for one execution, recorded in the evidence store and the Human-only call log. */
  private evaluate(config: AdaptiveRoutingFile, state: Pick<StoredExecution, 'executionId' | 'channelId' | 'projectId' | 'recommendation'>
    & { recentEvents?: StoredExecution['recentEvents'] }, brainId: string | null, request: string,
  phase: JevCallSummary['phase'], trigger: JevCallTrigger & { summary?: string }): Promise<AdaptiveTopologyDecision> {
    const project = this.deps.projects.getProject(state.projectId);
    const capacity = readAdaptiveCapacity(this.deps, { projectId: state.projectId, brainId });
    const snapshot: TopologyEvaluationSnapshot = { request, project: { slug: project.slug, name: project.name }, capacity,
      tasks: { active: capacity.activeTasks, activeWorkers: capacity.activeWorkers, blockers: capacity.blockers,
        openDependencies: capacity.openDependencies, workstreams: capacity.workstreams },
      recentCoordinationEvents: state.recentEvents ?? [], trigger, previousDecision: state.recommendation };
    return this.track(observeTopologyEvaluation(this.observations,
      { executionId: state.executionId, channelId: state.channelId, projectId: state.projectId, phase: phase === 'initial' ? 'initial' : 'continuous' },
      snapshot, config, { signal: this.abort.signal },
      { context: { brainId, phase, trigger: { kind: trigger.kind, eventType: trigger.eventType } }, recorded: this.callRecorded }));
  }
  private auditEvent(state: Pick<StoredExecution, 'executionId' | 'channelId' | 'projectId'>, kind: AdaptiveRoutingEvent['kind'],
    decision: AdaptiveTopologyDecision, trigger?: string, reason = decision.reason): AdaptiveRoutingEvent {
    return { id: randomUUID(), executionId: state.executionId, channelId: state.channelId, projectId: state.projectId,
      createdAt: Date.now(), kind, ...(trigger ? { trigger } : {}), targetTopology: decision.targetTopology,
      targetWorkers: decision.targetWorkers, confidence: decision.confidence, reason, providerStatus: decision.providerStatus,
      routeId: decision.routeId, ...(decision.incoherent ? { incoherent: decision.incoherent } : {}),
      ...(decision.error ? { error: decision.error } : {}) };
  }
  private statusEvent(state: StoredExecution, reason: string): AdaptiveRoutingEvent {
    const last = state.recommendation;
    return { id: randomUUID(), executionId: state.executionId, channelId: state.channelId, projectId: state.projectId,
      createdAt: Date.now(), kind: 'status', targetTopology: last?.targetTopology ?? 'single', targetWorkers: last?.targetWorkers ?? 0,
      confidence: null, reason, providerStatus: last?.providerStatus ?? 'bypassed' };
  }
  private publish(state: StoredExecution | null, event: AdaptiveRoutingEvent) {
    this.deps.bus.emit('adaptive-routing', { channelId: event.channelId, state: state ? this.displayState(state) : null, event });
  }
  private displayState(state: StoredExecution): AdaptiveExecutionState {
    const { recentEvents: _recent, requestMessageId: _request, ...rest } = state;
    const display: AdaptiveExecutionState = { ...rest,
      monitoring: state.completedAt ? 'completed' : loadAdaptiveRouting(this.deps.home)?.enabled ? 'active' : 'disabled',
      advice: state.recommendation ? jevAdvice(state.recommendation, state.updatedAt) : null };
    const evidence = this.observations.capture(state.executionId, Boolean(state.recommendation));
    if (evidence) display.evidence = evidence;
    return display;
  }
  private touch(state: StoredExecution) {
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = (state.revision ?? 0) + 1;
  }

  /**
   * Every Human message addressed to a brain is sent to Jev before it is posted; the advice is kept for the brain.
   * Returns null when the caller should post the message itself (Jev off, no brain, or no single owning brain).
   */
  async routeHumanRequest(human: Agent, input: HumanMessageInput, persistReceipt?: (message: Message) => void,
    routingRequest?: string): Promise<RoutedHumanMessage | null> {
    if (human.role !== 'human') throw new HiveError(403, 'Only Human sends requests to brains');
    const config = this.enabled();
    if (!config) return null;
    const channel = this.deps.channels.getChannel(input.channel);
    const { brains, owners } = this.requestOwners(channel, input.body);
    if (!brains.length || this.deps.messages.hasActiveSendRequest(human, channel.id, input.requestId)) return null;
    const request = routingRequest ?? requestText(input);
    // A reply in a request's thread continues that request; any other message starts a new one per owning brain.
    const rooted = input.threadId ? this.store.rootedExecutions(input.threadId).map(parse).filter(state => state.channelId === channel.id) : [];
    const targets: Array<{ brain: Agent; existing: StoredExecution | null }> = rooted.length
      ? rooted.map(state => ({ brain: this.deps.identity.getAgent(state.brainId), existing: state }))
      : owners.map(brain => ({ brain, existing: null }));
    if (!targets.length) { await this.observe(config, channel, request); return null; }
    // Owners are asked in parallel: a Human send waits for the slowest brain, not the sum.
    const planned = await Promise.all(targets.map(async ({ brain, existing }) => {
      const base = existing ?? { executionId: `execution-${randomUUID()}`, channelId: channel.id, projectId: channel.projectId, recommendation: null };
      const trigger = { kind: existing || input.threadId ? 'human_message' as const : 'human_request' as const, eventType: null,
        ...(existing ? { summary: summary(request) } : {}) };
      const decision = await this.evaluate(config, base, brain.id,
        existing ? this.requestOf(existing) : request, existing ? 'continuous' : 'initial', trigger);
      return { brain, existing, base, decision, trigger: trigger.kind };
    }));
    if (this.stopped) throw new HiveError(503, 'Server is shutting down');
    const saved: Array<[StoredExecution, AdaptiveRoutingEvent]> = [];
    const message = this.deps.messages.postMessage(human, input, posted => {
      persistReceipt?.(posted);
      for (const { brain, existing, base, decision, trigger } of planned) {
        const latest = existing ? this.store.execution(existing.executionId) : undefined;
        const state: StoredExecution = latest ? parse(latest) : existing ?? { executionId: base.executionId, channelId: channel.id,
          projectId: channel.projectId, brainId: brain.id, rootMessageId: posted.threadId ?? posted.id, requestMessageId: posted.id,
          recommendation: null, recentEvents: [], updatedAt: 0, revision: 0, completedAt: null };
        // A Human reply reopens a request whose thread was marked done.
        state.completedAt = null; state.recommendation = decision; this.touch(state);
        const event = this.auditEvent(state, 'advice', decision, trigger);
        this.store.saveExecution(state); this.store.saveEvent(event);
        saved.push([state, event]);
      }
    });
    for (const [state, event] of saved) this.publish(state, event);
    return { message, states: saved.map(([state]) => this.displayState(state)) };
  }

  private requestOf(state: StoredExecution): string {
    try { return requestText(this.deps.messageQueries.getMessageById(state.requestMessageId ?? state.rootMessageId)); }
    catch { return ''; }
  }

  /** No single owning brain: Jev still classifies the request for the Human audit; no brain receives advice. */
  private async observe(config: AdaptiveRoutingFile, channel: Channel, request: string) {
    const scope = { executionId: `observation-${randomUUID()}`, channelId: channel.id, projectId: channel.projectId, recommendation: null };
    const decision = await this.evaluate(config, scope, null, request, 'observation', { kind: 'observation', eventType: null });
    if (this.stopped) return;
    const event = this.auditEvent(scope, 'observation', decision, 'observation');
    this.deps.storage.transaction(() => this.store.saveEvent(event));
    this.publish(null, event);
  }

  /** The request a brain action belongs to: its thread's request, the channel's, else the brain's latest open one. */
  private resolve(actor: Agent, action: Pick<BrainAction, 'channelId' | 'threadId'>): StoredExecution | null {
    if (actor.role !== 'brain' || !actor.projectId) return null;
    const all = this.store.brainExecutions(actor.id, actor.projectId).map(parse);
    // An action in a request's own thread belongs to that request, even once it is closed (then there is no advice).
    const rooted = action.threadId ? all.find(state => state.rootMessageId === action.threadId) : undefined;
    if (rooted) return rooted.completedAt ? null : rooted;
    const open = all.filter(state => !state.completedAt);
    return (action.channelId ? open.find(state => state.channelId === action.channelId) : undefined) ?? open[0] ?? null;
  }

  /**
   * Asks Jev about one brain action and returns its advice; the caller has already performed the action. Never throws:
   * a provider failure yields `unavailable` advice, and null means Jev is off or the brain serves no open request.
   */
  async adviseBrainAction(actor: Agent, action: BrainAction): Promise<JevAdvice | null> {
    if (actor.role !== 'brain') return null;
    try {
      const config = this.enabled();
      const state = config ? this.resolve(actor, action) : null;
      if (!config || !state) return null;
      const trigger = { kind: action.kind, eventType: action.eventType ?? null, summary: summary(action.summary) };
      const decision = await this.evaluate(config, state, actor.id, this.requestOf(state), 'continuous', trigger);
      const at = Date.now();
      if (!this.stopped) this.remember(state.executionId, decision, { kind: action.kind, eventType: action.eventType, summary: trigger.summary });
      return jevAdvice(decision, at);
    } catch (error) {
      console.error(`Jev advice for ${actor.name} failed`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }
  private remember(executionId: string, decision: AdaptiveTopologyDecision, event: StoredExecution['recentEvents'][number]) {
    let saved: [StoredExecution, AdaptiveRoutingEvent] | null = null;
    this.deps.storage.transaction(() => {
      const row = this.store.execution(executionId);
      // Replaced by a newer Human request while Jev was answering: the call stays in the log, the advice is returned.
      if (!row) return;
      const state = parse(row);
      state.recommendation = decision; state.recentEvents = [...(state.recentEvents ?? []), event].slice(-8);
      this.touch(state);
      const item = this.auditEvent(state, 'advice', decision, event.kind);
      this.store.saveExecution(state); this.store.saveEvent(item);
      saved = [state, item];
    });
    if (saved) this.publish(...(saved as [StoredExecution, AdaptiveRoutingEvent]));
  }

  /** The latest advice for the request an action belongs to, without calling Jev (retries, idle waits). */
  latestAdvice(actor: Agent, action: Pick<BrainAction, 'channelId' | 'threadId'> = {}): JevAdvice | null {
    if (actor.role !== 'brain' || !loadAdaptiveRouting(this.deps.home)?.enabled) return null;
    try {
      const state = this.resolve(actor, action);
      return state?.recommendation ? jevAdvice(state.recommendation, state.updatedAt) : null;
    } catch { return null; }
  }

  /**
   * Invoked inside the thread-status transaction: marking a request's thread done closes its execution (no more Jev
   * calls for it); reopening resumes it. Human closes every brain's execution on the thread, a brain only its own.
   * Returns a post-commit notification. Never blocks the status change.
   */
  threadStatusChange(actor: Agent, threadId: string, status: ThreadStatus | null): (() => void) | null {
    const owned = this.store.rootedExecutions(threadId).map(parse)
      .filter(state => actor.role === 'human' || state.brainId === actor.id);
    const complete = status === 'done';
    const published: Array<[StoredExecution, AdaptiveRoutingEvent]> = [];
    for (const state of owned) {
      if (complete === Boolean(state.completedAt)) continue;
      this.touch(state); state.completedAt = complete ? state.updatedAt : null;
      const event = this.statusEvent(state, complete ? 'execution_completed' : 'execution_reopened');
      this.store.saveExecution(state); this.store.saveEvent(event);
      published.push([state, event]);
    }
    return published.length ? () => { for (const [state, event] of published) this.publish(state, event); } : null;
  }

  view(actor: Agent, channelId: string): AdaptiveRoutingView {
    if (actor.role !== 'human') throw new HiveError(403, 'Adaptive routing timeline is Human-only');
    const channel = this.deps.channels.getChannel(channelId);
    if (!this.deps.channels.canSeeChannel(actor, channel)) throw new HiveError(403, 'Cannot read routing state');
    const executions = this.store.channelExecutions(channel.id).map(row => this.displayState(parse(row)));
    const state = [...executions].sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.updatedAt - a.updatedAt)[0] ?? null;
    const events = this.store.recentEvents(channel.id).map(row => JSON.parse(String(row.snapshot)) as AdaptiveRoutingEvent).reverse();
    return { state, executions, events, collector: this.observations.collectorHealth() };
  }
}
