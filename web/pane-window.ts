import { LIVE_MESSAGE_WINDOW, retainNewest } from "../src/shared/realtime.ts";
import type { ChannelPayload } from "./api.ts";

/** Freeze the displayed window; new live rows stay recoverable on the server. */
export function holdLivePane(pane: ChannelPayload): ChannelPayload {
  if (pane.historyThrough !== undefined) return pane;
  return { ...pane, historyThrough: pane.messages.reduce((seq, message) => Math.max(seq, message.seq), 0) };
}

/** Read the actual viewport/selection, not a delayed React scroll state. */
export function isReadingHistory(stream: HTMLElement | null): boolean {
  if (!stream) return false;
  const selection = stream.ownerDocument.getSelection();
  return stream.scrollHeight - stream.clientHeight - stream.scrollTop > 48 ||
    Boolean(selection && !selection.isCollapsed &&
      (stream.contains(selection.anchorNode) || stream.contains(selection.focusNode)));
}

/** A held pane keeps at most this many rows while the Human pages back through history. */
export const HELD_MESSAGE_WINDOW = 4 * LIVE_MESSAGE_WINDOW;

/** Automatic live growth is bounded; explicit history navigation can load older pages. */
export function boundLivePane(pane: ChannelPayload): ChannelPayload {
  if (pane.historyThrough !== undefined) {
    const visible = pane.messages.filter((message) => message.seq <= pane.historyThrough!);
    if (visible.length > HELD_MESSAGE_WINDOW) {
      // Paging back keeps the oldest rows being read and drops the newest ones;
      // returning to live reloads them from durable history.
      const kept = visible.slice(0, HELD_MESSAGE_WINDOW);
      return { ...retainMetadata(pane, kept), historyThrough: kept.at(-1)!.seq, deferredLive: true };
    }
    if (visible.length === pane.messages.length) return pane;
    // Do not retain an unbounded hidden live buffer, or acknowledge unseen mail.
    // The user's next explicit refresh/page request recovers it from durable history.
    return { ...pane, messages: visible, deferredLive: true };
  }
  const retained = retainNewest(pane.messages);
  if (!retained.truncated) return pane;
  return {
    ...retainMetadata(pane, retained.items), hasOlder: true,
    // Preserve the server's forward cursor: live messages may be beyond a gap.
    cursors: { ...pane.cursors, before: retained.items[0]!.seq },
  };
}

/** Thread status and reply counts only for the rows still in the pane. */
function retainMetadata(pane: ChannelPayload, messages: ChannelPayload["messages"]): ChannelPayload {
  const roots = new Set(messages.map((message) => message.id));
  if (pane.threadId) roots.add(pane.threadId);
  return {
    ...pane, messages,
    threads: pane.threads.filter((thread) => roots.has(thread.id)),
    replyCounts: Object.fromEntries(Object.entries(pane.replyCounts).filter(([id]) => roots.has(id))),
    replySeqs: Object.fromEntries(Object.entries(pane.replySeqs ?? {}).filter(([id]) => roots.has(id))),
  };
}
