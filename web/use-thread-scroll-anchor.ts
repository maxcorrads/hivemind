import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ChannelPayload } from "./api.ts";
import { isReadingHistory } from "./pane-window.ts";

/** Where the clicked reply link sat when the Human opened a thread (see `useThreadScrollAnchor`). */
export type ThreadOpenAnchor = {
  channelId: string; threadId: string; button: HTMLElement; bottom: number; atBottom: boolean;
};

/**
 * Keeps the channel stream pinned to the live bottom, or to the clicked reply
 * link while a side thread opens and late reflow settles, and keeps the
 * thread stream at its bottom when it is live.
 */
export function useThreadScrollAnchor({ channelStream, threadStream, pane, threadPane, selectedChannelId, threadId }: {
  channelStream: RefObject<HTMLDivElement | null>;
  threadStream: RefObject<HTMLDivElement | null>;
  pane: ChannelPayload | null;
  threadPane: ChannelPayload | null;
  selectedChannelId: string | null;
  threadId: string | null;
}) {
  const stickBottom = useRef(true);
  const threadOpenAnchor = useRef<ThreadOpenAnchor | null>(null);
  const threadAnchorHold = useRef<{ channelId: string; threadId: string; release: () => void } | null>(null);
  const bottomHold = useRef<(() => void) | null>(null);

  // Reflow happens before scroll events: keep a live pane pinned when the side
  // thread opens, even when the bounded message window keeps the same length.
  const threadVisible = !!threadPane;
  useLayoutEffect(() => {
    const stream = channelStream.current;
    const anchor = threadOpenAnchor.current;
    const hold = threadAnchorHold.current;
    if (hold && (hold.channelId !== selectedChannelId || hold.threadId !== threadId)) hold.release();
    bottomHold.current?.();
    bottomHold.current = null;
    if (anchor && (anchor.channelId !== selectedChannelId || anchor.threadId !== threadId)) threadOpenAnchor.current = null;
    if (stream && anchor && anchor.channelId === selectedChannelId && anchor.threadId === threadPane?.threadId) {
      // A held snapshot can still be scrolled to its bottom. Otherwise keep the
      // clicked reply link at the same height after the message wraps.
      const correct = () => {
        if (anchor.atBottom) stream.scrollTop = stream.scrollHeight;
        else if (anchor.button.isConnected) stream.scrollTop += anchor.button.getBoundingClientRect().bottom - anchor.bottom;
      };
      correct();
      threadOpenAnchor.current = null;
      threadAnchorHold.current?.release();
      const release = holdScroll(stream, correct, () => {
        if (threadAnchorHold.current?.release === release) threadAnchorHold.current = null;
      });
      threadAnchorHold.current = { channelId: anchor.channelId, threadId: anchor.threadId, release };
    } else if (stickBottom.current && pane?.historyThrough === undefined && stream) {
      stream.scrollTop = stream.scrollHeight;
      // The same late reflow can leave a live pane a few pixels above its newest message (overflow anchoring
      // keeps a row near the top in place, not the bottom). An unread jump positions the stream itself.
      if (!pane?.unreadTarget) bottomHold.current = holdScroll(stream, () => {
        if (!isReadingHistory(stream)) stream.scrollTop = stream.scrollHeight;
      });
    }
    stickBottom.current = true;
  }, [pane, threadVisible, selectedChannelId, threadId, threadPane?.threadId]);
  useEffect(() => () => { threadAnchorHold.current?.release(); bottomHold.current?.(); }, []);
  useLayoutEffect(() => {
    if (threadPane?.historyThrough === undefined && threadStream.current)
      threadStream.current.scrollTop = threadStream.current.scrollHeight;
  }, [threadPane]);

  return { stickBottom, threadOpenAnchor };
}

/**
 * Late reflow (a web font swapping in, an image decoding) re-wraps the messages after a scroll position was set:
 * re-applies `correct` whenever the stream or a row resizes or fonts finish loading, until the layout settles
 * (2 s) or the user scrolls on their own. Returns the release; `released` runs once it is over.
 */
function holdScroll(stream: HTMLElement, correct: () => void, released?: () => void): () => void {
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(correct);
  resize?.observe(stream);
  for (const child of Array.from(stream.children)) resize?.observe(child);
  const fonts = document.fonts as FontFaceSet | undefined;
  const userScroll = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    resize?.disconnect();
    fonts?.removeEventListener?.("loadingdone", correct);
    for (const type of userScroll) stream.removeEventListener(type, release);
    released?.();
  };
  const timer = window.setTimeout(release, 2_000);
  fonts?.addEventListener?.("loadingdone", correct);
  for (const type of userScroll) stream.addEventListener(type, release, { passive: true });
  return release;
}
