import type { DatabaseSync } from 'node:sqlite';
import { TOPOLOGY_POLICY_VERSION } from '../shared/adaptive-topology-policy.ts';
import { AdaptiveEvidenceStore, type EvidenceScope } from './adaptive-evidence.ts';
import { evaluateAdaptiveTopology, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';

const stores = new WeakMap<DatabaseSync, AdaptiveEvidenceStore>();
/** Observe every attempt, BEFORE capacity/configuration fencing can discard its result. */
export async function observeTopologyEvaluation(
  db: DatabaseSync, scope: EvidenceScope, snapshot: TopologyEvaluationSnapshot,
  config: { apiKey: string }, options: Parameters<typeof evaluateAdaptiveTopology>[2] = {},
) {
  let store: AdaptiveEvidenceStore | undefined, id: string | undefined;
  try {
    store = stores.get(db);
    if (!store) { store = new AdaptiveEvidenceStore(db); stores.set(db, store); }
    id = store.begin(scope, { topology: snapshot.current?.topology ?? null,
      workers: snapshot.current?.workerBudget ?? 0, usableWorkers: snapshot.capacity.workers.usableForExecution,
      policyVersion: TOPOLOGY_POLICY_VERSION });
  } catch { console.error('Adaptive evidence recording unavailable; measurements may be incomplete'); }
  const decision = await evaluateAdaptiveTopology(snapshot, config, options);
  if (id && store) {
    try { store.finish(id, decision); }
    catch { console.error('Adaptive evidence outcome unavailable; attempt usage is unknown'); }
  }
  return decision;
}
