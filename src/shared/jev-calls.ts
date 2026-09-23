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
  /** Identifier Hivemind requested. Absent on calls recorded before #134 (their sent payload still has it). */
  requestedModel?: string | null;
  /** Model the provider reported it resolved to. */
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

/** `nextCursor` is opaque: pass it back as `cursor` to load the next (older) page; null when there is none. */
export type JevCallLogView = { requests: JevRequestGroup[]; hasMore: boolean; nextCursor: string | null };

/** Position after the last group of a page: groups are ordered by lastAt DESC, then executionId ASC. */
export type JevCallCursor = { lastAt: number; executionId: string | null };

export function encodeJevCallCursor(cursor: { lastAt: number; executionId: string }): string {
  return `${cursor.lastAt}:${cursor.executionId}`;
}

/** Accepts `<lastAt>:<executionId>` or a legacy bare `<lastAt>` (boundary millisecond excluded). */
export function decodeJevCallCursor(raw: string | null | undefined): JevCallCursor | null {
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const lastAt = Number(colon === -1 ? raw : raw.slice(0, colon));
  if (!Number.isSafeInteger(lastAt) || lastAt < 0) return null;
  const executionId = colon === -1 ? null : raw.slice(colon + 1);
  return { lastAt, executionId: executionId || null };
}
