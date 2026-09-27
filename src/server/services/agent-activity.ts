import {
  ACTIVITY_ACTION_GRACE_MS,
  ACTIVITY_STALL_HINT,
  ACTIVITY_STALL_MS,
  ACTIVITY_SUPERSEDED_HINT,
  ACTIVITY_UNCLAIMED_HINT,
  ACTIVITY_WAIT_GRACE_MS,
  type AgentActivity,
} from "../../shared/agent-activity.ts";
import { PRESENCE_IDLE_MS, type Agent } from "../../shared/types.ts";

export type WaitEndReason = "mail" | "idle" | "aborted" | "superseded" | "shutdown" | "error";

export type AgentActivityDeps = {
  readonly identity: { getAgent(id: string): Agent; listAgents(): Agent[] };
  readonly delivery: { queuedCount(agentId: string): number };
  readonly launcherQueue?: { launchPresence(agentId: string): { state: string; since: number } | null };
  readonly bus: { emit(type: "agent", agent: Agent): void };
};

type Observation = {
  nextWaitToken: number;
  activeWaitToken: number | null;
  superseded: boolean;
  lastIdleWaitAt: number | null;
  lastWorkAt: number | null;
  lastProgressAt: number | null;
  queueSince: number | null;
  queued: number;
  current: AgentActivity | null;
};

/**
 * Ephemeral evidence of an agent's MCP loop. The durable agent heartbeat is only
 * a liveness bound: it never proves the agent is waiting or working. A server
 * restart intentionally forgets wait/action evidence and projects conservatively
 * until the current client acts again. No timer or database write lives here.
 */
export class AgentActivityService {
  private readonly observations = new Map<string, Observation>();

  constructor(private readonly deps: AgentActivityDeps) {}

  private observation(id: string): Observation {
    let value = this.observations.get(id);
    if (!value) {
      value = { nextWaitToken: 0, activeWaitToken: null, superseded: false,
        lastIdleWaitAt: null, lastWorkAt: null, lastProgressAt: null,
        queueSince: null, queued: 0, current: null };
      this.observations.set(id, value);
    }
    return value;
  }

  /** A validated, admitted wait. The token fences late cleanup from an older overlapping wait. */
  waitStarted(id: string, _sessionId: string, at = Date.now()): number {
    const entry = this.observation(id);
    const token = ++entry.nextWaitToken;
    entry.activeWaitToken = token;
    entry.superseded = false;
    entry.lastProgressAt = at;
    this.refresh(id, at);
    return token;
  }

  waitEnded(id: string, token: number, reason: WaitEndReason, at = Date.now()): void {
    const entry = this.observations.get(id);
    if (!entry || entry.activeWaitToken !== token) return;
    entry.activeWaitToken = null;
    if (reason === "superseded") entry.superseded = true;
    if (reason === "mail" || reason === "idle") {
      entry.lastProgressAt = at;
      if (reason === "mail") { entry.lastWorkAt = at; entry.lastIdleWaitAt = null; }
      else entry.lastIdleWaitAt = at;
    }
    this.refresh(id, at);
  }

  /** Only an actual inbox-session replacement marks superseded; replacing one HTTP wait does not. */
  sessionSuperseded(id: string, at = Date.now()): void {
    const entry = this.observation(id);
    entry.superseded = true;
    this.refresh(id, at);
  }

  /** A successful authenticated agent operation, excluding heartbeat and wait transport. */
  action(id: string, at = Date.now()): void {
    const entry = this.observation(id);
    entry.lastWorkAt = at;
    entry.lastProgressAt = at;
    entry.superseded = false;
    this.refresh(id, at);
  }

  /** Called with the already-computed inbox estimate after a committed queue change. */
  queueChanged(id: string, queued: number, at = Date.now()): void {
    this.refresh(id, at, queued);
  }

  private classify(agent: Agent, entry: Observation, at: number): Pick<AgentActivity, "state" | "hint"> {
    if (agent.role !== "brain" && agent.role !== "worker") return { state: "offline" };
    if (agent.removedAt !== undefined || agent.archivedAt !== undefined) return { state: "offline" };
    if (agent.pending) {
      const launch = this.deps.launcherQueue?.launchPresence(agent.id);
      return launch?.state === "launched" && at - launch.since >= ACTIVITY_STALL_MS
        ? { state: "stalled", hint: ACTIVITY_UNCLAIMED_HINT } : { state: "offline" };
    }
    if (!agent.online || at - agent.lastSeenAt >= PRESENCE_IDLE_MS) return { state: "offline" };
    if (entry.superseded) return { state: "superseded", hint: ACTIVITY_SUPERSEDED_HINT };
    if (entry.activeWaitToken !== null) return { state: "ready" };
    const lastProgress = Math.max(entry.lastProgressAt ?? -Infinity, entry.queueSince ?? -Infinity);
    if (entry.queued > 0 && at - lastProgress >= ACTIVITY_STALL_MS) return { state: "stalled", hint: ACTIVITY_STALL_HINT };
    if (entry.lastIdleWaitAt !== null && at - entry.lastIdleWaitAt <= ACTIVITY_WAIT_GRACE_MS &&
      (entry.lastWorkAt === null || entry.lastIdleWaitAt >= entry.lastWorkAt)) return { state: "ready" };
    if (entry.lastWorkAt !== null && at - entry.lastWorkAt <= ACTIVITY_ACTION_GRACE_MS) return { state: "working" };
    return { state: "offline" };
  }

  /** Current projection. `queued` may come from a snapshot to avoid rescanning the inbox. */
  forAgent(agent: Agent, queued = this.observation(agent.id).queued, at = Date.now()): AgentActivity {
    const entry = this.observation(agent.id);
    const count = Number.isFinite(queued) ? Math.max(0, queued) : 0;
    if (count > 0 && entry.queued === 0) entry.queueSince = at;
    if (count === 0) entry.queueSince = null;
    entry.queued = count;
    const next = this.classify(agent, entry, at);
    if (entry.current?.state !== next.state || entry.current?.hint !== next.hint) {
      entry.current = { ...next, since: at };
    }
    return entry.current!;
  }

  private refresh(id: string, at: number, queued?: number): void {
    const agent = this.deps.identity.getAgent(id);
    if (agent.role !== "brain" && agent.role !== "worker") return;
    const before = this.observation(id).current;
    const after = this.forAgent(agent, queued ?? this.observation(id).queued, at);
    if (before?.state !== after.state || before?.hint !== after.hint) this.deps.bus.emit("agent", agent);
  }

  /** Invoked by the server's existing maintenance sweep; no timer is retained in fixtures. */
  sweep(at = Date.now()): void {
    const agents = this.deps.identity.listAgents();
    const active = new Set(agents.map(agent => agent.id));
    for (const agent of agents) {
      const queued = agent.role === "brain" || agent.role === "worker" ? this.deps.delivery.queuedCount(agent.id) : 0;
      this.refresh(agent.id, at, queued);
    }
    for (const id of this.observations.keys()) if (!active.has(id)) this.observations.delete(id);
  }
}
