import { randomUUID } from 'node:crypto';
import type { AdaptiveRuntimeDeps } from "./services/ports.ts";
import { parseMentions } from '../shared/mentions.ts';
import { HiveError, type Agent, type Channel, type Message, type ThreadStatus } from '../shared/types.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView,
  AdaptiveTopologyDecision, JevAdvice } from '../shared/adaptive-topology.ts';
import type { JevCallSummary, JevCallTrigger } from '../shared/jev-calls.ts';
import { jevAdvice } from '../shared/jev-outcome.ts';
import { cachedAdaptiveRouting, type AdaptiveRoutingFile } from './adaptive-config.ts';
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
  kind: Exclude<JevCallTrigger['kind'], 'human_request' | 'human_message' | 'capacity_change' | 'observation' | 'wait'>;
  channelId?: string; threadId?: string; taskId?: string; eventType?: string; summary?: string;
};
/** Where an action happened: only used to find the request it belongs to (#214: never another channel's). */
export type ActionHint = Pick<BrainAction, 'channelId' | 'threadId'>;
type StoredExecution = AdaptiveExecutionState & {
  /** The Human message classified as the request; rootMessageId is its thread root. */
  requestMessageId?: string;
  /** The last brain actions Jev saw for this request (kind, eventType and a short summary only). */
  recentEvents: Array<{ kind: string; eventType?: string; summary?: string }>;
  /** When the call behind `recommendation` started: an older call answering late never replaces newer advice (#214). */
  adviceRequestedAt?: number;
};

/** An open request with no Human reply, brain action or advice for this long is closed (#214). */
export const EXECUTION_IDLE_MS = 4 * 60 * 60_000;

