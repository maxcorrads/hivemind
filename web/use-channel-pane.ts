import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import type { Message } from "../src/shared/types.ts";
import { api, type ChannelPayload, type UnreadTarget } from "./api.ts";
import { beginChannelJournal, reconcileChannelSnapshot, type ChannelJournal } from "./channel-state.ts";
import { mergeConfirmations } from "./message-confirmations.ts";
import type { Sel } from "./selection.ts";

/** The selected channel's message pane and the journaled GET that reconciles it with live traffic. */
export function useChannelPane(selRef: MutableRefObject<Sel>, unreadLookup: MutableRefObject<ReturnType<typeof createRequestGate>>) {
  const [pane, setPane] = useState<ChannelPayload | null>(null);
  const channelStream = useRef<HTMLDivElement>(null);
  const channelLoad = useRef(createRequestGate());
  const channelJumpIntent = useRef<UnreadTarget | null>(null);
  const channelJournal = useRef<ChannelJournal | null>(null);
  const channelRefreshIntent = useRef<{ channelId: string; confirmations: Message[] } | null>(null);

  const loadChannel = useCallback(async (id: string, before?: number, confirmed?: Message[], target?: UnreadTarget) => {
    // Automatic refreshes inherit a pending jump. Explicit paging/return-to-live
    // replaces it; reconnect cancellation only cancels the individual request.
    if (target) channelJumpIntent.current = target;
    else if (before !== undefined || confirmed) {
      unreadLookup.current.cancel();
      channelJumpIntent.current = null;
    }
    const jump = channelJumpIntent.current?.channelId === id ? channelJumpIntent.current : null;
    if (jump) before = jump.seq + 1;
    // A replacement/reconnect GET must not silently cancel the Human's pending
    // return-to-live. Explicit older-page navigation and selection changes can.
    if (before !== undefined) channelRefreshIntent.current = null;
    else if (confirmed) {
      const previous = channelRefreshIntent.current;
      channelRefreshIntent.current = { channelId: id, confirmations: mergeConfirmations(
        previous?.channelId === id ? previous.confirmations : [], confirmed,
      ) };
    }
    const intent = channelRefreshIntent.current?.channelId === id ? channelRefreshIntent.current : null;
    const load = channelLoad.current.begin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const journal = beginChannelJournal(id, intent?.confirmations);
      channelJournal.current = journal;
      try {
        const data = await api.messages(id, null, before, load.signal);
        if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== id) return;
        if (journal.overflow) {
          if (attempt < 2) continue;
          throw new Error("Live traffic overtook the channel refresh. Reload the page to retry.");
        }
        if (jump && !data.messages.some(m => m.seq === jump.seq))
          throw new Error("The unread message is no longer available. Refresh and try again.");
        setPane((current) => {
          if (!jump) return reconcileChannelSnapshot(current, data, journal, before !== undefined, !!intent);
          const next = reconcileChannelSnapshot(null, data, journal, false, true, jump.seq);
          return next && { ...next, unreadTarget: jump };
        });
        if (channelJumpIntent.current === jump) channelJumpIntent.current = null;
        if (channelRefreshIntent.current === intent) channelRefreshIntent.current = null;
        return true;
      } catch (error) {
        if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== id) return;
        throw error;
      } finally {
        if (channelJournal.current === journal) channelJournal.current = null;
      }
    }
  }, []);

  return { pane, setPane, channelStream, channelLoad, channelJumpIntent, channelJournal, channelRefreshIntent, loadChannel };
}

export type ChannelPane = ReturnType<typeof useChannelPane>;
