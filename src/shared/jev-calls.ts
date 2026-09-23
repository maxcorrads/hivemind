import type { AdaptiveRoutingEvent, AdaptiveTopology, AdaptiveTopologyDecision } from "./adaptive-topology.ts";

/** Why Hivemind asked Jev: the initial request, a Human reply, or a brain coordination boundary. */
export type JevCallTrigger = {
  kind: "human_request" | "human_message" | "brain_message" | "delegation_attempt" | "task_event" | "room_event" | "capacity_change" | "observation";
  eventType: string | null;
};

/** What Hivemind did with the answer, recorded when the routing audit event is committed. */
export type JevCallOutcome = {
  kind: AdaptiveRoutingEvent["kind"];
  applied: boolean;
  appliedTopology: AdaptiveTopology;
  appliedWorkers: number;
  warning: string | null;
};

export type JevCallSummary = {
  id: string;
  routeId: string;
  projectId: string;
  channelId: string;
  executionId: string;
  brainId: string | null;
  createdAt: number;
  phase: "initial" | "continuous" | "observation";
  trigger: JevCallTrigger;
  /** Excerpt of the Human request the execution is classifying. */
  request: string;
  status: AdaptiveTopologyDecision["providerStatus"];
  targetTopology: AdaptiveTopology;
  targetWorkers: number;
  confidence: number | null;
  reason: string;
  error: string | null;
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when the answer was discarded (state changed during the call) or not yet committed. */
  outcome: JevCallOutcome | null;
};

/** Full exchange: the exact JSON sent to TypeSafe (never the API key) and what came back. */
export type JevCall = JevCallSummary & {
  sent: unknown | null;
  received: unknown | null;
};

/** Calls grouped by the Human request (execution) that caused them. */
export type JevRequestGroup = {
  executionId: string;
  channelId: string;
  brainId: string | null;
  request: string;
  firstAt: number;
  lastAt: number;
  callCount: number;
  calls: JevCallSummary[];
};

export type JevCallLogView = { requests: JevRequestGroup[]; hasMore: boolean };
