export const ADAPTIVE_TOPOLOGIES = [
  "single",
  "brain_one_worker",
  "brain_multi_dm",
  "brain_multi_room",
] as const;

export type AdaptiveTopology = (typeof ADAPTIVE_TOPOLOGIES)[number];
export type AdaptiveRoutingMode =
  | "auto"
  | AdaptiveTopology
  | "orchestrated_auto";

export type AdaptiveLockScope = "none" | "task" | "conversation";

export type AdaptiveWorkerCapacity = {
  total: number;
  online: number;
  busyOther: number;
  busyCurrent: number;
  free: number;
  usableForExecution: number;
  available: Array<{
    id: string;
    name: string;
    seniority: "junior" | "mid" | "senior" | null;
    focus: string | null;
    committed: boolean;
  }>;
};

export type AdaptiveTopologyDecision = {
  routeId: string;
  contractVersion: "adaptive-routing-v2";
  targetTopology: AdaptiveTopology;
  targetWorkers: number;
  confidence: number | null;
  reason: string;
  providerStatus: "ok" | "unavailable" | "bypassed";
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  singleSufficient: boolean | null;
  needsOrchestration: boolean | null;
};

export type AdaptiveRoutingEvent = {
  id: string;
  executionId: string;
  channelId: string;
  projectId: string;
  createdAt: number;
  /** observation: Jev classified a request without a single owning brain; nothing was enforced. */
  kind: "evaluation" | "transition" | "warning" | "lock" | "status" | "observation";
  fromTopology: AdaptiveTopology;
  targetTopology: AdaptiveTopology;
  appliedTopology: AdaptiveTopology;
  targetWorkers: number;
  appliedWorkers: number;
  confidence: number | null;
  reason: string;
  providerStatus: AdaptiveTopologyDecision["providerStatus"];
  applied: boolean;
  warning: string | null;
  /** The Jev decision this event consumed; links it to the Human-only call log. */
  routeId?: string;
};

export type AdaptiveMonitoring = "active" | "pending" | "disabled" | "unavailable" | "completed";

export type AdaptiveExecutionState = {
  /** Monotonic within a channel, including settings/lifecycle changes. */
  revision?: number;
  completedAt?: number | null;
  monitoring?: AdaptiveMonitoring;
  executionId: string;
  channelId: string;
  projectId: string;
  brainId: string;
  rootMessageId: string;
  currentTopology: AdaptiveTopology;
  workerBudget: number;
  desiredTopology: AdaptiveTopology | null;
  desiredWorkers: number | null;
  lockScope: AdaptiveLockScope;
  lockedTopology: AdaptiveTopology | null;
  orchestratedOnly: boolean;
  providerAvailable: boolean;
  warning: string | null;
  recommendation: AdaptiveTopologyDecision | null;
  confirmations: number;
  confirmationTopology: AdaptiveTopology | null;
  confirmationWorkers: number | null;
  eventsSinceChange: number;
  updatedAt: number;
  /**
   * False once a newer Human request to the same brain replaced this execution: it is draining its delegated work
   * (or has finished draining). Absent or true for the brain's current execution in the channel.
   */
  current?: boolean;
  /** Draining executions only: an excerpt of the Human request they serve. */
  requestExcerpt?: string;
  /** Draining executions only: delegated work still open (structured tasks and free-form delegations). */
  openWork?: { tasks: number; delegations: number };
};

export type AdaptiveAgentPolicy = {
  executionId: string;
  currentTopology: AdaptiveTopology;
  workerBudget: number;
  desiredTopology: AdaptiveTopology | null;
  desiredWorkers: number | null;
  lockScope: AdaptiveLockScope;
  lockedTopology: AdaptiveTopology | null;
};

export type AdaptiveRoutingView = {
  /** Primary execution in the channel: the most recently updated current one still running. */
  state: AdaptiveExecutionState | null;
  /**
   * Every execution in this channel: the current one per brain that owns a request, plus older ones replaced by a
   * newer request (`current: false`) that are still draining their delegated work or finished draining.
   */
  executions?: AdaptiveExecutionState[];
  events: AdaptiveRoutingEvent[];
};
