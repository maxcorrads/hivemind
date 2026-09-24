import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createRequestGate } from "../src/shared/read-client.ts";
import type { ActivityItem, ActivityPage } from "../src/shared/read-state.ts";
import type { Project } from "../src/shared/types.ts";
import { filterReasons, mergeActivity, receiveActivity, type ActivityFilter, type ActivityView } from "./activity.ts";
import { api } from "./api.ts";
import type { InboxBox, Sel } from "./selection.ts";
import type { HiveSnapshot } from "./use-hive-snapshot.ts";

type LoadedPage = ActivityPage & ActivityView & { key: string };

/** The legacy browser-only "All" log (before the server-backed Activity feed). */
const LEGACY_MAIL_LOG_KEY = "hivemind-for-you-log";

/**
 * The For you page of the selected project, from the server: Unread (the same rows
 * the sidebar badge counts) or Activity (every entry with its read state), filtered
 * by type, paged by the Human and appended in realtime.
 */
export function useInbox({ sel, selRef, projects, hive, setErr }: {
  sel: Sel;
  selRef: MutableRefObject<Sel>;
  projects: Project[];
  hive: Pick<HiveSnapshot, "readFence" | "readRefresh" | "acceptRead" | "readTick" | "reconnectTick">;
  setErr: (error: string) => void;
}) {
  const { readFence, readRefresh, acceptRead, readTick, reconnectTick } = hive;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [inboxPage, setInboxPage] = useState<LoadedPage | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);
  /** View key whose first page failed to load, so the view can say so instead of "loading" forever. */
  const [inboxFailed, setInboxFailed] = useState<string | null>(null);
  const inboxLoad = useRef(createRequestGate());
  const pageRef = useRef(inboxPage);
  pageRef.current = inboxPage;
  const reconnected = useRef(reconnectTick);
  const inboxBox: InboxBox = sel.kind === "inbox" && sel.box === "all" ? "all" : "unread";
  const project = sel.kind === "inbox" && projects.some((p) => p.slug === sel.project) ? sel.project : null;
  const view: ActivityView | null = project ? { project, unreadOnly: inboxBox === "unread", reasons: filterReasons(filter) } : null;
  const key = view ? JSON.stringify([view.project, view.unreadOnly, filter]) : null;
  const inboxItems = inboxPage && inboxPage.key === key ? inboxPage.items : [];

  useEffect(() => { try { localStorage.removeItem(LEGACY_MAIL_LOG_KEY); } catch { /* storage unavailable */ } }, []);

  useEffect(() => {
    const load = inboxLoad.current.begin();
    if (!view || !key) { setInboxPage(null); setInboxBusy(false); return; }
    // Unread reloads on every read change, so it always lists what the badge counts.
    // Activity keeps the pages already loaded and merges the newest one (read flags, new entries).
    const fresh = reconnected.current !== reconnectTick;
    reconnected.current = reconnectTick;
    const merge = !view.unreadOnly && !fresh && pageRef.current?.key === key;
    const ticket = readFence.current.ticket();
    if (!merge) { setInboxBusy(true); setInboxFailed(null); }
    const timer = window.setTimeout(() => {
      api.activity(view, load.signal).then((page) => {
        if (!load.valid() || !readFence.current.matches(page, ticket)) return;
        setInboxPage((previous) => merge && previous?.key === key
          ? { ...previous, ...page, items: mergeActivity(previous.items, page.items), hasMore: previous.hasMore }
          : { ...page, ...view, key });
      }).catch((error) => {
        if (!load.valid() || error?.name === "AbortError") return;
        if (!merge) setInboxFailed(key);
        setErr(String(error));
      }).finally(() => { if (load.valid()) setInboxBusy(false); });
    }, 16);
    return () => { window.clearTimeout(timer); inboxLoad.current.cancel(); };
  }, [key, readTick, reconnectTick]);

  /** A realtime For you entry (the server's `activity` event). */
  const receive = useCallback((item: ActivityItem) => {
    setInboxPage((previous) => {
      if (!previous) return previous;
      const items = receiveActivity(previous.items, previous, item);
      return items === previous.items ? previous : { ...previous, items };
    });
  }, []);

  const markRead = (ids: Set<string> | null) => setInboxPage((previous) => previous && {
    ...previous,
    items: previous.unreadOnly
      ? previous.items.filter((item) => ids !== null && !ids.has(item.message.id))
      : previous.items.map((item) => ids === null || ids.has(item.message.id) ? { ...item, read: true } : item),
  });

  const markMessage = async (item: ActivityItem) => {
    const ticket = readFence.current.ticket();
    const { message } = item;
    const read = await api.markMessagesSeen(message.channelId, message.threadId, [message.seq]);
    if (acceptRead(read, ticket)) markRead(new Set([message.id]));
    else readRefresh.current?.request();
  };

  const loadOlder = () => {
    const current = pageRef.current;
    const oldest = current?.key === key ? current.items.at(-1)?.message.seq : undefined;
    if (!current || !oldest || inboxBusy) return;
    const load = inboxLoad.current.begin();
    const ticket = readFence.current.ticket();
    setInboxBusy(true);
    api.activity({ ...current, beforeSeq: oldest }, load.signal).then((page) => {
      if (!load.valid() || !readFence.current.matches(page, ticket)) return;
      if (selRef.current.kind !== "inbox" || selRef.current.project !== current.project) return;
      setInboxPage((previous) => previous?.key === current.key ? {
        ...previous, hasMore: page.hasMore,
        items: [...previous.items, ...page.items.filter((item) => !previous.items.some((x) => x.message.id === item.message.id))],
      } : previous);
    }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); })
      .finally(() => { if (load.valid()) setInboxBusy(false); });
  };

  const markAllSeen = () => {
    if (!project) return;
    const ticket = readFence.current.ticket();
    api.markMentionsSeen(project).then((page) => {
      if (acceptRead(page.readState, ticket)) markRead(null);
      else readRefresh.current?.request();
    }).catch((error) => setErr(String(error)));
  };

  // Nothing to show yet for the selected view: never say "all caught up" before its first page arrived.
  const inboxLoading = key !== null && inboxPage?.key !== key && inboxFailed !== key;

  return { inboxPage, inboxBusy, inboxLoading, inboxFailed: key !== null && inboxFailed === key, inboxLoad, inboxBox, inboxItems, filter, setFilter, receive, markMessage, loadOlder, markAllSeen };
}
