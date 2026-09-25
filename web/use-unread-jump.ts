import { useEffect, useLayoutEffect, useState } from 'react';
import { api, type UnreadTarget } from './api.ts';
import type { Sel } from './selection.ts';
import type { Selection } from './use-selection.ts';
import type { ChannelPane } from './use-channel-pane.ts';
import type { ThreadPane } from './use-thread-pane.ts';

/** Explicit badge navigation. Lookup is read-only; ordinary pane receipts remain unchanged. */
export function useUnreadJump({ selection, channel, thread, go, clearSearch, refreshSnap, setErr }: {
  selection: Selection; channel: ChannelPane; thread: ThreadPane;
  go: (next: Sel) => void; clearSearch: () => void;
  refreshSnap: () => Promise<unknown>; setErr: (error: string) => void;
}) {
  const lookup = selection.unreadLookup;
  const [target, setTarget] = useState<UnreadTarget | null>(null);
  // Observe the page actually committed, even if an automatic refresh replaced
  // the original request. Identity distinguishes repeated jumps to the same seq.
  const pane = target?.threadId ? thread.threadPane : channel.pane;
  const ready = target && pane?.unreadTarget === target ? target : null;
  const { sel, selRef, threadId, threadIdRef } = selection;
  const selected = sel.kind === 'channel' ? sel.id : null;
  const matches = (t: UnreadTarget) => selRef.current.kind === 'channel' && selRef.current.id === t.channelId && threadIdRef.current === t.threadId;

  const openUnread = async (channelId: string) => {
    const from = selRef.current, request = lookup.current.begin();
    setTarget(null);
    try {
      const { target: next } = await api.lastUnread(channelId, request.signal);
      if (!request.valid() || selRef.current !== from) return;
      if (!next) { setErr('No unread messages remain in this conversation.'); await refreshSnap(); return; }
      if (next.channelId !== channelId || !Number.isSafeInteger(next.seq) || next.seq < 1 || next.seq >= Number.MAX_SAFE_INTEGER)
        throw new Error('Invalid unread destination. Refresh and try again.');
      clearSearch();
      go({ kind: 'channel', id: channelId, thread: next.threadId });
      setTarget(next);
    } catch (error) {
      if (request.valid() && selRef.current === from && (error as Error).name !== 'AbortError') setErr(String(error));
    }
  };
  useEffect(() => () => lookup.current.cancel(), []);

  // Declared after the ordinary conversation-load hooks. Beginning the explicit
  // page load cancels their default GET through the same per-pane request gate.
  useEffect(() => {
    if (!target) return;
    if (!matches(target)) { setTarget(null); return; }
    let cancelled = false;
    const load = target.threadId
      ? thread.loadThread(target.channelId, target.threadId, undefined, true, target)
      : channel.loadChannel(target.channelId, undefined, undefined, target);
    void load.catch(error => { if (!cancelled && matches(target) && error?.name !== 'AbortError') setErr(String(error)); });
    return () => {
      cancelled = true;
      if (target.threadId) thread.cancelUnreadJump(target);
      else if (channel.channelJumpIntent.current === target) {
        channel.channelJumpIntent.current = null;
        channel.channelLoad.current.cancel();
      }
    };
  }, [target, selected, threadId, channel.loadChannel, thread.loadThread, thread.cancelUnreadJump]);

  // Ordinary live-bottom anchoring runs first. A held target page prevents later
  // messages from moving the Human away again, including targets in old threads.
  useLayoutEffect(() => {
    if (!ready || !matches(ready)) return;
    const stream = ready.threadId ? thread.threadStream.current : channel.channelStream.current;
    const element = stream?.querySelector<HTMLElement>(`[data-message-seq="${ready.seq}"]`);
    if (!stream || !element) return;
    let released = false;
    const scroll = () => {
      if (!released && element.isConnected)
        stream.scrollTop += element.getBoundingClientRect().top - stream.getBoundingClientRect().top - 24;
    };
    element.classList.add('unread-target'); element.tabIndex = -1;
    element.focus({ preventScroll: true }); scroll();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroll);
    for (const child of Array.from(stream.children)) resize?.observe(child);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    // Return-to-live/refresh and the composer are siblings of the stream.
    // Their mouse/keyboard actions must release the anchor BEFORE the new page.
    const interactionScope = stream.parentElement ?? stream;
    const release = () => {
      released = true; resize?.disconnect();
      for (const event of events) interactionScope.removeEventListener(event, release, true);
    };
    for (const event of events) interactionScope.addEventListener(event, release, { passive: true, capture: true });
    const timer = window.setTimeout(() => { release(); element.classList.remove('unread-target'); }, 2500);
    return () => { release(); window.clearTimeout(timer); element.classList.remove('unread-target'); };
  }, [ready, selected, threadId]);

  return { openUnread, target };
}
