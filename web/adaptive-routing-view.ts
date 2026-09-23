import type { AdaptiveExecutionState, AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import type { Message } from '../src/shared/types.ts';

const newer = (old: AdaptiveExecutionState, next: AdaptiveExecutionState) => next.updatedAt > old.updatedAt ||
  (next.updatedAt === old.updatedAt && (next.revision ?? 0) >= (old.revision ?? 0));
/** The execution shown first: the most recently updated one still running, else the latest. */
export function primaryExecution(executions: AdaptiveExecutionState[]): AdaptiveExecutionState | null {
  return [...executions].sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Merge delayed HTTP with realtime without crossing channel or execution boundaries (one execution per brain). */
export function mergeRoutingView(current: AdaptiveRoutingView | null, incoming: AdaptiveRoutingView, channelId: string): AdaptiveRoutingView {
  const byBrain = new Map<string, AdaptiveExecutionState>();
  const all = (view: AdaptiveRoutingView | null) => view ? [...(view.executions ?? []), ...(view.state ? [view.state] : [])] : [];
  for (const item of [...all(current), ...all(incoming)]) {
    if (item.channelId !== channelId) continue;
    const existing = byBrain.get(item.brainId);
    if (!existing || newer(existing, item)) byBrain.set(item.brainId, item);
  }
  const executions = [...byBrain.values()];
  const state = primaryExecution(executions);
  const events = new Map<string, AdaptiveRoutingEvent>();
  for (const item of [...(current?.events ?? []), ...incoming.events]) {
    if (item.channelId === channelId) events.set(item.id, item);
  }
  return { state, executions, events: [...events.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100) };
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