function requestText(message: Pick<Message, 'body' | 'source'>): string {
  return message.source === 'telegram' ? message.body.replace(/^\[[^\]\r\n]*\]\s?/, '') : message.body;
}
const parse = (row: Record<string, unknown>) => JSON.parse(String(row.snapshot)) as StoredExecution;
const summary = (text: string | undefined) => text?.trim().slice(0, 400) || undefined;
/** Advice a brain can use; a failed call is recorded in the Routing log only and never reaches a brain (#214). */
const usable = (advice: JevAdvice | null) => advice && advice.state !== 'unavailable' && advice.state !== 'rejected' ? advice : null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Jev as a non-binding, optional advisor to brains (#211, #214).
 *
 * A Human message is committed and broadcast first; Jev is asked in the background and its advice reaches the owning
 * brain as `jevAdvice` in the response to its next action. A brain action attributed to an open request (same thread
 * or channel) is sent to Jev after it has been performed and the advice is returned with it. Hivemind never applies,
 * enforces or locks a topology, never blocks an action because of Jev, and posts no message of its own. Calls are
 * grouped per Human request (execution) only for the Human-only Routing log and evidence. With Jev disabled nothing
 * here calls the provider or adds anything to a response.
 */
export class AdaptiveTopologyRuntime {
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private lastRequested = 0;
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

  /** Resolves once every Jev call started so far, including background advice for Human messages, is recorded. */
  async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled(this.inFlight);
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
    const config = cachedAdaptiveRouting(this.deps.home);
    return config?.enabled && !this.stopped ? config : null;
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => undefined);
    return work;
  }
  private background(work: Promise<unknown>) {
    this.track(work.catch(error => { if (!this.stopped) console.error('Background Jev advice failed', message(error)); }));
  }
  /** A strictly increasing start time, so overlapping calls for one request can be ordered. */
  private requestedAt() { return this.lastRequested = Math.max(Date.now(), this.lastRequested + 1); }
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
    const { recentEvents: _recent, requestMessageId: _request, adviceRequestedAt: _requested, ...rest } = state;
    const display: AdaptiveExecutionState = { ...rest,
      monitoring: state.completedAt ? 'completed' : cachedAdaptiveRouting(this.deps.home)?.enabled ? 'active' : 'disabled',
      advice: state.recommendation ? jevAdvice(state.recommendation, state.updatedAt) : null };
    const evidence = this.observations.capture(state.executionId, Boolean(state.recommendation));
    if (evidence) display.evidence = evidence;
    return display;
  }
  private touch(state: StoredExecution) {
    state.updatedAt = Math.max(Date.now(), state.updatedAt + 1); state.revision = (state.revision ?? 0) + 1;
  }

  /**
   * Called once a Human message has been committed and broadcast (UI and Telegram); Jev is never on the send path
   * (#214). Records the request for its owning brain(s) at once, so their next actions are attributed to it, then asks
   * Jev in the background. Callers skip it for a retried send. Never throws; does nothing while Jev is off.
   * `routingRequest` is the text Jev sees when it differs from the stored body (Telegram).
   */
  humanMessagePosted(human: Agent, posted: Message, routingRequest?: string): void {
    try {
      if (human.role !== 'human') return;
      const config = this.enabled();
      if (!config) return;
      const channel = this.deps.channels.getChannel(posted.channelId);
      const { brains, owners } = this.requestOwners(channel, posted.body);
      if (!brains.length) return;
      const request = routingRequest ?? requestText(posted);
      const requestedAt = this.requestedAt();
      // A reply in a request's thread continues that request; any other message starts a new one per owning brain.
      const rooted = posted.threadId ? this.store.rootedExecutions(posted.threadId).map(parse).filter(state => state.channelId === channel.id) : [];
      if (!rooted.length && !owners.length) { this.background(this.observe(config, channel, request)); return; }
      const states: StoredExecution[] = rooted.length ? rooted : owners.map(brain => ({ executionId: `execution-${randomUUID()}`,
        channelId: channel.id, projectId: channel.projectId, brainId: brain.id, rootMessageId: posted.threadId ?? posted.id,
        requestMessageId: posted.id, recommendation: null, recentEvents: [], updatedAt: 0, revision: 0, completedAt: null }));
      this.deps.storage.transaction(() => {
        // A Human reply reopens a request whose thread was marked done or that was closed after inactivity.
        for (const state of states) { state.completedAt = null; this.touch(state); this.store.saveExecution(state); }
      });
      const continued = rooted.length > 0;
      const trigger = { kind: continued || posted.threadId ? 'human_message' as const : 'human_request' as const, eventType: null,
        ...(continued ? { summary: summary(request) } : {}) };
      for (const state of states) {
        this.background(this.evaluate(config, state, state.brainId, continued ? this.requestOf(state) : request,
          continued ? 'continuous' : 'initial', trigger).then(decision => {
          if (!this.stopped) this.remember(state.executionId, decision, requestedAt, trigger.kind);
        }));
      }
    } catch (error) {
      console.error('Jev advice for a Human message failed', message(error));
    }
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

  /**
   * The open request a brain action belongs to: its thread's request, else the brain's request in the same channel;
   * never one in another channel (#214). A request idle for EXECUTION_IDLE_MS is closed here and yields nothing.
   */
  private resolve(actor: Agent, hint: ActionHint): StoredExecution | null {
    if (actor.role !== 'brain' || !actor.projectId) return null;
    // An action in a request's own thread belongs to that request, even once it is closed (then there is no advice).
    const rooted = hint.threadId ? this.store.rootedExecutions(hint.threadId).map(parse).find(state => state.brainId === actor.id) : undefined;
    const row = rooted || !hint.channelId ? undefined : this.store.currentExecution(hint.channelId, actor.id);
    const state = rooted ?? (row ? parse(row) : null);
    if (!state || state.completedAt || this.expireIfIdle(state)) return null;
    return state;
  }
  /** Closes an open request nobody touched for EXECUTION_IDLE_MS; returns whether it did. */
  private expireIfIdle(state: StoredExecution): boolean {
    if (Date.now() - state.updatedAt < EXECUTION_IDLE_MS) return false;
    const event = this.deps.storage.transaction(() => {
      this.touch(state); state.completedAt = state.updatedAt;
      const expired = this.statusEvent(state, 'execution_expired');
      this.store.saveExecution(state); this.store.saveEvent(expired);
      return expired;
    });
    this.publish(state, event);
    return true;
  }

  /**
   * Asks Jev about one brain action and returns its advice; the caller has already performed the action. Never throws:
   * null means Jev is off, the brain serves no open request in that thread or channel, or Jev gave no usable answer
   * (a failure is recorded in the Routing log only).
   */
  async adviseBrainAction(actor: Agent, action: BrainAction): Promise<JevAdvice | null> {
    if (actor.role !== 'brain') return null;
    try {
      const config = this.enabled();
      const state = config ? this.resolve(actor, action) : null;
      if (!config || !state) return null;
      const trigger = { kind: action.kind, eventType: action.eventType ?? null, summary: summary(action.summary) };
      const requestedAt = this.requestedAt();
      const decision = await this.evaluate(config, state, actor.id, this.requestOf(state), 'continuous', trigger);
      const at = Date.now();
      if (!this.stopped) this.remember(state.executionId, decision, requestedAt, action.kind,
        { kind: action.kind, eventType: action.eventType, summary: trigger.summary });
      return usable(jevAdvice(decision, at));
    } catch (error) {
      console.error(`Jev advice for ${actor.name} failed`, message(error));
      return null;
    }
  }
  private remember(executionId: string, decision: AdaptiveTopologyDecision, requestedAt: number, trigger: string,
    event?: StoredExecution['recentEvents'][number]) {
    let saved: [StoredExecution, AdaptiveRoutingEvent] | null = null;
    this.deps.storage.transaction(() => {
      const row = this.store.execution(executionId);
      // Replaced by a newer Human request while Jev was answering: the call stays in the log only.
      if (!row) return;
      const state = parse(row);
      // Overlapping calls (a Human message and a brain action) can answer out of order: the newest call's advice wins.
      if ((state.adviceRequestedAt ?? 0) <= requestedAt) { state.recommendation = decision; state.adviceRequestedAt = requestedAt; }
      if (event) state.recentEvents = [...(state.recentEvents ?? []), event].slice(-8);
      this.touch(state);
      const item = this.auditEvent(state, 'advice', decision, trigger);
      this.store.saveExecution(state); this.store.saveEvent(item);
      saved = [state, item];
    });
    if (saved) this.publish(...(saved as [StoredExecution, AdaptiveRoutingEvent]));
  }

  /**
   * The latest usable advice for the request an action belongs to, without calling Jev (retries and waits). With
   * several hints (the threads a wait delivered), the first one that belongs to an open request wins.
   */
  latestAdvice(actor: Agent, ...hints: ActionHint[]): JevAdvice | null {
    if (actor.role !== 'brain' || !this.enabled()) return null;
    try {
      for (const hint of hints) {
        const state = this.resolve(actor, hint);
        if (state) return state.recommendation ? usable(jevAdvice(state.recommendation, state.updatedAt)) : null;
      }
      return null;
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
