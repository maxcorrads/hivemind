import type { AdaptiveTopology } from './adaptive-topology.ts';

/**
 * Recorded with every evidence attempt. Jev is advisory-only since #211: Hivemind applies no policy to its answers,
 * so evidence recorded now is never pooled with evidence of the enforced `topology-policy-v2.1`.
 */
export const TOPOLOGY_POLICY_VERSION = 'topology-advisory-v1';
/** Below this confidence Jev's advice is reported as uncertain. */
export const MIN_TOPOLOGY_CONFIDENCE = 0.60;

export type TopologyTarget = { topology: AdaptiveTopology; workers: number };

export function minimumTopologyWorkers(topology: AdaptiveTopology): number {
  return topology === 'single' ? 0 : topology === 'brain_one_worker' ? 1 : 2;
}
export function validTopologyTarget(target: TopologyTarget, usableWorkers: number): boolean {
  if (!Number.isSafeInteger(target.workers) || target.workers < 0 || target.workers > usableWorkers) return false;
  if (target.topology === 'single') return target.workers === 0;
  if (target.topology === 'brain_one_worker') return target.workers === 1;
  return (target.topology === 'brain_multi_dm' || target.topology === 'brain_multi_room') && target.workers >= 2;
}
/** Plan option ids of the joint Jev question (contract v3): `single`, `brain_one_worker`, `brain_multi_dm_<n>`, `brain_multi_room_<n>`. */
export function topologyPlanId(target: TopologyTarget): string {
  return target.topology === 'brain_multi_dm' || target.topology === 'brain_multi_room' ? `${target.topology}_${target.workers}` : target.topology;
}
/** Inverse of `topologyPlanId`; also accepts `capacity_blocked`. Null for anything else (never repaired). */
export function parseTopologyPlan(id: string): TopologyTarget | 'capacity_blocked' | null {
  if (id === 'capacity_blocked') return id;
  if (id === 'single') return { topology: 'single', workers: 0 };
  if (id === 'brain_one_worker') return { topology: 'brain_one_worker', workers: 1 };
  const match = /^(brain_multi_dm|brain_multi_room)_([1-9][0-9]{0,2})$/.exec(id);
  if (!match) return null;
  const workers = Number(match[2]);
  return workers >= 2 ? { topology: match[1] as 'brain_multi_dm' | 'brain_multi_room', workers } : null;
}
