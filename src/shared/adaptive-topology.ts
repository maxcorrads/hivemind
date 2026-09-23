import type { EvidenceCaptureView, EvidenceCollectorHealth } from "./evidence-health.ts";

/**
 * The ways a brain can organize a Human request. Jev only *suggests* one (#211): Hivemind never applies, enforces or
 * locks a topology. The brain decides, and Human instructions always take precedence over Jev's advice.
 */
export const ADAPTIVE_TOPOLOGIES = [
  "single",
  "brain_one_worker",
  "brain_multi_dm",
  "brain_multi_room",
] as const;

export type AdaptiveTopology = (typeof ADAPTIVE_TOPOLOGIES)[number];

export type AdaptiveWorkerCapacity = {
  total: number;
  online: number;
  /** Live workers holding unfinished structured work from another brain. */
  busyOther: number;
  /** Live workers holding unfinished structured work from this brain. */
  busyCurrent: number;
  free: number;
  /** Workers this brain could use: free ones plus those already working for it. */
  usableForExecution: number;
  available: Array<{
    id: string;
    name: string;
    seniority: "junior" | "mid" | "senior" | null;
    focus: string | null;
    committed: boolean;
  }>;
};

/**
 * v2 asked Jev for a topology and a worker budget separately; v3 asks for one joint plan (#207).
 * Decisions recorded under v2 stay readable (the Routing log, exported evidence).
 */
export type AdaptiveTopologyContractVersion = "adaptive-routing-v2" | "adaptive-routing-v3";

/** One Jev answer (or failure), exactly as the provider adapter produced it. */
export type AdaptiveTopologyDecision = {
  routeId: string;
  contractVersion: AdaptiveTopologyContractVersion;
  targetTopology: AdaptiveTopology;
  targetWorkers: number;
  confidence: number | null;
  reason: string;
  providerStatus: "ok" | "unavailable" | "bypassed";
  /** Jev model identifier Hivemind requested (alias or pinned). Absent on decisions made before #134 or without a call. */
  requestedModel?: string | null;
  /** Model the provider reports it resolved to; may differ from the requested identifier. */
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  singleSufficient: boolean | null;
  needsOrchestration: boolean | null;
  /**
   * Specific failure class when the call did not produce a usable decision (for example `plan_not_offered`,
   * `malformed_answer:<question>`, `http_503`, `timeout`). Absent or null on success and on decisions made before #207.
   */
  error?: string | null;
  /** Set when Jev's answers were valid one by one but contradict each other (#209): the advice is uncertain. */
  incoherent?: AdaptiveIncoherence | null;
};

/** `plan_vs_sufficiency`: a zero-worker plan while saying delegation materially helps and workers are usable. */
export type AdaptiveIncoherence = "plan_vs_sufficiency";

/** How much a brain can rely on one piece of advice. */
export type JevAdviceState = "ok" | "uncertain" | "incoherent" | "unavailable" | "rejected";

export const JEV_ADVICE_NOTE = "Advisory only — you decide; Human instructions take precedence.";

/**
 * Jev's non-binding suggestion, returned to the brain in the response to each of its actions and in wait results.
 * `plan`, `topology` and `workers` are null when no usable answer arrived (`unavailable`, `rejected`).
 */
export type JevAdvice = {
  /** Joint plan id (contract v3): `single`, `brain_one_worker`, `brain_multi_dm_<n>`, `brain_multi_room_<n>`, `capacity_blocked`. */
  plan: string | null;
  topology: AdaptiveTopology | null;
  workers: number | null;
  confidence: number | null;
  state: JevAdviceState;
  /** Why Jev suggested this plan, or the failure class when it could not answer. */
  reason?: string;
  at: number;
  note: typeof JEV_ADVICE_NOTE;
};

/** Human-only audit of what Jev advised; nothing here was enforced. */
export type AdaptiveRoutingEvent = {
  id: string;
  executionId: string;
  channelId: string;
  projectId: string;
  createdAt: number;
  /** advice: delivered to the owning brain · observation: no single owning brain, recorded only · status: request closed or reopened. */
  kind: "advice" | "observation" | "status";
  /** What caused the Jev call (absent on status events). */
  trigger?: string;
  targetTopology: AdaptiveTopology;
  targetWorkers: number;
  confidence: number | null;
  reason: string;
  providerStatus: AdaptiveTopologyDecision["providerStatus"];
  /** The Jev decision this event records; links it to the Human-only call log. */
  routeId?: string;
  incoherent?: AdaptiveIncoherence | null;
  error?: string | null;
};

/**
 * One Human request handled by one brain. It only groups Jev calls (the Routing log and evidence) and keeps the
 * latest advice; it carries no mode, budget or lock.
 */
export type AdaptiveExecutionState = {
  executionId: string;
  channelId: string;
  projectId: string;
  brainId: string;
  rootMessageId: string;
  /** Monotonic per execution. */
  revision?: number;
  updatedAt: number;
  completedAt?: number | null;
  /** active: Jev advises on every brain action · disabled: Jev is off · completed: the request thread is done. */
  monitoring?: "active" | "disabled" | "completed";
  /** The latest Jev decision for this request (null before the first call). */
  recommendation: AdaptiveTopologyDecision | null;
  /** The same decision as the brain received it. */
  advice?: JevAdvice | null;
  /** Human-only: whether Jev overhead for this execution was completely measured. Absent when nothing was recorded. */
  evidence?: EvidenceCaptureView;
};

export type AdaptiveRoutingView = {
  /** The most recently updated open request in this channel. */
  state: AdaptiveExecutionState | null;
  /** The latest request of each brain in this channel. */
  executions?: AdaptiveExecutionState[];
  events: AdaptiveRoutingEvent[];
  /** Human-only health of the evidence collector (independent of Jev availability). */
  collector?: EvidenceCollectorHealth;
};
