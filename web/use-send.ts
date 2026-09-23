import { useRef, useState } from "react";
import { api } from "./api.ts";
import { applyChannelMessage, recordChannelConfirmation } from "./channel-state.ts";
import { isReadingHistory } from "./pane-window.ts";
import type { Sel } from "./selection.ts";
import { createSendOperations } from "./send-operation.ts";
import type { ChannelPane } from "./use-channel-pane.ts";
import type { Selection } from "./use-selection.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

/** Channel and thread drafts and the send that confirms into the panes. */
export function useSend({ sel, selection, channel, thread, activeBrainChannel, refreshRoutingView, setErr }: {
  sel: Sel;
  selection: Pick<Selection, "selRef" | "threadIdRef">;
  channel: ChannelPane;
  thread: ThreadPane;
  activeBrainChannel: boolean;
  refreshRoutingView: () => void;
  setErr: (error: string) => void;
}) {
  const { selRef, threadIdRef } = selection;
  const { pane, setPane, channelStream, channelJournal, loadChannel } = channel;
  const { threadPane, threadStream, onThreadMessage, loadThread } = thread;
  const [draft, setDraft] = useState("");
  const [threadDraft, setThreadDraft] = useState("");
  const panesRef = useRef({ pane, threadPane });
  panesRef.current = { pane, threadPane };

  const sendOperations = useRef(createSendOperations(api.upload, api.send));
  const send = async (body: string, tid?: string | null, files?: File[]) => {
    if (sel.kind !== "channel") return;
    const channelId = sel.id;
    const root = tid ?? null;
    if (!body.trim() && !files?.length) return;
    const result = await sendOperations.current(channelId, body.trim(), root, files);
    if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || (root && threadIdRef.current !== root)) return;
    const sentPane = root ? panesRef.current.threadPane : panesRef.current.pane;
    const returnToLive = sentPane?.historyThrough !== undefined || isReadingHistory(root ? threadStream.current : channelStream.current);
    if (root) setThreadDraft((current) => current === body ? "" : current);
    else setDraft((current) => current === body ? "" : current);
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
        setErr(`Message sent, but the conversation could not refresh. Return to live to retry. ${String(error)}`);
      }
    }
  };

  const sendChannel = (files?: File[]) => send(draft, undefined, files);
  const sendThread = (root: string, files?: File[]) => send(threadDraft, root, files);

  return {
    draft, setDraft, threadDraft, setThreadDraft, sendChannel, sendThread,
  };
}
