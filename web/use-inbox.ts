import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import type { MentionPage } from "../src/shared/read-state.ts";
import type { Message, Project } from "../src/shared/types.ts";
import { api } from "./api.ts";
import type { InboxBox, Sel } from "./selection.ts";
import type { HiveSnapshot } from "./use-hive-snapshot.ts";

/** The unread "For you" page of the selected project, fenced by read state and paged by the Human. */
export function useInbox({ sel, selRef, projects, hive, setErr }: {
  sel: Sel;
  selRef: MutableRefObject<Sel>;
  projects: Project[];
  hive: Pick<HiveSnapshot, "readFence" | "readRefresh" | "acceptRead" | "readTick" | "reconnectTick">;
  setErr: (error: string) => void;
}) {
  const { readFence, readRefresh, acceptRead, readTick, reconnectTick } = hive;
  const [inboxPage, setInboxPage] = useState<(MentionPage & { project: string }) | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);
  /** Project whose first unread page failed to load, so the view can say so instead of "loading" forever. */
  const [inboxFailed, setInboxFailed] = useState<string | null>(null);
  const inboxLoad = useRef(createRequestGate());
  const inboxBox: InboxBox = sel.kind === "inbox" && sel.box === "all" ? "all" : "unread";
  const inboxMentions = sel.kind === "inbox" && inboxPage?.project === sel.project ? inboxPage.messages : [];

  const inboxSelected = sel.kind === "inbox" && inboxBox === "unread" && projects.some((p) => p.slug === sel.project) ? sel.project : null;
  useEffect(() => {
    const load = inboxLoad.current.begin();
    if (!inboxSelected) { setInboxPage(null); setInboxBusy(false); return; }
    const ticket = readFence.current.ticket();
    setInboxBusy(true);
    setInboxFailed(null);
    const timer = window.setTimeout(() => {
      api.mentions(undefined, inboxSelected, load.signal).then((page) => {
        if (!load.valid() || !readFence.current.matches(page, ticket)) return;
        setInboxPage({ ...page, project: inboxSelected });
      }).catch((error) => {
        if (!load.valid() || error?.name === "AbortError") return;
        setInboxFailed(inboxSelected);
        setErr(String(error));
      }).finally(() => { if (load.valid()) setInboxBusy(false); });
    }, 16);
    return () => { window.clearTimeout(timer); inboxLoad.current.cancel(); };
  }, [inboxSelected, readTick, reconnectTick]);

  const markMessage = async (project: string, message: Message) => {
    const ticket = readFence.current.ticket();
    const read = await api.markMessagesSeen(message.channelId, message.threadId, [message.seq]);
    if (acceptRead(read, ticket)) {
      setInboxPage(previous => previous?.project === project ? {
        ...previous, messages: previous.messages.filter(item => item.id !== message.id),
      } : previous);
    } else readRefresh.current?.request();
  };

  const loadOlder = (project: string) => {
    const oldest = inboxMentions.at(-1)?.seq;
    if (!oldest || inboxBusy || !projects.some((p) => p.slug === project)) return;
    const load = inboxLoad.current.begin();
    const ticket = readFence.current.ticket();
    setInboxBusy(true);
    api.mentions(oldest, project, load.signal).then((page) => {
      if (!load.valid() || !readFence.current.matches(page, ticket)) return;
      if (selRef.current.kind !== "inbox" || selRef.current.project !== project) return;
      setInboxPage((previous) => previous?.project === project ? {
        ...page, project,
        messages: [...previous.messages, ...page.messages.filter((m) => !previous.messages.some((x) => x.id === m.id))],
      } : previous);
    }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); })
      .finally(() => { if (load.valid()) setInboxBusy(false); });
  };

  const markAllSeen = (project: string) => {
    if (!projects.some((p) => p.slug === project)) return;
    const ticket = readFence.current.ticket();
    api.markMentionsSeen(project).then((page) => {
      if (!acceptRead(page.readState, ticket)) readRefresh.current?.request();
    }).catch((error) => setErr(String(error)));
  };

  // Nothing to show yet for the selected unread box: never say "all caught up" before its first page arrived.
  const inboxLoading = sel.kind === "inbox" && inboxSelected === sel.project && inboxPage?.project !== sel.project
    && inboxFailed !== sel.project;

  return { inboxPage, inboxBusy, inboxLoading, inboxFailed, inboxLoad, inboxBox, inboxMentions, markMessage, loadOlder, markAllSeen };
}
