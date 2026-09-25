import { useCallback, useRef, useState } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import type { Message, ThreadStatus } from "../src/shared/types.ts";
import { api, type ChannelPayload, type UnreadTarget } from "./api.ts";
import { upsertById } from "./labels.ts";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import type { Selection } from "./use-selection.ts";
import { hashFor } from "./selection.ts";
import { selectThread, beginThreadLoad, cancelThreadLoad, failThreadLoad, receiveThreadConfirmation, receiveThreadMessage, receiveThreadSnapshot, threadRedirect, type ThreadView } from './thread-state.ts';

/** The open side thread: its pane, the fenced loads that fill it and the paging actions of the thread aside. */
export function useThreadPane({ sel, threadId, selRef, threadIdRef, viewingThread, unreadLookup }: Selection, setErr: (error: string) => void) {
  const [threadView, setThreadView] = useState<ThreadView | null>(null);
  const threadPane = sel.kind === 'channel' && threadView?.channelId === sel.id && threadView.threadId === threadId ? threadView.pane : null;
  const setThreadPane = useCallback((update: ChannelPayload | null | ((pane: ChannelPayload | null) => ChannelPayload | null)) => {
    setThreadView(view => {
      const next = typeof update === "function" ? update(view?.pane ?? null) : update;
      if (!next) return null;
      if (!view) return null;
      return { ...view, pane: next };
    });
  }, []);
  const threadStream = useRef<HTMLDivElement>(null);
  const threadLoad = useRef(createRequestGate());
  const threadJumpIntent = useRef<UnreadTarget | null>(null);
  const threadLoadIdRef = useRef(0);

  const loadThread = useCallback(async (channelId: string, root: string, confirmed?: Message, returnToLive = !!confirmed, target?: UnreadTarget) => {
    if (!viewingThread(channelId, root)) return;
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
      const data = await api.messages(channelId, root, jump ? jump.seq + 1 : undefined, load.signal);
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
    if (root && viewingThread(message.channelId, root))
      setThreadView(view => {
        const current = selectThread(view, message.channelId, root);
        const held = current.pane && isReadingHistory(threadStream.current)
          ? { ...current, pane: holdLivePane(current.pane) } : current;
        return confirmation ? receiveThreadConfirmation(held, message) : receiveThreadMessage(held, message);
      });
  }, [viewingThread]);

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
    setStatus, refreshThread, loadEarlier, loadNewer, cancelUnreadJump,
  };
}

export type ThreadPane = ReturnType<typeof useThreadPane>;
