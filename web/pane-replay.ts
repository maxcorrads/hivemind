import type { Message, Thread } from "../src/shared/types.ts";
import type { ChannelPayload } from "./api.ts";
import { boundLivePane } from "./pane-window.ts";

export type PaneEvent = { type: "message" | "reaction"; message: Message } | { type: "thread"; thread: Thread };
export const PANE_REPLAY_LIMIT = 2048;

type Ticket = { channelId: string; threadId: string | null; events: PaneEvent[]; overflow: boolean };

/** Scoped, request-lifetime journal. Overflow rejects the snapshot, never silently replays a partial log. */
export function createPaneReplay(limit = PANE_REPLAY_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid pane replay limit");
  let active: Ticket | undefined;
  return {
    begin(channelId: string, threadId: string | null) {
      active = { channelId, threadId, events: [], overflow: false };
      return active;
    },
    record(event: PaneEvent) {
      if (!active || active.overflow) return;
      const channelId = event.type === "thread" ? event.thread.channelId : event.message.channelId;
      if (channelId !== active.channelId) return;
      if (active.threadId !== null && (event.type === "thread" ? event.thread.id !== active.threadId :
        event.message.id !== active.threadId && event.message.threadId !== active.threadId)) return;
      if (active.events.length === limit) { active.events = []; active.overflow = true; return; }
      active.events.push(event);
    },
    finish(ticket: Ticket, data: ChannelPayload): ChannelPayload | null {
      if (active !== ticket) return null;
      active = undefined;
      if (ticket.overflow || data.channel.id !== ticket.channelId || data.threadId !== ticket.threadId) return null;
      return replayPane(data, ticket.events);
    },
    cancel() { active = undefined; },
  };
}

/** Snapshot message high-water prevents double-counting a reply already included by HTTP. */
export function replayPane(data: ChannelPayload, events: PaneEvent[]): ChannelPayload {
  let pane = data;
  const replies = new Set<string>();
  for (const event of events) {
    if (event.type === "thread") {
      if (event.thread.channelId !== pane.channel.id) continue;
      if (pane.threadId !== event.thread.id && !pane.messages.some(m => m.id === event.thread.id)) continue;
      pane = { ...pane, threads: [...pane.threads.filter(t => t.id !== event.thread.id), event.thread] };
      continue;
    }
    const message = event.message;
    if (message.channelId !== pane.channel.id) continue;
    if (event.type === "reaction") {
      pane = { ...pane, messages: pane.messages.map(m => m.id === message.id ? message : m) };
      continue;
    }
    if (pane.threadId === null && message.threadId) {
      if (message.seq <= (pane.snapshotSeq ?? 0) || replies.has(message.id)) continue;
      replies.add(message.id);
      if (pane.messages.some(m => m.id === message.threadId)) pane = { ...pane,
        replyCounts: { ...pane.replyCounts, [message.threadId]: (pane.replyCounts[message.threadId] ?? 0) + 1 } };
      continue;
    }
    if (pane.threadId !== null && message.id !== pane.threadId && message.threadId !== pane.threadId) continue;
    if (!pane.messages.some(m => m.id === message.id)) {
      pane = boundLivePane({ ...pane, messages: [...pane.messages, message].sort((a, b) => a.seq - b.seq) });
    }
  }
  return pane;
}
