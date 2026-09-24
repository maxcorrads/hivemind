import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { createReceiptQueue, createRequestGate } from "../src/shared/read-client.ts";
import type { Snapshot } from "./api.ts";
import type { ChannelJournal } from "./channel-state.ts";
import type { Message } from "../src/shared/types.ts";
import type { ThreadView } from "./thread-state.ts";
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

  const viewingThread = useCallback((channelId: string, root: string) =>
    selRef.current.kind === 'channel' && selRef.current.id === channelId && threadIdRef.current === root, []);

  return { sel, setSel, threadId, setThreadId, selRef, threadIdRef, viewingThread };
}

export type Selection = ReturnType<typeof useSelection>;

/**
 * Moving to another channel, thread or inbox box cancels the loads and read
 * receipts that belonged to the previous one before the new selection commits.
 */
export function useChangeSelection(
  { selRef, threadIdRef, setSel, setThreadId }: Selection,
  { channelLoad, channelJournal, channelRefreshIntent, channelReads, threadLoad, setThreadView, threadReads, inboxLoad }: {
    channelLoad: Gate;
    channelJournal: MutableRefObject<ChannelJournal | null>;
    channelRefreshIntent: MutableRefObject<{ channelId: string; confirmations: Message[] } | null>;
    channelReads: Receipts;
    threadLoad: Gate;
    setThreadView: (view: ThreadView | null) => void;
    threadReads: Receipts;
    inboxLoad: Gate;
  },
) {
  const changeSelection = useCallback((next: Sel) => {
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
    const next = repairSel(sel, snap);
    if (!next) return;
    changeSelection(next);
    setHash(next);
  }, [snap, sel, changeSelection]);
}
