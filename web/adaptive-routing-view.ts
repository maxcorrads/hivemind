import type { AdaptiveRoutingEvent, AdaptiveRoutingView } from '../src/shared/adaptive-topology.ts';
import type { Message } from '../src/shared/types.ts';

/** Merge delayed HTTP with realtime without crossing channel or execution boundaries. */
export function mergeRoutingView(current: AdaptiveRoutingView | null, incoming: AdaptiveRoutingView, channelId: string): AdaptiveRoutingView {
  const old = current?.state?.channelId === channelId ? current.state : null;
  const next = incoming.state?.channelId === channelId ? incoming.state : null;
  const state = !old ? next : !next ? old : next.updatedAt > old.updatedAt ||
    (next.updatedAt === old.updatedAt && (next.revision ?? 0) >= (old.revision ?? 0)) ? next : old;
  const events = new Map<string, AdaptiveRoutingEvent>();
  for (const item of [...(current?.events ?? []), ...incoming.events]) {
    if (item.channelId === channelId) events.set(item.id, item);
  }
  return { state, events: [...events.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100) };
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
