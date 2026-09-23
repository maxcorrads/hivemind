import type { DatabaseSync } from 'node:sqlite';
import { TOPOLOGY_POLICY_VERSION } from '../shared/adaptive-topology-policy.ts';
import { AdaptiveEvidenceStore, evidenceCapture, type EvidenceScope } from './adaptive-evidence.ts';
import { EvidenceCollectorMonitor } from './adaptive-evidence-health.ts';
import type { EvidenceCaptureView, EvidenceCollectorHealth } from '../shared/evidence-health.ts';
import { evaluateAdaptiveTopology, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { JevCallLog, type JevCallContext, type JevExchange } from './jev-call-log.ts';
import type { JevCallSummary } from '../shared/jev-calls.ts';

/**
 * The evidence and Jev call stores of one database, owned by its AdaptiveTopologyRuntime
 * (`hive.adaptiveTopology.observations`). Each store is opened on first use, so a failure
 * surfaces in the observing call (and is retried next time) rather than at startup.
 */
export class AdaptiveObservationStores {
  #evidence: AdaptiveEvidenceStore | undefined;
  #jevCalls: JevCallLog | undefined;
  /** Evidence-collector health (Human-only), independent of whether Jev itself answered. */
  readonly collector: EvidenceCollectorMonitor;
  constructor(private readonly db: DatabaseSync, healthChanged?: (health: EvidenceCollectorHealth) => void) {
    this.collector = new EvidenceCollectorMonitor(healthChanged);
  }
  get evidence(): AdaptiveEvidenceStore { return this.#evidence ??= new AdaptiveEvidenceStore(this.db); }
  get jevCalls(): JevCallLog { return this.#jevCalls ??= new JevCallLog(this.db); }
  /** Retries persisting held gap markers, then reports health. Never throws. */
  collectorHealth(): EvidenceCollectorHealth {
    this.collector.flush(() => this.evidence);
    return this.collector.health();
  }
  /** Human-only capture state of one execution; unknown when the store cannot be read. */
  capture(executionId: string, jevCalled: boolean): EvidenceCaptureView | null {
    try {
      const view = evidenceCapture(this.db, executionId, this.collector.pendingFor(executionId));
      return view ?? (jevCalled ? { capture: 'unknown', reasons: ['not_recorded'] } : null);
    } catch { return { capture: 'unknown', reasons: ['recorder_unavailable'] }; }
  }
}

/** Observe every attempt, BEFORE capacity/configuration fencing can discard its result. */
export async function observeTopologyEvaluation(
  stores: AdaptiveObservationStores, scope: EvidenceScope, snapshot: TopologyEvaluationSnapshot,
  config: { apiKey: string; model?: string }, options: Parameters<typeof evaluateAdaptiveTopology>[2] = {},
  call?: { context: Omit<JevCallContext, 'executionId' | 'channelId' | 'projectId'>; recorded?: (summary: JevCallSummary) => void },
) {
  let store: AdaptiveEvidenceStore | undefined, id: string | undefined;
  const runScope = { executionId: scope.executionId, channelId: scope.channelId, projectId: scope.projectId };
  // Earlier gap markers are persisted before this attempt counts toward a capture.
  stores.collector.flush(() => stores.evidence);
  try {
    store = stores.evidence;
    id = store.begin(scope, { topology: snapshot.current?.topology ?? null,
      workers: snapshot.current?.workerBudget ?? 0, usableWorkers: snapshot.capacity.workers.usableForExecution,
      policyVersion: TOPOLOGY_POLICY_VERSION });
  } catch {
    console.error('Adaptive evidence recording unavailable; measurements may be incomplete');
    stores.collector.failed('begin', runScope, TOPOLOGY_POLICY_VERSION);
  }
  let exchange: JevExchange | null = null;
  const decision = await evaluateAdaptiveTopology(snapshot, config, { ...options, onExchange: value => {
    exchange = value; options.onExchange?.(value);
  } });
  if (call && exchange) {
    try {
      const summary = stores.jevCalls.record({ ...call.context, executionId: scope.executionId,
        channelId: scope.channelId, projectId: scope.projectId }, exchange, decision);
      call.recorded?.(summary);
    } catch { console.error('Jev call log unavailable; this exchange is not in the Human history'); }
  }
  if (id && store) {
    try { store.finish(id, decision); }
    catch {
      console.error('Adaptive evidence outcome unavailable; attempt usage is unknown');
      stores.collector.failed('finish', runScope, TOPOLOGY_POLICY_VERSION);
    }
  }
  // A failure affecting only some writes can often be marked straight away.
  stores.collector.flush(() => stores.evidence);
  return decision;
}
