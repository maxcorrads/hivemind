import type { DatabaseSync } from 'node:sqlite';
import { TOPOLOGY_POLICY_VERSION } from '../shared/adaptive-topology-policy.ts';
import { AdaptiveEvidenceStore, type EvidenceScope } from './adaptive-evidence.ts';
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
  constructor(private readonly db: DatabaseSync) {}
  get evidence(): AdaptiveEvidenceStore { return this.#evidence ??= new AdaptiveEvidenceStore(this.db); }
  get jevCalls(): JevCallLog { return this.#jevCalls ??= new JevCallLog(this.db); }
}

/** Observe every attempt, BEFORE capacity/configuration fencing can discard its result. */
export async function observeTopologyEvaluation(
  stores: AdaptiveObservationStores, scope: EvidenceScope, snapshot: TopologyEvaluationSnapshot,
  config: { apiKey: string; model?: string }, options: Parameters<typeof evaluateAdaptiveTopology>[2] = {},
  call?: { context: Omit<JevCallContext, 'executionId' | 'channelId' | 'projectId'>; recorded?: (summary: JevCallSummary) => void },
) {
  let store: AdaptiveEvidenceStore | undefined, id: string | undefined;
  try {
    store = stores.evidence;
    id = store.begin(scope, { topology: snapshot.current?.topology ?? null,
      workers: snapshot.current?.workerBudget ?? 0, usableWorkers: snapshot.capacity.workers.usableForExecution,
      policyVersion: TOPOLOGY_POLICY_VERSION });
  } catch { console.error('Adaptive evidence recording unavailable; measurements may be incomplete'); }
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
    catch { console.error('Adaptive evidence outcome unavailable; attempt usage is unknown'); }
  }
  return decision;
}
