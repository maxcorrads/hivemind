import { retainNewest } from "../src/shared/realtime.ts";
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

/** Automatic live growth is bounded; explicit history navigation can load older pages. */
export function boundLivePane(pane: ChannelPayload): ChannelPayload {
  if (pane.historyThrough !== undefined) {
    const visible = pane.messages.filter((message) => message.seq <= pane.historyThrough!);
    if (visible.length === pane.messages.length) return pane;
    // Do not retain an unbounded hidden live buffer, or acknowledge unseen mail.
    // The user's next explicit refresh/page request recovers it from durable history.
    return { ...pane, messages: visible, deferredLive: true };
  }
  const retained = retainNewest(pane.messages);
  if (!retained.truncated) return pane;
  const roots = new Set(retained.items.map((message) => message.id));
  if (pane.threadId) roots.add(pane.threadId);
  return {
    ...pane, messages: retained.items, hasOlder: true,
    // Preserve the server's forward cursor: live messages may be beyond a gap.
    cursors: { ...pane.cursors, before: retained.items[0]!.seq },
    threads: pane.threads.filter((thread) => roots.has(thread.id)),
    replyCounts: Object.fromEntries(Object.entries(pane.replyCounts).filter(([id]) => roots.has(id))),
    replySeqs: Object.fromEntries(Object.entries(pane.replySeqs ?? {}).filter(([id]) => roots.has(id))),
  };
}
