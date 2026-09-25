import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createRequestGate, type createReceiptQueue } from "../src/shared/read-client.ts";
import type { Snapshot, UnreadTarget } from "./api.ts";
import type { ChannelJournal } from "./channel-state.ts";
import type { Message } from "../src/shared/types.ts";
import type { ThreadView } from "./thread-state.ts";
import { loadSelectedProject } from "./nav-model.ts";
import { parseHash, repairSel, setHash, type Sel } from "./selection.ts";

type Gate = MutableRefObject<ReturnType<typeof createRequestGate>>;
type Receipts = MutableRefObject<ReturnType<typeof createReceiptQueue> | null>;

/** The selected view and open thread, mirrored into refs so async work can check it is still current. */
export function useSelection() {
  const [sel, setSel] = useState<Sel>(parseHash);
  const [threadId, setThreadId] = useState<string | null>(() => {
    const start = parseHash();
    return start.kind === "channel" ? start.thread ?? null : null;
  });
  const selRef = useRef(sel);
  selRef.current = sel;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // The lookup precedes the pane load, so explicit navigation must be able to
  // cancel it even before the unread destination is known.
  const unreadLookup = useRef(createRequestGate());

  const viewingThread = useCallback((channelId: string, root: string) =>
    selRef.current.kind === 'channel' && selRef.current.id === channelId && threadIdRef.current === root, []);

  return { sel, setSel, threadId, setThreadId, selRef, threadIdRef, viewingThread, unreadLookup };
}

export type Selection = ReturnType<typeof useSelection>;

/**
 * Moving to another channel, thread or inbox box cancels the loads and read
 * receipts that belonged to the previous one before the new selection commits.
 */
export function useChangeSelection(
  { selRef, threadIdRef, setSel, setThreadId, unreadLookup }: Selection,
  { channelLoad, channelJumpIntent, channelJournal, channelRefreshIntent, channelReads, threadLoad, threadJumpIntent, setThreadView, threadReads, inboxLoad }: {
    channelLoad: Gate;
    channelJumpIntent: MutableRefObject<UnreadTarget | null>;
    channelJournal: MutableRefObject<ChannelJournal | null>;
    channelRefreshIntent: MutableRefObject<{ channelId: string; confirmations: Message[] } | null>;
    channelReads: Receipts;
    threadLoad: Gate;
    threadJumpIntent: MutableRefObject<UnreadTarget | null>;
    setThreadView: (view: ThreadView | null) => void;
    threadReads: Receipts;
    inboxLoad: Gate;
  },
) {
  const changeSelection = useCallback((next: Sel) => {
    unreadLookup.current.cancel();
    const previous = selRef.current;
    const priorChannel = previous.kind === "channel" ? previous.id : null;
    const nextChannel = next.kind === "channel" ? next.id : null;
    const nextThread = next.kind === "channel" ? next.thread ?? null : null;
    if (priorChannel !== nextChannel) {
      channelLoad.current.cancel();
      channelJournal.current = null;
      channelRefreshIntent.current = null;
      channelReads.current?.reset();
    }
    if (priorChannel !== nextChannel || threadIdRef.current !== nextThread) {
      if (channelJumpIntent.current) {
        channelLoad.current.cancel();
        channelJournal.current = null;
      }
      channelJumpIntent.current = null;
      threadJumpIntent.current = null;
      threadLoad.current.cancel();
      setThreadView(null);
      threadReads.current?.reset();
    }
    const previousKey = previous.kind === "inbox" ? `${previous.project}/${previous.box ?? "unread"}` : null;
    const nextKey = next.kind === "inbox" ? `${next.project}/${next.box ?? "unread"}` : null;
    if (previousKey !== nextKey) inboxLoad.current.cancel();
    selRef.current = next;
    threadIdRef.current = nextThread;
    setSel(next);
    setThreadId(nextThread);
  }, []);

  const go = useCallback((next: Sel) => {
    changeSelection(next);
    setHash(next);
  }, [changeSelection]);

  return { changeSelection, go };
}

/** Moves a selection that points at a deleted project or channel somewhere valid. */
export function useSelectionRepair(snap: Snapshot | null, sel: Sel, changeSelection: (next: Sel) => void) {
  useEffect(() => {
    if (!snap) return;
    const next = repairSel(sel, snap, loadSelectedProject());
    if (!next) return;
    changeSelection(next);
    setHash(next);
  }, [snap, sel, changeSelection]);
}
