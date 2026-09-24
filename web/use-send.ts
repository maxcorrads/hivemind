import { useCallback, useRef } from "react";
import { api } from "./api.ts";
import { applyChannelMessage, recordChannelConfirmation } from "./channel-state.ts";
import { isReadingHistory } from "./pane-window.ts";
import type { Sel } from "./selection.ts";
import { createSendOperations } from "./send-operation.ts";
import type { ChannelPane } from "./use-channel-pane.ts";
import type { Selection } from "./use-selection.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

type SendDeps = {
  sel: Sel;
  selection: Pick<Selection, "selRef" | "threadIdRef">;
  channel: ChannelPane;
  thread: ThreadPane;
  activeBrainChannel: boolean;
  refreshRoutingView: () => void;
  setErr: (error: string) => void;
};

/**
 * The send that confirms into the panes. Drafts live in each Composer; a send
 * resolves true once the message is committed and false (with a visible error)
 * when it is not, so the Composer keeps the draft and files for a retry. The
 * returned functions are stable across renders.
 */
export function useSend(deps: SendDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  const sendOperations = useRef(createSendOperations(api.upload, api.send));

  const send = useCallback(async (body: string, tid: string | null, files: File[] = []): Promise<boolean> => {
    const { sel, selection: { selRef, threadIdRef }, channel, thread, activeBrainChannel, refreshRoutingView, setErr } = latest.current;
    if (sel.kind !== "channel") return false;
    const channelId = sel.id;
    const root = tid;
    if (!body.trim() && !files.length) return false;
    let result: Awaited<ReturnType<typeof api.send>>;
    try {
      result = await sendOperations.current(channelId, body.trim(), root, files);
    } catch (error) {
      // The operation keeps its idempotency key: retrying the same draft and
      // files cannot post the message twice.
      setErr(`Message not sent: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || (root && threadIdRef.current !== root)) return true;
    const { pane, setPane, channelStream, channelJournal, loadChannel } = channel;
    const { threadPane, threadStream, onThreadMessage, loadThread } = thread;
    const sentPane = root ? threadPane : pane;
    const returnToLive = sentPane?.historyThrough !== undefined || isReadingHistory(root ? threadStream.current : channelStream.current);
    recordChannelConfirmation(channelJournal.current, result.message);
    setPane((current) => applyChannelMessage(current, result.message));
    if (activeBrainChannel) refreshRoutingView();
    if (root) onThreadMessage(result.message, true);
    if (returnToLive) {
      // Fetch the complete latest window, including messages hidden while reading
      // history. ACKs fill missing IDs; snapshots refresh their metadata, and
      // genuinely in-flight WebSocket updates remain authoritative.
      try {
        if (root) await loadThread(channelId, root, result.message);
        else await loadChannel(channelId, undefined, [result.message]);
      } catch (error) {
        setErr(`Message sent, but the conversation could not refresh. Jump to recent to retry. ${String(error)}`);
      }
    }
    return true;
  }, []);

  const sendChannel = useCallback((body: string, files?: File[]) => send(body, null, files), [send]);
  const sendThread = useCallback((root: string, body: string, files?: File[]) => send(body, root, files), [send]);

  return { sendChannel, sendThread };
}
