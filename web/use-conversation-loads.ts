import { useEffect } from "react";
import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import type { ChannelPane } from "./use-channel-pane.ts";
import type { HiveSnapshot } from "./use-hive-snapshot.ts";
import type { ThreadPane } from "./use-thread-pane.ts";

/**
 * (Re)loads the selected channel and thread whenever the selection or the
 * connection changes, and acknowledges only the panes React committed for it.
 */
export function useConversationLoads({ selectedChannelId, threadId, missingChannel, query, hive, channel, thread, setErr }: {
  selectedChannelId: string | null;
  threadId: string | null;
  missingChannel: boolean;
  query: string;
  hive: Pick<HiveSnapshot, "channelReads" | "threadReads" | "reconnectTick">;
  channel: ChannelPane;
  thread: ThreadPane;
  setErr: (error: string) => void;
}) {
  const { channelReads, threadReads, reconnectTick } = hive;
  const { pane, setPane, channelLoad, channelJournal, channelRefreshIntent, loadChannel } = channel;
  const { threadPane, setThreadPane, threadLoad, loadThread } = thread;

  useEffect(() => {
    if (!selectedChannelId || missingChannel) {
      channelLoad.current.cancel();
      channelJournal.current = null;
      channelRefreshIntent.current = null;
      setPane(null);
      return;
    }
    loadChannel(selectedChannelId).catch((e) => { if (e?.name !== "AbortError") setErr(String(e)); });
  }, [selectedChannelId, loadChannel, missingChannel, reconnectTick]);

  useEffect(() => {
    if (!threadId || !selectedChannelId || missingChannel) {
      threadLoad.current.cancel();
      setThreadPane(null);
      return;
    }
    loadThread(selectedChannelId, threadId).catch((e) => { if (e?.name !== "AbortError") setErr(String(e)); });
  }, [threadId, selectedChannelId, missingChannel, loadThread, reconnectTick]);

  // A read receipt is sent only after React committed a pane belonging to the
  // current selection. HTTP GETs and obsolete panes cannot acknowledge content.
  useEffect(() => {
    const valid = !isLiveSearchQuery(query) && !missingChannel && selectedChannelId && pane?.channel.id === selectedChannelId && pane.threadId === null;
    channelReads.current?.update(valid ? { channelId: selectedChannelId, threadId: null } : null,
      valid ? pane.messages.filter((m) => m.authorId !== "human").map((m) => m.seq) : []);
  }, [pane, selectedChannelId, missingChannel, query, reconnectTick]);
  useEffect(() => {
    const valid = !missingChannel && selectedChannelId && threadId && threadPane?.channel.id === selectedChannelId && threadPane.threadId === threadId;
    threadReads.current?.update(valid ? { channelId: selectedChannelId, threadId } : null,
      valid ? threadPane.messages.filter((m) => m.authorId !== "human").map((m) => m.seq) : []);
  }, [threadPane, selectedChannelId, threadId, missingChannel, reconnectTick]);
}
