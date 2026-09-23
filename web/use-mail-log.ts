import { useCallback, useEffect, useRef, useState } from "react";
import type { Channel, Message } from "../src/shared/types.ts";
import type { ChannelPayload, Snapshot } from "./api.ts";
import { loadMailLog, mergeMailLog, saveMailLog } from "./mail-log.ts";

/** The "All" box of For you: every message addressed to the Human that this browser has seen. */
export function useMailLog({ snap, channels, pane, threadPane, inboxPage }: {
  snap: Snapshot | null;
  channels: Channel[];
  pane: ChannelPayload | null;
  threadPane: ChannelPayload | null;
  inboxPage: { messages: Message[] } | null;
}) {
  const [mailLog, setMailLog] = useState<Message[]>(loadMailLog);
  const channelsRef = useRef<Channel[]>([]);
  channelsRef.current = channels;

  const mergeMail = useCallback((incoming: Message[]) => {
    setMailLog((prev) => {
      const next = mergeMailLog(prev, incoming, channelsRef.current);
      if (next !== prev) saveMailLog(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!snap) return;
    mergeMail(snap.mentions);
  }, [snap]);

  useEffect(() => {
    const incoming = [...(pane?.messages ?? []), ...(threadPane?.messages ?? []), ...(inboxPage?.messages ?? [])];
    if (incoming.length === 0) return;
    mergeMail(incoming);
  }, [pane, threadPane, inboxPage]);

  return { mailLog, mergeMail };
}
