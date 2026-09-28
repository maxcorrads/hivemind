import { useCallback, useRef, useState } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { api, type ChannelPayload, type UnreadTarget } from "./api.ts";
import { upsertById } from "./labels.ts";
import { hasSelectionInStream, holdLivePane, isReadingHistory } from "./pane-window.ts";
import type { Selection } from "./use-selection.ts";
import { hashFor } from "./selection.ts";
import { selectThread, beginThreadLoad, cancelThreadLoad, failThreadLoad, receiveThreadConfirmation, receiveThreadMessage, receiveThreadSnapshot, threadRedirect, type ThreadView } from './thread-state.ts';

/** The open side thread: its pane, the fenced loads that fill it and the paging actions of the thread aside. */
export function useThreadPane({ sel, threadId, selRef, threadIdRef, viewingThread, unreadLookup }: Selection, setErr: (error: string) => void) {
  const [threadView, updateThreadView] = useState<ThreadView | null>(null);
  const threadPane = sel.kind === 'channel' && threadView?.channelId === sel.id && threadView.threadId === threadId ? threadView.pane : null;
  const readingThread = useRef("");
  const userReading = useRef(false);
  const scrollIntent = useRef<{ top: number; at: number } | null>(null);
  const returningFromScroll = useRef(false);
  const scrollReturnVersion = useRef(0);
  const setThreadView: typeof updateThreadView = useCallback((update) => {
    if (update === null) {
      // Selection closes via setThreadView directly. Reset synchronously so a
      // same-root reopen in the next event cannot inherit the old scroll mode.
      readingThread.current = "";
      userReading.current = false;
      scrollIntent.current = null;
      returningFromScroll.current = false;
      scrollReturnVersion.current++;
    }
    updateThreadView(update);
  }, []);
  const setThreadPane = useCallback((update: ChannelPayload | null | ((pane: ChannelPayload | null) => ChannelPayload | null)) => {
    if (update === null) { setThreadView(null); return; }
    setThreadView(view => {
      const next = typeof update === "function" ? update(view?.pane ?? null) : update;
      if (!next) return null;
      if (!view) return null;
      return { ...view, pane: next };
    });
  }, [setThreadView]);
  const threadStream = useRef<HTMLDivElement>(null);
  const threadLoad = useRef(createRequestGate());
  const threadJumpIntent = useRef<UnreadTarget | null>(null);
  const threadLoadIdRef = useRef(0);

  const trackThread = (channelId: string, root: string) => {
    const key = `${channelId}\u0000${root}`;
    if (readingThread.current === key) return;
    readingThread.current = key;
    userReading.current = false;
    scrollIntent.current = null;
    returningFromScroll.current = false;
    scrollReturnVersion.current++;
  };

  const loadThread = useCallback(async (channelId: string, root: string, confirmed?: Message, returnToLive = !!confirmed, target?: UnreadTarget) => {
    if (!viewingThread(channelId, root)) return;
    // Any later navigation owns the request gate; the automatic return no
    // longer has authority to cancel it on a subsequent upward gesture.
    if (returningFromScroll.current) {
      returningFromScroll.current = false;
      scrollReturnVersion.current++;
    }
    trackThread(channelId, root);
    if (returnToLive) userReading.current = false;
    if (target) threadJumpIntent.current = target;
    else if (returnToLive || confirmed) {
      unreadLookup.current.cancel();
      threadJumpIntent.current = null;
    }
    const pending = threadJumpIntent.current;
    const jump = pending?.channelId === channelId && pending.threadId === root ? pending : null;
    const requestId = ++threadLoadIdRef.current;
    const load = threadLoad.current.begin();
    setThreadView(view => beginThreadLoad(view, channelId, root, requestId, returnToLive || !!jump, confirmed ? [confirmed] : [], jump ?? undefined));
    try {
      // The server's unbounded thread default starts at the oldest replies. A
      // normal open, reconnect or return-to-live must request the newest page.
      const data = await api.messages(channelId, root, jump ? jump.seq + 1 : Number.MAX_SAFE_INTEGER, load.signal);
      if (load.valid() && viewingThread(channelId, root)) {
        if (jump && !data.messages.some(m => m.seq === jump.seq))
          throw new Error("The unread reply is no longer available. Refresh and try again.");
        setThreadView(view => {
          const next = receiveThreadSnapshot(view, root, data, requestId, jump?.seq);
          return jump && next?.pane ? { ...next, pane: { ...next.pane, unreadTarget: jump } } : next;
        });
        if (threadJumpIntent.current === jump) threadJumpIntent.current = null;
        return true;
      }
    } catch (error) {
      if (load.valid() && viewingThread(channelId, root) && requestId === threadLoadIdRef.current) {
        setThreadView(view => failThreadLoad(view, requestId));
        // A link that pairs a thread with the wrong channel moves to the owning channel; the hash listener follows.
        const redirect = threadRedirect(error, channelId);
        if (redirect) { location.replace(`#${hashFor(redirect)}`); return; }
        setErr("Thread could not refresh. Refresh thread to retry.");
        throw error;
      }
    }
  }, [viewingThread]);

  const cancelUnreadJump = useCallback((target: UnreadTarget) => {
    if (threadJumpIntent.current !== target) return;
    threadJumpIntent.current = null;
    threadLoad.current.cancel();
    setThreadView(view => cancelThreadLoad(view, target));
  }, []);

  const onThreadMessage = useCallback((message: Message, confirmation = false) => {
    const root = threadIdRef.current;
    if (root && viewingThread(message.channelId, root)) {
      trackThread(message.channelId, root);
      setThreadView(view => {
        const current = selectThread(view, message.channelId, root);
        const held = current.pane && (userReading.current || hasSelectionInStream(threadStream.current))
          ? { ...current, pane: holdLivePane(current.pane) } : current;
        return confirmation ? receiveThreadConfirmation(held, message) : receiveThreadMessage(held, message);
      });
    }
  }, [viewingThread]);

  const returnFromScroll = (channelId: string, root: string) => {
    if (returningFromScroll.current || !viewingThread(channelId, root)) return;
    const refresh = loadThread(channelId, root, undefined, true);
    returningFromScroll.current = true;
    const version = ++scrollReturnVersion.current;
    userReading.current = false;
    void refresh.catch((error) => {
      if (error?.name !== "AbortError") setErr(String(error));
    }).finally(() => {
      if (scrollReturnVersion.current === version) returningFromScroll.current = false;
    });
  };

  const cancelScrollReturn = () => {
    if (!returningFromScroll.current) return;
    scrollReturnVersion.current++;
    returningFromScroll.current = false;
    userReading.current = true;
    threadLoad.current.cancel();
    setThreadView(cancelThreadLoad);
  };

  /** Scroll events alone can be caused by reflow or our own bottom correction. */
  const onThreadScrollIntent = (direction = 0) => {
    const stream = threadStream.current;
    if (!stream || !threadPane || !threadId || sel.kind !== "channel") return;
    trackThread(sel.id, threadId);
    scrollIntent.current = { top: stream.scrollTop, at: performance.now() };
    if (direction < 0 && threadPane.historyThrough === undefined && stream.scrollHeight > stream.clientHeight + 48) {
      // Wheel/keyboard input may be delivered after the browser moved the
      // viewport, so comparing scrollTop in the following scroll event can
      // miss a real upward gesture. Its direction is already explicit here.
      userReading.current = true;
      setThreadPane(current => current?.channel.id === sel.id && current.threadId === threadId && userReading.current
        ? holdLivePane(current) : current);
    }
    if (direction < 0 && threadPane.historyThrough !== undefined) cancelScrollReturn();
    // A held pane can already be at the bottom, so a downward wheel need not fire scroll.
    if (direction > 0 && threadPane.historyThrough !== undefined && !isReadingHistory(stream))
      returnFromScroll(sel.id, threadId);
  };

  const onThreadScroll = () => {
    const stream = threadStream.current;
    if (!stream || !threadPane || !threadId || sel.kind !== "channel") return;
    trackThread(sel.id, threadId);
    const intent = scrollIntent.current;
    if (!intent || performance.now() - intent.at > 1_500) return;
    if (threadPane.historyThrough !== undefined) {
      if (!isReadingHistory(stream)) returnFromScroll(sel.id, threadId);
      else if (returningFromScroll.current && stream.scrollTop < intent.top - 1) {
        // The reader moved back into history before the latest-page GET settled.
        cancelScrollReturn();
      }
    } else if (stream.scrollTop < intent.top - 1 && isReadingHistory(stream)) {
      userReading.current = true;
      scrollIntent.current = { ...intent, top: stream.scrollTop };
      setThreadPane(current => current?.channel.id === sel.id && current.threadId === threadId && userReading.current
        ? holdLivePane(current) : current);
    }
  };

  const setStatus = (channelId: string, root: string, status: ThreadStatus) => {
    api.setStatus(root, status).then(({ thread }) => {
      if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || threadIdRef.current !== root) return;
      setThreadPane((current) => current?.threadId === root ? { ...current, threads: upsertById(current.threads, thread) } : current);
    }).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
  };

  const refreshThread = (channelId: string, root: string) => {
    loadThread(channelId, root, undefined, true).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
  };

  const loadEarlier = (pane: ChannelPayload, channelId: string, root: string) => {
    const before = pane.messages[0]?.seq;
    if (!before) return;
    userReading.current = true;
    scrollIntent.current = null;
    scrollReturnVersion.current++;
    returningFromScroll.current = false;
    unreadLookup.current.cancel();
    threadJumpIntent.current = null;
    setThreadView(cancelThreadLoad);
    setThreadPane((current) => current ? holdLivePane(current) : current);
    const load = threadLoad.current.begin();
    api.messages(channelId, root, before, load.signal).then((page) => {
      if (!load.valid() || !viewingThread(channelId, root)) return;
      setThreadPane((current) => current?.channel.id === channelId && current.threadId === root ? {
        ...current, unreadTarget: undefined, hasOlder: page.hasOlder,
        cursors: { ...current.cursors, before: page.cursors?.before },
        messages: [...page.messages, ...current.messages.filter((message) => !page.messages.some((old) => old.id === message.id))]
          .sort((a, b) => a.seq - b.seq),
      } : current);
    }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); });
  };

  const loadNewer = (pane: ChannelPayload, channelId: string, root: string) => {
    const after = pane.cursors?.after ?? pane.messages.at(-1)?.seq;
    if (!after) return;
    userReading.current = true;
    scrollIntent.current = null;
    scrollReturnVersion.current++;
    returningFromScroll.current = false;
    unreadLookup.current.cancel();
    threadJumpIntent.current = null;
    setThreadView(cancelThreadLoad);
    const load = threadLoad.current.begin();
    api.messages(channelId, root, undefined, load.signal, after).then((page) => {
      if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== channelId || threadIdRef.current !== root) return;
      setThreadPane((current) => current?.channel.id === channelId && current.threadId === root ? {
        ...current, unreadTarget: undefined, hasNewer: page.hasNewer, cursors: page.cursors,
        historyThrough: Math.max(current.historyThrough ?? 0, ...current.messages.map((message) => message.seq), ...page.messages.map((message) => message.seq)),
        deferredLive: page.hasNewer ? current.deferredLive : false,
        messages: [...current.messages, ...page.messages.filter((m) => !current.messages.some((x) => x.id === m.id))]
          .sort((a, b) => a.seq - b.seq),
      } : current);
    }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); });
  };

  return {
    threadView, setThreadView, threadPane, setThreadPane, threadStream, threadLoad, threadJumpIntent, loadThread, onThreadMessage,
    setStatus, refreshThread, loadEarlier, loadNewer, cancelUnreadJump, onThreadScrollIntent, onThreadScroll,
  };
}

export type ThreadPane = ReturnType<typeof useThreadPane>;
