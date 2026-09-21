import type { AdaptiveTopology } from './adaptive-topology.ts';

export const TOPOLOGY_POLICY_VERSION = 'topology-policy-v2.1';
export const HIGH_TOPOLOGY_CONFIDENCE = 0.90;
export const MIN_TOPOLOGY_CONFIDENCE = 0.60;
export const TOPOLOGY_COOLDOWN_EVENTS = 2;

export type TopologyTarget = { topology: AdaptiveTopology; workers: number };
export type TopologyEvidence = {
  target: TopologyTarget;
  confidence: number | null;
  available: boolean;
};
export type TopologyConfirmation = {
  target: TopologyTarget | null;
  count: number;
  highCount: number;
};
export type TopologyPolicyState = {
  applied: TopologyTarget;
  pending: TopologyTarget | null;
  confirmation: TopologyConfirmation;
  eventsSinceChange: number;
};
export type TopologySafety = {
  usableWorkers: number;
  activeWorkers: number;
  activeTasks: number;
  openBlockers: number;
  openDependencies: number;
  unreconciledClaims: number;
};
export type TopologyPolicyResult = TopologyPolicyState & {
  changed: boolean;
  cause: 'retained' | 'provider_unavailable' | 'low_confidence' | 'human_override'
    | 'confirming' | 'cooldown' | 'safe_checkpoint_pending' | 'transition' | 'capacity_changed';
};

export function minimumTopologyWorkers(topology: AdaptiveTopology): number {
  return topology === 'single' ? 0 : topology === 'brain_one_worker' ? 1 : 2;
}
export function sameTopologyTarget(a: TopologyTarget | null, b: TopologyTarget | null): boolean {
  return a === b || Boolean(a && b && a.topology === b.topology && a.workers === b.workers);
}
export function validTopologyTarget(target: TopologyTarget, usableWorkers: number): boolean {
  if (!Number.isSafeInteger(target.workers) || target.workers < 0 || target.workers > usableWorkers) return false;
  if (target.topology === 'single') return target.workers === 0;
  if (target.topology === 'brain_one_worker') return target.workers === 1;
  return (target.topology === 'brain_multi_dm' || target.topology === 'brain_multi_room') && target.workers >= 2;
}
export function topologyIsEscalation(from: TopologyTarget, to: TopologyTarget): boolean {
  const ranks: Record<AdaptiveTopology, number> = { single: 0, brain_one_worker: 1, brain_multi_dm: 2, brain_multi_room: 3 };
  return ranks[to.topology] > ranks[from.topology] ||
    (to.topology === from.topology && to.workers > from.workers);
}
export function topologyCheckpointSafe(target: TopologyTarget, safety: TopologySafety): boolean {
  if (!validTopologyTarget(target, safety.usableWorkers)) return false;
  if (safety.activeWorkers > target.workers) return false;
  if (target.topology === 'single') return safety.activeTasks === 0 && safety.openBlockers === 0 &&
    safety.openDependencies === 0 && safety.unreconciledClaims === 0;
  return safety.openBlockers === 0 && safety.openDependencies === 0 && safety.unreconciledClaims === 0;
}
export function initialTopologyPolicy(applied: TopologyTarget): TopologyPolicyState {
  return { applied: { ...applied }, pending: null,
    confirmation: { target: null, count: 0, highCount: 0 },
    // Initial selection is not a transition: do not delay the first escalation.
    eventsSinceChange: TOPOLOGY_COOLDOWN_EVENTS };
}

/** One call per distinct coordination event. Never call this twice for one mutation/retry. */
export function advanceTopologyPolicy(
  previous: TopologyPolicyState,
  evidence: TopologyEvidence,
  safety: TopologySafety,
  humanOverride: TopologyTarget | null = null,
): TopologyPolicyResult {
  const state = structuredClone(previous);
  state.eventsSinceChange = Math.min(TOPOLOGY_COOLDOWN_EVENTS, state.eventsSinceChange + 1);
  const reset = () => { state.confirmation = { target: null, count: 0, highCount: 0 }; };
  const result = (cause: TopologyPolicyResult['cause'], changed = false): TopologyPolicyResult =>
    ({ ...state, cause, changed });

  // A failure must not become a vote for a change, even when a target was pending.
  if (!evidence.available || evidence.confidence === null || !Number.isFinite(evidence.confidence)) {
    reset();
    return result('provider_unavailable');
  }
  // Includes a one-request manual choice: scope='none' does not remove Human authority.
  if (humanOverride) {
    reset();
    if (!sameTopologyTarget(state.applied, humanOverride)) {
      state.pending = { ...humanOverride };
      if (topologyCheckpointSafe(humanOverride, safety)) {
        state.applied = { ...humanOverride }; state.pending = null; state.eventsSinceChange = 0;
        return result('human_override', true);
      }
    } else state.pending = null;
    return result('human_override');
  }
  if (evidence.confidence < MIN_TOPOLOGY_CONFIDENCE || evidence.confidence > 1) {
    reset();
    // Keep existing execution and a previously confirmed drain target, but do not apply it.
    return result('low_confidence');
  }
  if (!validTopologyTarget(evidence.target, safety.usableWorkers)) {
    reset();
    return result('capacity_changed');
  }
  if (sameTopologyTarget(evidence.target, state.applied)) {
    reset(); state.pending = null;
    return result('retained');
  }

  const same = sameTopologyTarget(state.confirmation.target, evidence.target);
  state.confirmation = {
    target: { ...evidence.target },
    count: same ? state.confirmation.count + 1 : 1,
    highCount: evidence.confidence >= HIGH_TOPOLOGY_CONFIDENCE ? (same ? state.confirmation.highCount + 1 : 1) : 0,
  };
  // A recommendation reversal invalidates an older pending transition immediately.
  if (state.pending && !sameTopologyTarget(state.pending, evidence.target)) state.pending = null;
  const escalation = topologyIsEscalation(state.applied, evidence.target);
  const confirmed = evidence.target.topology === 'single'
    ? state.confirmation.highCount >= 2 || state.confirmation.count >= 3
    : escalation
      ? evidence.confidence >= HIGH_TOPOLOGY_CONFIDENCE || state.confirmation.count >= 2
      : state.confirmation.count >= 2;
  if (!confirmed) return result('confirming');
  if (state.eventsSinceChange < TOPOLOGY_COOLDOWN_EVENTS) return result('cooldown');

  // Escalation may leave existing useful work running. De-escalation must reconcile it.
  const safe = escalation
    ? safety.activeWorkers <= evidence.target.workers
    : topologyCheckpointSafe(evidence.target, safety);
  if (!safe) {
    state.pending = { ...evidence.target };
    return result('safe_checkpoint_pending');
  }
  state.applied = { ...evidence.target };
  state.pending = null;
  reset();
  state.eventsSinceChange = 0;
  return result('transition', true);
}
