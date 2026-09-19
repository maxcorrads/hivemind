import { retainNewest } from "../src/shared/realtime.ts";
import type { ChannelPayload } from "./api.ts";

/** Automatic live growth is bounded; explicit history navigation can load older pages. */
export function boundLivePane(pane: ChannelPayload): ChannelPayload {
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
  };
}
