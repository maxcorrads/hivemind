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
  kind: "evaluation" | "transition" | "warning" | "lock";
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
};

export type AdaptiveExecutionState = {
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
  state: AdaptiveExecutionState | null;
  events: AdaptiveRoutingEvent[];
};
