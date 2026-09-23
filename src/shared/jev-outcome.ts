import { JEV_ADVICE_NOTE, type AdaptiveIncoherence, type AdaptiveTopology, type AdaptiveTopologyDecision,
  type JevAdvice, type JevAdviceState } from "./adaptive-topology.ts";
import { MIN_TOPOLOGY_CONFIDENCE, topologyPlanId } from "./adaptive-topology-policy.ts";
import { JEV_MODEL_ALIAS } from "./jev-model.ts";

/**
 * What one Jev call produced, in the terms the Human and the brain need (#209, #211):
 * - `answered`: a valid, coherent answer at or above MIN_TOPOLOGY_CONFIDENCE.
 * - `uncertain`: a valid answer below MIN_TOPOLOGY_CONFIDENCE.
 * - `incoherent`: a valid answer whose parts contradict each other; uncertain by definition.
 * - `rejected`: a response arrived but could not be used (malformed, or a plan that was not offered).
 * - `unavailable`: no response at all (timeout, network, HTTP error, or a request that was never sent).
 * - `stale`: calls recorded before #211 whose answer was discarded because capacity changed during the call.
 * - `bypassed`: Jev was not called (recorded before #211 for manual selections).
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
const workers = (n: number) => `${n} worker${n === 1 ? "" : "s"}`;

/** A suggested plan in words: `Multi-DM · 2 workers`, `Single`, `Needs workers, none available`. */
export function planLabel(plan: Pick<AdaptiveTopologyDecision, "targetTopology" | "targetWorkers" | "reason">): string {
  if (plan.reason === "orchestration_needed_no_capacity") return "Needs workers, none available";
  return `${topologyName(plan.targetTopology)}${plan.targetWorkers > 1 ? ` · ${workers(plan.targetWorkers)}` : ""}`;
}

/**
 * Jev's advice in one short line (#211): `Jev suggested Multi-DM · 2 workers (72%)`, `Jev uncertain (41%) · Single`,
 * `Jev unavailable (timeout)`. A response that arrived is never described as "Jev unavailable". `error` is the local
 * failure class (never a provider body).
 */
export function jevAdviceLabel(decision: DecisionLike & Pick<AdaptiveTopologyDecision, "targetTopology" | "targetWorkers"> &
  { error?: string | null }): string {
  const error = decision.error ? ` (${decision.error})` : "";
  switch (jevAnswerState(decision)) {
    case "answered": return `Jev suggested ${planLabel(decision)} (${percent(decision.confidence)})`;
    case "uncertain": return `Jev uncertain (${percent(decision.confidence)}) · ${planLabel(decision)}`;
    case "incoherent": return `Jev uncertain (incoherent: ${incoherenceLabel(decision.incoherent!)})`;
    case "unavailable": return `Jev unavailable${error}`;
    case "rejected": return `Jev answer rejected${error}`;
    case "stale": return "Capacity changed during the Jev call";
    default: return "Jev not called";
  }
}

/** The advice a brain receives for one decision; null when Jev was not called. */
export function jevAdvice(decision: AdaptiveTopologyDecision, at: number): JevAdvice | null {
  const answer = jevAnswerState(decision);
  if (answer === "bypassed") return null;
  const state: JevAdviceState = answer === "answered" ? "ok" : answer === "stale" ? "unavailable" : answer;
  const usable = state === "ok" || state === "uncertain" || state === "incoherent";
  const blocked = decision.reason === "orchestration_needed_no_capacity";
  const reason = usable ? decision.reason : decision.error ?? decision.reason;
  return {
    plan: !usable ? null : blocked ? "capacity_blocked" : topologyPlanId({ topology: decision.targetTopology, workers: decision.targetWorkers }),
    topology: usable ? decision.targetTopology : null,
    workers: usable ? decision.targetWorkers : null,
    confidence: decision.confidence,
    state,
    ...(reason ? { reason } : {}),
    at,
    note: JEV_ADVICE_NOTE,
  };
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
