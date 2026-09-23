import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import type { Message } from '../src/shared/types.ts';

const newer = (old: AdaptiveExecutionState, next: AdaptiveExecutionState) => next.updatedAt > old.updatedAt ||
  (next.updatedAt === old.updatedAt && (next.revision ?? 0) >= (old.revision ?? 0));
/** A brain's current execution; one replaced by a newer Human request is `current: false` while it drains. */
export const isCurrentExecution = (item: AdaptiveExecutionState) => item.current !== false;
/** Replaced executions still finishing their delegated work, oldest first. */
export function drainingExecutions(executions: AdaptiveExecutionState[]): AdaptiveExecutionState[] {
  return executions.filter(item => !isCurrentExecution(item) && !item.completedAt).sort((a, b) => a.updatedAt - b.updatedAt);
}
/** The execution shown first: the most recently updated current one still running, else the latest current one. */
export function primaryExecution(executions: AdaptiveExecutionState[]): AdaptiveExecutionState | null {
  return executions.filter(isCurrentExecution)
    .sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Server reasons that complete an execution; a replaced one is never reopened afterwards. */
const DRAINED_REASONS = new Set(['delegated_work_drained', 'execution_completed']);
/**
 * Merge delayed HTTP with realtime without crossing channel or execution boundaries. Executions are keyed by
 * executionId: each brain keeps its newest current execution (a newer request replaces an older current one),
 * and draining ones stay beside it without ever becoming current again.
 */
export function mergeRoutingView(current: AdaptiveRoutingView | null, incoming: AdaptiveRoutingView, channelId: string): AdaptiveRoutingView {
  const byId = new Map<string, AdaptiveExecutionState>();
  const all = (view: AdaptiveRoutingView | null) => view ? [...(view.executions ?? []), ...(view.state ? [view.state] : [])] : [];
  for (const item of [...all(current), ...all(incoming)]) {
    if (item.channelId !== channelId) continue;
    const existing = byId.get(item.executionId);
    const pick = !existing || newer(existing, item) ? item : existing;
    // Replacement is one-way: a stale snapshot never turns a draining execution current again.
    byId.set(item.executionId, existing && isCurrentExecution(pick) && !(isCurrentExecution(existing) && isCurrentExecution(item))
      ? { ...pick, current: false } : pick);
  }
  const latestCurrent = new Map<string, AdaptiveExecutionState>();
  for (const item of byId.values()) {
    if (!isCurrentExecution(item)) continue;
    const existing = latestCurrent.get(item.brainId);
    if (!existing || newer(existing, item)) latestCurrent.set(item.brainId, item);
  }
  const byEvent = new Map<string, AdaptiveRoutingEvent>();
  for (const item of [...(current?.events ?? []), ...incoming.events]) {
    if (item.channelId === channelId) byEvent.set(item.id, item);
  }
  const events = [...byEvent.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100);
  // A replaced execution leaves once the server reports it completed; its completion event keeps a delayed
  // snapshot (updated before that event) from bringing it back as still finishing.
  const drainedAt = new Map<string, number>();
  for (const item of events) if (item.kind === 'status' && DRAINED_REASONS.has(item.reason))
    drainedAt.set(item.executionId, Math.max(drainedAt.get(item.executionId) ?? 0, item.createdAt));
  const executions = [...byId.values()].filter(item => isCurrentExecution(item)
    ? latestCurrent.get(item.brainId) === item
    : !item.completedAt && !((drainedAt.get(item.executionId) ?? -Infinity) >= item.updatedAt));
  return { state: primaryExecution(executions), executions, events };
}

/** Routing strip counts for a channel: running brains (current executions) and older requests still finishing. */
export function routingStripCounts(view: AdaptiveRoutingView | null, channelId: string | undefined) {
  const executions = (view?.executions ?? []).filter(item => item.channelId === channelId);
  return { brains: executions.filter(item => isCurrentExecution(item) && !item.completedAt).length,
    finishing: drainingExecutions(executions).length };
}

/** Only applied changes are mixed into the Human rendering, never agent messages. */
export function routingStreamEntries(messages: Message[], events: AdaptiveRoutingEvent[], channelId: string) {
  const first = messages[0]?.createdAt ?? 0;
  const entries: Array<{ kind: 'message'; message: Message; at: number } | { kind: 'routing'; event: AdaptiveRoutingEvent; at: number }> =
    messages.map(message => ({ kind: 'message', message, at: message.createdAt }));
  for (const event of events) if (event.channelId === channelId && event.createdAt >= first &&
    (event.kind === 'transition' || (event.kind === 'lock' && event.applied))) entries.push({ kind: 'routing', event, at: event.createdAt });
  return entries.sort((a, b) => a.at - b.at);
}
