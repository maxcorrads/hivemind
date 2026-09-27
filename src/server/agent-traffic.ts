import type { AgentTrafficView } from "../shared/types.ts";

/**
 * JSON bytes the agent API returned to each brain/worker since this server started: what Hivemind feeds into agents'
 * context, before any MCP envelope. In memory only, so a restart starts over; the route patterns bound its size.
 */
export class AgentTraffic {
  private readonly byAgent = new Map<string, AgentTrafficView>();

  record(agentId: string, route: string, bytes: number, at = Date.now()): void {
    let view = this.byAgent.get(agentId);
    if (!view) {
      view = { since: at, bytes: 0, calls: 0, routes: {} };
      this.byAgent.set(agentId, view);
    }
    view.bytes += bytes;
    view.calls += 1;
    const entry = view.routes[route] ??= { bytes: 0, calls: 0 };
    entry.bytes += bytes;
    entry.calls += 1;
  }

  forget(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** A copy for the agents that still exist. */
  snapshot(agentIds: Iterable<string>): Record<string, AgentTrafficView> {
    const out: Record<string, AgentTrafficView> = {};
    for (const id of agentIds) {
      const view = this.byAgent.get(id);
      if (view) out[id] = { ...view, routes: structuredClone(view.routes) };
    }
    return out;
  }
}
