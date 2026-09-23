import type { AdaptiveIncoherence, AdaptiveTopology, AdaptiveTopologyDecision } from "./adaptive-topology.ts";
import { MIN_TOPOLOGY_CONFIDENCE } from "./adaptive-topology-policy.ts";
import { JEV_MODEL_ALIAS } from "./jev-model.ts";

/**
 * What one Jev call produced, in the terms the Human needs (#209):
 * - `answered`: a valid, coherent answer at or above MIN_TOPOLOGY_CONFIDENCE; the policy may act on it.
 * - `uncertain`: a valid answer below MIN_TOPOLOGY_CONFIDENCE.
 * - `incoherent`: a valid answer whose parts contradict each other; treated exactly like `uncertain`.
 * - `rejected`: a response arrived but could not be used (malformed, or a plan that was not offered).
 * - `unavailable`: no response at all (timeout, network, HTTP error, or a request that was never sent).
 * - `stale`: Jev answered, but worker capacity changed during the call, so the answer was discarded.
 * - `bypassed`: Jev was not called.
 */
export type JevAnswerState = "answered" | "uncertain" | "incoherent" | "rejected" | "unavailable" | "stale" | "bypassed";

type DecisionLike = Pick<AdaptiveTopologyDecision, "providerStatus" | "confidence" | "reason" | "model" | "inputTokens"> &
  { incoherent?: AdaptiveIncoherence | null };

export function jevAnswerState(decision: DecisionLike): JevAnswerState {
  if (decision.providerStatus === "bypassed") return "bypassed";
  if (decision.providerStatus === "unavailable") {
    if (decision.reason.startsWith("capacity_changed_during_")) return "stale";
    // A parsed response keeps its resolved model and tokens even when it is then rejected.
    return decision.reason === "response_rejected_preserve_current" || decision.model !== null || decision.inputTokens !== null
      ? "rejected" : "unavailable";
  }
  if (decision.incoherent) return "incoherent";
  return decision.confidence === null || !(decision.confidence >= MIN_TOPOLOGY_CONFIDENCE) ? "uncertain" : "answered";
}

/** Whether routing may act on this decision: only a coherent answer at or above the confidence threshold. */
export function jevDecisionActionable(decision: DecisionLike): boolean {
  return jevAnswerState(decision) === "answered";
}

export function topologyName(topology: AdaptiveTopology): string {
  if (topology === "single") return "Single";
  if (topology === "brain_one_worker") return "Brain + 1";
  if (topology === "brain_multi_dm") return "Multi-DM";
  return "Room";
}

const INCOHERENCE: Record<AdaptiveIncoherence, string> = {
  plan_vs_sufficiency: "plan contradicts sufficiency",
};
export function incoherenceLabel(incoherent: AdaptiveIncoherence | string): string {
  return INCOHERENCE[incoherent as AdaptiveIncoherence] ?? incoherent.replaceAll("_", " ");
}

const percent = (value: number | null) => value === null ? "no confidence" : `${Math.round(value * 100)}%`;

/**
 * Short, precise description of why Jev's answer was not acted on, or null when it was usable (#209). A response
 * that arrived is never described as "Jev unavailable". `error` is the local failure class (never a provider body).
 */
export function jevNotUsedLabel(decision: DecisionLike & { error?: string | null }): string | null {
  const error = decision.error ? ` (${decision.error})` : "";
  switch (jevAnswerState(decision)) {
    case "unavailable": return `Jev unavailable${error}`;
    case "rejected": return `Jev answer rejected${error}`;
    case "uncertain": return `Jev uncertain (${percent(decision.confidence)})`;
    case "incoherent": return `Jev uncertain (incoherent: ${incoherenceLabel(decision.incoherent!)})`;
    case "stale": return "Capacity changed during the Jev call";
    default: return null;
  }
}

/**
 * Model shown for one call. A default-alias request resolving to a concrete version is normal and shown as
 * `jev-latest → jev-1.13.0`; only a pinned identifier that resolves to something else is flagged.
 */
export function jevModelDisplay(requested: string | null | undefined, resolved: string | null | undefined):
  { text: string; mismatch: boolean } {
  if (!resolved) return { text: requested ?? "—", mismatch: false };
  if (!requested || requested === resolved) return { text: resolved, mismatch: false };
  return { text: `${requested} → ${resolved}`, mismatch: requested !== JEV_MODEL_ALIAS };
}
