import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';

const newer = (old: AdaptiveExecutionState, next: AdaptiveExecutionState) => next.updatedAt > old.updatedAt ||
  (next.updatedAt === old.updatedAt && (next.revision ?? 0) >= (old.revision ?? 0));

/** The request shown first: the most recently updated open one, else the latest one. */
export function primaryExecution(executions: AdaptiveExecutionState[]): AdaptiveExecutionState | null {
  return [...executions].sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.updatedAt - a.updatedAt)[0] ?? null;
}

/**
 * Merge delayed HTTP with realtime without crossing channel boundaries. Each brain has one request per channel
 * (#211): a newer request replaces the older one, and a stale snapshot never brings an older one back.
 */
export function mergeRoutingView(current: AdaptiveRoutingView | null, incoming: AdaptiveRoutingView, channelId: string): AdaptiveRoutingView {
  const byBrain = new Map<string, AdaptiveExecutionState>();
  const all = (view: AdaptiveRoutingView | null) => view ? [...(view.executions ?? []), ...(view.state ? [view.state] : [])] : [];
  for (const item of [...all(current), ...all(incoming)]) {
    if (item.channelId !== channelId) continue;
    const existing = byBrain.get(item.brainId);
    if (!existing || newer(existing, item)) byBrain.set(item.brainId, item);
  }
  const byEvent = new Map<string, AdaptiveRoutingEvent>();
  for (const item of [...(current?.events ?? []), ...incoming.events]) {
    if (item.channelId === channelId) byEvent.set(item.id, item);
  }
  const events = [...byEvent.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100);
  const executions = [...byBrain.values()];
  const collector = incoming.collector ?? current?.collector;
  return { state: primaryExecution(executions), executions, events, ...(collector ? { collector } : {}) };
}

/** What the advice strip above the composer shows for a channel: the primary request and how many brains have one. */
export function adviceStrip(view: AdaptiveRoutingView | null, channelId: string | undefined) {
  const executions = (view?.executions ?? (view?.state ? [view.state] : [])).filter(item => item.channelId === channelId);
  return { state: primaryExecution(executions), brains: executions.filter(item => !item.completedAt).length };
}
