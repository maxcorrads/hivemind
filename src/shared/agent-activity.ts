import { MCP_HEARTBEAT_MS, MCP_WAIT_POLL_MS, PRESENCE_IDLE_MS } from "./types.ts";

/** Presence describes observed agent work, independently of a tmux session label. */
export type AgentActivity = {
  state: "ready" | "working" | "stalled" | "offline" | "superseded";
  /** Unix milliseconds when this server first observed the current state. */
  since: number;
  /** A short factual explanation for states requiring attention. */
  hint?: string;
};

/** Allow normal gaps between the MCP client's 20-second HTTP wait polls. */
export const ACTIVITY_WAIT_GRACE_MS = 2 * MCP_WAIT_POLL_MS + 5_000;
/** Two missed heartbeat periods with queued mail and no wait/action is a delivery stall. */
export const ACTIVITY_STALL_MS = 2 * MCP_HEARTBEAT_MS;
/** A past action cannot certify continued work forever when no wait is observed. */
export const ACTIVITY_ACTION_GRACE_MS = PRESENCE_IDLE_MS;

export const ACTIVITY_STALL_HINT = "Mail is queued, but no wait or agent action has been observed recently.";
export const ACTIVITY_UNCLAIMED_HINT = "The launched worker has not joined its reserved identity.";
export const ACTIVITY_SUPERSEDED_HINT = "An older inbox session was superseded; awaiting activity from the current session.";
