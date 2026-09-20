import { createSendOperations } from "./send-operation.ts";
import { beginChannelJournal, recordChannelMessage, recordChannelThread, applyChannelMessage, reconcileChannelSnapshot, type ChannelJournal } from "./channel-state.ts";
import { newerTelegramHealth, telegramDegraded, type TelegramHealth } from "./telegram-health.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Agent, Channel, Message, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import { REACTION_EMOJIS } from "../src/shared/types.ts";
import { isLiveSearchQuery, parseSearchQuery } from "../src/shared/search-query.ts";
import { api, connectWs, type ChannelPayload, type Snapshot, type TelegramSettings } from "./api.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { BotOrigin, BotSetup, BotCredentials } from "./Bots.tsx";
import { ProjectPlugins } from "./ProjectPlugins.tsx";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";
import { loadMailLog, mergeMailLog, saveMailLog } from "./mail-log.ts";
import type { MentionPage, ReadSnapshot } from "../src/shared/read-state.ts";
import { createReadFence, createReadRefresh, createReceiptQueue, createRequestGate, readFields } from "../src/shared/read-client.ts";
import { renderBody } from "./markdown.tsx";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { TaskCard } from './TaskCard.tsx';
import { RoomPanel } from './RoomPanel.tsx';
import { DecisionCard, DecisionQueue } from './DecisionQueue.tsx';
import type { DecisionView } from '../src/shared/decisions.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import { selectThread, beginThreadLoad, failThreadLoad, receiveThreadMessage, receiveThreadTask, receiveThreadSnapshot, receiveThreadStatus, type ThreadView } from './thread-state.ts';

type InboxBox = "unread" | "all";

type Sel =
  | { kind: "inbox"; project: string; box?: InboxBox }
  | { kind: "decisions"; project: string }
  | { kind: "channel"; id: string; thread?: string | null };

const STATUSES: ThreadStatus[] = ["open", "in_progress", "blocked", "done"];

function parseHash(): Sel {
  const raw = location.hash.replace(/^#/, "") || "/c/general";
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "inbox") {
    return {
      kind: "inbox",
      project: parts[1] ? decodeURIComponent(parts[1]) : "",
      box: parts[2] === "all" ? "all" : "unread",
    };
  }
  if (parts[0] === "decisions") return { kind: "decisions", project: parts[1] ? decodeURIComponent(parts[1]) : "" };
  if (parts[1]) {
    const thread = parts[2] === "t" && parts[3] ? decodeURIComponent(parts[3]) : undefined;
    return { kind: "channel", id: decodeURIComponent(parts[1]), thread };
  }
  return { kind: "channel", id: "general" };
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  if (list.some((x) => x.id === item.id)) return list.map((x) => (x.id === item.id ? item : x));
  return [...list, item];
}

function setHash(sel: Sel) {
  location.hash =
    sel.kind === "inbox"
      ? `${sel.project ? `/inbox/${encodeURIComponent(sel.project)}` : "/inbox"}${sel.box === "all" ? "/all" : ""}`
      : sel.kind === "decisions"
        ? `${sel.project ? `/decisions/${encodeURIComponent(sel.project)}` : "/decisions"}`
        : `/c/${encodeURIComponent(sel.id)}${sel.thread ? `/t/${encodeURIComponent(sel.thread)}` : ""}`;
}

function repairSel(sel: Sel, snap: Snapshot): Sel | null {
  if (sel.kind === "inbox" || sel.kind === "decisions") {
    if (!sel.project) return snap.projects[0] ? { ...sel, project: snap.projects[0].slug } : null;
    if (snap.projects.some((p) => p.slug === sel.project)) return null;
    const fallback = snap.projects[0];
    return fallback ? { ...sel, project: fallback.slug } : { ...sel, project: "" };
  }
  if (snap.channels.some((c) => c.id === sel.id)) return null;
  const fallback = snap.projects[0];
  return fallback ? { kind: "inbox", project: fallback.slug } : { kind: "inbox", project: "" };
}

function seniorityBars(agent: Agent): number {
  if (agent.role !== "worker") return 0;
  if (agent.seniority === "senior") return 3;
  if (agent.seniority === "mid") return 2;
  return 1;
}

function channelTitle(ch: Channel): string {
  return ch.type === "dm" ? ch.name : `#${ch.name}`;
}

function memberNames(ch: Channel, agents: Agent[]): string {
  const names = ch.memberIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return "No members";
  return names.join(", ");
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const latestTelegramHealth = useRef<TelegramHealth | null>(null);
  const [sel, setSel] = useState<Sel>(parseHash);
  const [pane, setPane] = useState<ChannelPayload | null>(null);
  const [threadId, setThreadId] = useState<string | null>(() => {
    const start = parseHash();
    return start.kind === "channel" ? start.thread ?? null : null;
  });
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
  const [draft, setDraft] = useState("");
  const [threadDraft, setThreadDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [roomTick, setRoomTick] = useState(0);
  const [decisionTick, setDecisionTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [newType, setNewType] = useState<"public" | "private">("public");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteNames, setInviteNames] = useState<string[]>([]);
  const [botProject, setBotProject] = useState<string | null>(null);
  const [pluginsProject, setPluginsProject] = useState<string | null>(null);
  const [botBusy, setBotBusy] = useState(false);
  const [credentialBot, setCredentialBot] = useState<Agent | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgUsers, setTgUsers] = useState("");
  const [tgGroups, setTgGroups] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitsMore, setHitsMore] = useState(false);
  const [hitsBusy, setHitsBusy] = useState(false);
  const [searchTick, setSearchTick] = useState(0);
  const searchDelayRef = useRef(280);
  const hitsNeedleRef = useRef("");
  const hitsProjectRef = useRef("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("hivemind-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [newProjectTree, setNewProjectTree] = useState("");
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);
  const [createIn, setCreateIn] = useState<string | null>(null);
  const [mailLog, setMailLog] = useState<Message[]>(loadMailLog);
  const stickBottom = useRef(true);
  const themePainted = useRef(false);
  const channelStream = useRef<HTMLDivElement>(null);
  const threadStream = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadBottomRef = useRef<HTMLDivElement>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const channelsRef = useRef<Channel[]>([]);
  const threadLoadIdRef = useRef(0);

  const viewingThread = useCallback((channelId: string, root: string) =>
    selRef.current.kind === 'channel' && selRef.current.id === channelId && threadIdRef.current === root, []);

  const loadThread = useCallback(async (channelId: string, root: string) => {
    if (!viewingThread(channelId, root)) return;
    const requestId = ++threadLoadIdRef.current;
    const load = threadLoad.current.begin();
    setThreadView(view => beginThreadLoad(view, channelId, root, requestId));
    try {
      const data = await api.messages(channelId, root, undefined, load.signal);
      if (load.valid() && viewingThread(channelId, root)) setThreadView(view => receiveThreadSnapshot(view, root, data, requestId));
    } catch (error) {
      if (load.valid() && viewingThread(channelId, root) && requestId === threadLoadIdRef.current) {
        setThreadView(view => failThreadLoad(view, requestId));
        throw error;
      }
    }
  }, [viewingThread]);

  const onThreadMessage = useCallback((message: Message) => {
    const root = threadIdRef.current;
    if (root && viewingThread(message.channelId, root))
      setThreadView(view => {
        const current = selectThread(view, message.channelId, root);
        const held = current.pane && isReadingHistory(threadStream.current)
          ? { ...current, pane: holdLivePane(current.pane) } : current;
        return receiveThreadMessage(held, message);
      });
  }, [viewingThread]);

  const readFence = useRef(createReadFence());
  const channelLoad = useRef(createRequestGate());
  const channelJournal = useRef<ChannelJournal | null>(null);
  const threadLoad = useRef(createRequestGate());
  const snapshotLoad = useRef(createRequestGate());
  const inboxLoad = useRef(createRequestGate());
  const readRefresh = useRef<ReturnType<typeof createReadRefresh> | null>(null);
  const channelReads = useRef<ReturnType<typeof createReceiptQueue> | null>(null);
  const threadReads = useRef<ReturnType<typeof createReceiptQueue> | null>(null);
  const [readTick, setReadTick] = useState(0);
  const [reconnectTick, setReconnectTick] = useState(0);
  const readVersion = useRef("");
  const [inboxPage, setInboxPage] = useState<(MentionPage & { project: string }) | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);

  const changeSelection = useCallback((next: Sel) => {
    const previous = selRef.current;
    const priorChannel = previous.kind === "channel" ? previous.id : null;
    const nextChannel = next.kind === "channel" ? next.id : null;
    const nextThread = next.kind === "channel" ? next.thread ?? null : null;
    if (priorChannel !== nextChannel) {
      channelLoad.current.cancel();
      channelJournal.current = null;
      channelReads.current?.reset();
    }
    if (priorChannel !== nextChannel || threadIdRef.current !== nextThread) {
      threadLoad.current.cancel();
      threadReads.current?.reset();
    }
    const previousKey = previous.kind === "inbox" ? `${previous.project}/${previous.box ?? "unread"}` : null;
    const nextKey = next.kind === "inbox" ? `${next.project}/${next.box ?? "unread"}` : null;
    if (previousKey !== nextKey) inboxLoad.current.cancel();
    selRef.current = next;
    threadIdRef.current = nextThread;
    setSel(next);
    setThreadId(nextThread);
  }, []);

  const acceptRead = useCallback((next: ReadSnapshot, ticket: number) => {
    if (!readFence.current.accept(next, ticket)) return false;
    setSnap((previous) => previous ? { ...previous, ...readFields(next) } : previous);
    const version = JSON.stringify([ticket, next.readInstance, next.readRevision, next.readSeq]);
    if (readVersion.current !== version) {
      readVersion.current = version;
      setReadTick((value) => value + 1);
    }
    return true;
  }, []);

  useEffect(() => {
    const later = (run: () => void) => {
      const timer = window.setTimeout(run, 16);
      return () => window.clearTimeout(timer);
    };
    const onError = (error: unknown) => setErr(String(error));
    const refresh = createReadRefresh(async (signal) => {
      const ticket = readFence.current.ticket();
      const next = await api.readState(signal);
      if (!signal.aborted && !acceptRead(next, ticket) && readFence.current.current(ticket)) refresh.request();
    }, later, onError);
    const makeQueue = () => createReceiptQueue(async (scope, seqs, signal) => {
      const ticket = readFence.current.ticket();
      const next = await api.markMessagesSeen(scope.channelId, scope.threadId, seqs, signal);
      if (!signal.aborted && !acceptRead(next, ticket)) refresh.request();
    }, later, onError);
    readRefresh.current = refresh;
    channelReads.current = makeQueue();
    threadReads.current = makeQueue();
    return () => {
      readFence.current.reset();
      refresh.dispose();
      channelReads.current?.dispose();
      threadReads.current?.dispose();
      readRefresh.current = null;
      channelReads.current = null;
      threadReads.current = null;
    };
  }, [acceptRead]);

  const refreshSnap = useCallback(async () => {
    const load = snapshotLoad.current.begin();
    const ticket = readFence.current.ticket();
    const raw = await api.snapshot(load.signal);
    latestTelegramHealth.current = newerTelegramHealth(latestTelegramHealth.current, raw.telegram);
    const next = { ...raw, telegram: { running: false, configured: false, ...raw.telegram, ...latestTelegramHealth.current } };
    if (!load.valid() || !readFence.current.current(ticket)) return next;
    const accepted = acceptRead(next, ticket);
    setSnap((previous) => ({ ...next, ...(!accepted && previous ? readFields(previous) : {}) }));
    if (!accepted) readRefresh.current?.request();
    return next;
  }, [acceptRead]);

  const loadChannel = useCallback(async (id: string, before?: number) => {
    const load = channelLoad.current.begin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const journal = beginChannelJournal(id);
      channelJournal.current = journal;
      try {
        const data = await api.messages(id, null, before, load.signal);
        if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== id) return;
        if (journal.overflow) {
          if (attempt < 2) continue;
          throw new Error("Live traffic overtook the channel refresh. Reload the page to retry.");
        }
        setPane((current) => reconcileChannelSnapshot(current, data, journal, before !== undefined));
        return;
      } catch (error) {
        if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== id) return;
        throw error;
      } finally {
        if (channelJournal.current === journal) channelJournal.current = null;
      }
    }
  }, []);

  const resetReadConnection = useCallback(() => {
    readFence.current.reset();
    channelLoad.current.cancel();
    channelJournal.current = null;
    threadLoad.current.cancel();
    inboxLoad.current.cancel();
    channelReads.current?.reset();
    threadReads.current?.reset();
    setReconnectTick((value) => value + 1);
    refreshSnap().catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
  }, [refreshSnap]);

  useEffect(() => {
    refreshSnap().catch((e) => { if (e?.name !== "AbortError") setErr(String(e.message || e)); });
    const off = connectWs((ev) => {
      if (ev.type === "hello") {
        resetReadConnection();
        setRoomTick(t => t + 1);
        return;
      }
      if (ev.type === "telegram-health") {
        const health = newerTelegramHealth(latestTelegramHealth.current, ev.payload as TelegramHealth);
        latestTelegramHealth.current = health;
        setSnap((current) => current ? { ...current, telegram: { running: false, configured: false, ...current.telegram, ...health } } : current);
        return;
      }
      if (ev.type === "message") {
        const msg = ev.payload as Message;
        recordChannelMessage(channelJournal.current, msg);
        setPane((p) => applyChannelMessage(p && isReadingHistory(channelStream.current) ? holdLivePane(p) : p, msg));
        onThreadMessage(msg);
        readFence.current.observe(msg.seq);
        readRefresh.current?.request();
        setMailLog((prev) => {
          const next = mergeMailLog(prev, [msg], channelsRef.current);
          if (next !== prev) saveMailLog(next);
          return next;
        });
        return;
      }
      if (ev.type === "reaction") {
        const payload = ev.payload as { message?: Message };
        if (payload.message) {
          recordChannelMessage(channelJournal.current, payload.message, false);
          setPane((p) => applyChannelMessage(p, payload.message!, false));
          onThreadMessage(payload.message);
        }
        return;
      }
      if (ev.type === "agent") {
        const agent = ev.payload as Agent;
        setSnap((s) => (s ? { ...s, agents: upsertById(s.agents, agent) } : s));
        return;
      }
      if (ev.type === "channel") {
        const ch = ev.payload as Channel;
        setSnap((s) => (s ? { ...s, channels: upsertById(s.channels, ch) } : s));
        return;
      }
      if (ev.type === "thread") {
        const thread = ev.payload as Thread;
        recordChannelThread(channelJournal.current, thread);
        if (viewingThread(thread.channelId, thread.id))
          setThreadView(view => receiveThreadStatus(selectThread(view, thread.channelId, thread.id), thread));
        setPane((p) => {
          if (!p || p.channel.id !== thread.channelId || !p.messages.some((message) => message.id === thread.id)) return p;
          return { ...p, threads: upsertById(p.threads, thread) };
        });
        return;
      }
      if (ev.type === "queued") {
        const q = ev.payload as { agentId: string; n: number; inbox?: InboxStatus };
        if (selRef.current.kind === 'decisions') setDecisionTick(t => t + 1);
        setSnap((current) => {
          if (!current) return current;
          const previous = current.inbox?.[q.agentId];
          const inbox: InboxStatus = q.inbox ?? {
            awaitingReceipt: previous?.awaitingReceipt ?? 0,
            acknowledgedMessages: previous?.acknowledgedMessages ?? 0,
            lastAcknowledgedAt: previous?.lastAcknowledgedAt ?? null,
            queued: { atLeast: q.n, exact: true },
          };
          return {
            ...current,
            queued: { ...current.queued, [q.agentId]: q.n },
            inbox: { ...current.inbox, [q.agentId]: inbox },
          };
        });
        return;
      }
      if (ev.type === 'task') {
        const task = ev.payload as TaskSnapshot;
        setDecisionTick(t => t + 1);
        if (selRef.current.kind === 'channel' && selRef.current.id === task.channelId) setRoomTick(t => t + 1);
        if (viewingThread(task.channelId, task.id)) {
          setThreadView(view => receiveThreadTask(selectThread(view, task.channelId, task.id), task));
          loadThread(task.channelId, task.id).catch(() => undefined);
        }
        return;
      }
      if (ev.type === 'decision') {
        const decision = ev.payload as DecisionView;
        setDecisionTick(t => t + 1);
        if (selRef.current.kind === 'channel' && selRef.current.id === decision.channelId) {
          const root = threadIdRef.current;
          if (root === decision.id || root === decision.taskId)
            loadThread(decision.channelId, root).catch(() => undefined);
        }
        return;
      }
      if (ev.type === 'room') {
        const payload = ev.payload as { channelId: string };
        if (selRef.current.kind === 'channel' && selRef.current.id === payload.channelId) {
          setRoomTick(t => t + 1);
          if (threadIdRef.current) loadThread(payload.channelId, threadIdRef.current).catch(() => undefined);
        }
        return;
      }
      if (ev.type === "project") {
        resetReadConnection();
        return;
      }
    }, setLive);
    const onHash = () => changeSelection(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      off();
      channelLoad.current.cancel();
      channelJournal.current = null;
      threadLoad.current.cancel();
      snapshotLoad.current.cancel();
      inboxLoad.current.cancel();
      window.removeEventListener("hashchange", onHash);
    };
  }, [loadChannel, refreshSnap, resetReadConnection, changeSelection, onThreadMessage, viewingThread, loadThread, setThreadPane]);

  const missingChannel = Boolean(snap && sel.kind === "channel" && !snap.channels.some((c) => c.id === sel.id));

  useEffect(() => {
    if (!snap) return;
    const next = repairSel(sel, snap);
    if (!next) return;
    changeSelection(next);
    setHash(next);
  }, [snap, sel, changeSelection]);

  useEffect(() => {
    if (!snap) return;
    if (editingProject && !snap.projects.some((p) => p.slug === editingProject)) {
      setEditingProject(null);
      setProjectDeleteConfirm("");
      setDeletingProject(false);
    }
    if (createIn && !snap.projects.some((p) => p.slug === createIn)) setCreateIn(null);
  }, [snap, editingProject, createIn]);

  const selectedChannelId = sel.kind === "channel" ? sel.id : null;
  useEffect(() => {
    if (!selectedChannelId || missingChannel) {
      channelLoad.current.cancel();
      channelJournal.current = null;
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

  useEffect(() => {
    const apply = () => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      localStorage.setItem("hivemind-theme", theme);
    };
    if (!themePainted.current) {
      themePainted.current = true;
      apply();
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!reduce && doc.startViewTransition) doc.startViewTransition(apply);
    else apply();
  }, [theme]);

  useEffect(() => {
    if (stickBottom.current && pane?.historyThrough === undefined) bottomRef.current?.scrollIntoView({ block: "end" });
    stickBottom.current = true;
  }, [pane?.messages.length, pane?.historyThrough]);
  useEffect(() => {
    if (threadPane?.historyThrough === undefined) threadBottomRef.current?.scrollIntoView({ block: "end" });
  }, [threadPane?.messages.length, threadPane?.historyThrough]);

  useEffect(() => {
    if (!snap) return;
    setMailLog((prev) => {
      const next = mergeMailLog(prev, snap.mentions, snap.channels);
      if (next !== prev) saveMailLog(next);
      return next;
    });
  }, [snap]);

  useEffect(() => {
    const incoming = [...(pane?.messages ?? []), ...(threadPane?.messages ?? []), ...(inboxPage?.messages ?? [])];
    if (incoming.length === 0) return;
    setMailLog((prev) => {
      const next = mergeMailLog(prev, incoming, channelsRef.current);
      if (next !== prev) saveMailLog(next);
      return next;
    });
  }, [pane, threadPane, inboxPage]);

  const go = (next: Sel) => {
    changeSelection(next);
    setHash(next);
  };

  const channels = snap?.channels ?? [];
  channelsRef.current = channels;
  const projects = snap?.projects ?? [];
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const activeChannel = sel.kind === "channel" ? channels.find((c) => c.id === sel.id) : undefined;
  const selectedProject =
    sel.kind === "inbox" || sel.kind === "decisions" ? sel.project : (activeChannel?.project ?? projects[0]?.slug ?? "chapter");
  const editingBusy = editingProject
    ? (snap?.agents ?? []).filter((a) => a.role !== "human" && a.project === editingProject && a.online)
    : [];
  const canDeleteProject =
    Boolean(editingProject) &&
    !deletingProject &&
    projectDeleteConfirm.trim().toLowerCase() === editingProject &&
    editingBusy.length === 0;
  const roomAgents = (snap?.agents ?? []).filter((a) => {
    if (a.role !== "human" && a.project && a.project !== selectedProject) return false;
    if (!q) return true;
    return match(a.name) || match(a.focus ?? "") || match(a.role);
  });
  const mentionTotal = (slug: string) => snap?.mentionCounts[slug] ?? 0;
  const inboxMentions = sel.kind === "inbox" && inboxPage?.project === sel.project ? inboxPage.messages : [];
  const inboxProject = sel.kind === "inbox" ? sel.project : selectedProject;
  const allForYou = mailLog.filter((m) => channels.find((c) => c.id === m.channelId)?.project === inboxProject);
  const inboxBox: InboxBox = sel.kind === "inbox" && sel.box === "all" ? "all" : "unread";
  const searching = isLiveSearchQuery(query);
  const searchProjectOk = projects.some((p) => p.slug === selectedProject);

  useEffect(() => {
    if (!searching || !searchProjectOk) {
      hitsNeedleRef.current = "";
      hitsProjectRef.current = "";
      setHits([]);
      setHitsMore(false);
      setHitsBusy(false);
      return;
    }
    const needle = query.trim();
    const project = selectedProject;
    const ac = new AbortController();
    setHits([]);
    setHitsMore(false);
    setHitsBusy(true);
    const delay = searchDelayRef.current;
    searchDelayRef.current = 280;
    const timer = window.setTimeout(() => {
      api
        .search(needle, project, undefined, undefined, ac.signal)
        .then((page) => {
          if (ac.signal.aborted) return;
          hitsNeedleRef.current = needle;
          hitsProjectRef.current = project;
          setHits(page.hits);
          setHitsMore(page.hasMore);
        })
        .catch((e) => {
          if (ac.signal.aborted || e.name === "AbortError") return;
          setErr(String(e.message || e));
        })
        .finally(() => {
          if (!ac.signal.aborted) setHitsBusy(false);
        });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [searching, query, selectedProject, searchProjectOk, searchTick]);

  const inboxSelected = sel.kind === "inbox" && inboxBox === "unread" && projects.some((p) => p.slug === sel.project) ? sel.project : null;
  useEffect(() => {
    const load = inboxLoad.current.begin();
    if (!inboxSelected) { setInboxPage(null); setInboxBusy(false); return; }
    const ticket = readFence.current.ticket();
    setInboxBusy(true);
    const timer = window.setTimeout(() => {
      api.mentions(undefined, inboxSelected, load.signal).then((page) => {
        if (!load.valid() || !readFence.current.matches(page, ticket)) return;
        setInboxPage({ ...page, project: inboxSelected });
      }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); })
        .finally(() => { if (load.valid()) setInboxBusy(false); });
    }, 16);
    return () => { window.clearTimeout(timer); inboxLoad.current.cancel(); };
  }, [inboxSelected, readTick, reconnectTick]);

  const sendOperations = useRef(createSendOperations(api.upload, api.send));
  const send = async (body: string, tid?: string | null, files?: File[]) => {
    if (sel.kind !== "channel") return;
    const channelId = sel.id;
    const root = tid ?? null;
    if (!body.trim() && !files?.length) return;
    const { message } = await sendOperations.current(channelId, body.trim(), root, files);
    if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || (root && threadIdRef.current !== root)) return;
    if (root) setThreadDraft((current) => current === body ? "" : current);
    else setDraft((current) => current === body ? "" : current);
    recordChannelMessage(channelJournal.current, message);
    setPane((current) => applyChannelMessage(current, message));
    if (root) onThreadMessage(message);
  };

  const onCreate = async () => {
    if (!newName.trim()) return;
    const project = createIn ?? activeChannel?.project ?? snap?.projects[0]?.slug;
    const { channel } = await api.createChannel(
      newName.trim(),
      newType,
      newTopic.trim() || undefined,
      newType === "private" ? newMembers : undefined,
      project,
    );
    setCreating(false);
    setCreateIn(null);
    setNewName("");
    setNewTopic("");
    setNewMembers([]);
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
  };

  const onAgent = async (agent: Agent) => {
    if (agent.id === "human") return;
    const { channel } = await api.openDm(agent.name);
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
  };

  const onClear = async (name: string) => {
    await api.clearContext(name);
    setConfirmClear(null);
    await refreshSnap();
  };

  if (!snap && err) {
    return (
      <div className="boot-fail">
        <p>Hivemind is not responding.</p>
        <p className="muted">Start the server with <code>npm run dev</code>, then open http://127.0.0.1:7420</p>
        <p className="muted">{err}</p>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="boot-fail">
        <p>Opening the hive…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <img className="mark" src="/icon.png" alt="Hivemind" />
          <div>
            <div className="word">hivemind</div>
            <div className="you">you are Human</div>
          </div>
          <div className="brand-tools">
            <button
              type="button"
              className="icon-btn"
              title={theme === "dark" ? "Light" : "Dark"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button
              type="button"
              className="icon-btn"
              title={telegramDegraded(snap.telegram) ? `Telegram · ${snap.telegram?.failures ?? 0} outbound failures · ${snap.telegram?.quarantined ?? 0} quarantined · ${snap.telegram?.retrying ?? 0} retrying${snap.telegram?.lastError ? ` · ${snap.telegram.lastError}` : ""}` : "Telegram"}
              onClick={() => {
                api
                  .telegram()
                  .then((t) => {
                    setTelegram(t);
                    setTgToken("");
                    setTgUsers(t.allowUserIds.join(", "));
                    setTgGroups(
                      Object.fromEntries(
                        (snap?.projects ?? []).map((p) => [
                          p.slug,
                          t.projects[p.slug] != null ? String(t.projects[p.slug]) : "",
                        ]),
                      ),
                    );
                    setTelegramOpen(true);
                  })
                  .catch((e) => setErr(String(e.message || e)));
              }}
            >
              {telegramDegraded(snap.telegram) ? "⚠" : snap.telegram?.running ? "✈" : "⌬"}
            </button>
            <button type="button" className="icon-btn" title="Launch agent" onClick={() => setLaunchOpen(true)}>
              ▶
            </button>
            <button type="button" className="icon-btn" title="How to join" onClick={() => setHelpOpen(true)}>
              ?
            </button>
            <span className={`pulse ${live ? "on" : ""}`} title={live ? "live" : "waiting"} />
          </div>
        </div>
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && isLiveSearchQuery(query)) {
              e.preventDefault();
              searchDelayRef.current = 0;
              setSearchTick((n) => n + 1);
            }
          }}
          placeholder="Search this hive"
        />

        <div className="group-h">
          <span>Projects</span>
          <button type="button" className="plus" onClick={() => setCreatingProject(true)} title="New project">
            +
          </button>
        </div>

        {projects.length === 0 && <p className="help-p">No projects.</p>}
        {projects.map((project) => {
          const open = openProjects[project.slug] ?? project.slug === selectedProject;
          const publics = channels.filter(
            (c) =>
              c.project === project.slug &&
              (c.type === "public" || c.type === "brains" || c.type === "private") &&
              match(c.name),
          );
          const myDms = channels.filter(
            (c) => c.project === project.slug && c.type === "dm" && c.memberIds.includes("human") && match(c.name),
          );
          const otherDms = channels.filter(
            (c) => c.project === project.slug && c.type === "dm" && !c.memberIds.includes("human") && match(c.name),
          );
          const hiveAgents = (snap.agents ?? []).filter(
            (a) => a.role === "human" || a.project === project.slug,
          ).filter((a) => !q || match(a.name) || match(a.focus ?? "") || match(a.role));
          const n = mentionTotal(project.slug);
          return (
            <div key={project.id} className="project-sec">
              <div className="group-h">
                <button
                  type="button"
                  className="twist"
                  onClick={() => setOpenProjects((g) => ({ ...g, [project.slug]: !open }))}
                  aria-expanded={open}
                >
                  {open ? "▾" : "▸"}
                </button>
                <span>{project.name}</span>
                {n > 0 && <em className="sec-badge">{n}</em>}
                <button
                  type="button"
                  className="plus"
                  title="Project settings"
                  onClick={() => {
                    setEditingProject(project.slug);
                    setNewProjectName(project.name);
                    setNewProjectTree(project.worktree ?? "");
                    setProjectDeleteConfirm("");
                  }}
                >
                  …
                </button>
              </div>
              {open && (
                <>
                  <button
                    className={`nav ${sel.kind === "inbox" && sel.project === project.slug ? "active" : ""}`}
                    onClick={() => go({ kind: "inbox", project: project.slug, box: inboxBox })}
                  >
                    <span>For you</span>
                    {n > 0 && <em>{n}</em>}
                  </button>
                  <button
                    className={`nav ${sel.kind === "decisions" && sel.project === project.slug ? "active" : ""}`}
                    onClick={() => go({ kind: "decisions", project: project.slug })}
                  >
                    <span>Decisions</span>
                  </button>
                  <div className="group">
                    <div className="group-h">
                      <span>Channels</span>
                      <button
                        type="button"
                        className="plus"
                        onClick={() => {
                          setCreateIn(project.slug);
                          setCreating(true);
                        }}
                        title="New channel"
                      >
                        +
                      </button>
                    </div>
                    {publics.map((ch) => (
                      <ChannelItem
                        key={ch.id}
                        ch={ch}
                        unread={snap.unread[ch.id] ?? 0}
                        active={sel.kind === "channel" && sel.id === ch.id}
                        onClick={() => go({ kind: "channel", id: ch.id })}
                      />
                    ))}
                  </div>
                  <div className="group">
                    <div className="group-h">
                      <span>Direct messages</span>
                    </div>
                    {myDms.length === 0 && <div className="empty-mini">No direct messages</div>}
                    {myDms.map((ch) => (
                      <ChannelItem
                        key={ch.id}
                        ch={ch}
                        unread={snap.unread[ch.id] ?? 0}
                        active={sel.kind === "channel" && sel.id === ch.id}
                        onClick={() => go({ kind: "channel", id: ch.id })}
                      />
                    ))}
                  </div>
                  {otherDms.length > 0 && (
                    <div className="group">
                      <div className="group-h">
                        <span>Other directs</span>
                      </div>
                      {otherDms.map((ch) => (
                        <ChannelItem
                          key={ch.id}
                          ch={ch}
                          unread={snap.unread[ch.id] ?? 0}
                          active={sel.kind === "channel" && sel.id === ch.id}
                          onClick={() => go({ kind: "channel", id: ch.id })}
                        />
                      ))}
                    </div>
                  )}
                  <div className="group">
                    <div className="group-h">
                      <span>Hive</span>
                    </div>
                    <AgentList
                      agents={hiveAgents}
                      projectName={project.name}
                      onCreateBot={() => setBotProject(project.id)}
                      onManageBot={setCredentialBot}
                      queued={snap.queued ?? {}}
                      inbox={snap.inbox}
                      onOpen={onAgent}
                      confirmClear={confirmClear}
                      setConfirmClear={setConfirmClear}
                      onClear={onClear}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </aside>

      <main className="desk">
        {projects.length === 0 ? (
          <header className="desk-h">
            <div>
              <h1>No projects</h1>
              <p>Create one from the sidebar. The worktree on disk is never deleted.</p>
            </div>
          </header>
        ) : searching ? (
          <SearchDesk
            hiveName={projects.find((p) => p.slug === selectedProject)?.name ?? selectedProject}
            q={query.trim()}
            hits={hits}
            hasMore={hitsMore}
            busy={hitsBusy}
            onOpen={(hit) => {
              setQuery("");
              go({ kind: "channel", id: hit.channelId, thread: hit.threadId ?? undefined });
            }}
            onOlder={() => {
              const needle = hitsNeedleRef.current;
              const project = hitsProjectRef.current;
              const oldest = hits[hits.length - 1]?.seq;
              if (!needle || !project || !oldest) return;
              api
                .search(needle, project, oldest)
                .then((page) => {
                  if (hitsNeedleRef.current !== needle || hitsProjectRef.current !== project) return;
                  setHits((cur) => [...cur, ...page.hits.filter((h) => !cur.some((x) => x.seq === h.seq))]);
                  setHitsMore(page.hasMore);
                })
                .catch((e) => setErr(String(e.message || e)));
            }}
            onClear={() => setQuery("")}
          />
        ) : sel.kind === "decisions" ? (
          <DecisionQueue project={sel.project} tick={decisionTick}
            onOpen={decision => go({ kind: "channel", id: decision.channelId, thread: decision.id })} />
        ) : sel.kind === "inbox" ? (
          <Inbox
            box={inboxBox}
            mentions={inboxBox === "all" ? allForYou : inboxMentions}
            hasMore={inboxBox === "unread" && !inboxBusy && inboxPage?.project === sel.project && Boolean(inboxPage.hasMore)}
            channels={channels}
            agents={snap.agents.filter((a) => a.role === "human" || a.project === sel.project)}
            onBox={(box) => go({ kind: "inbox", project: sel.project, box })}
            onOpen={(m) =>
              go({ kind: "channel", id: m.channelId, thread: m.threadId ?? undefined })
            }
            onOlder={() => {
              const oldest = inboxMentions.at(-1)?.seq;
              if (!oldest || inboxBusy || !projects.some((p) => p.slug === sel.project)) return;
              const project = sel.project;
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
            }}
            onMarkSeen={() => {
              if (!projects.some((p) => p.slug === sel.project)) return;
              const ticket = readFence.current.ticket();
              api.markMentionsSeen(sel.project).then((page) => {
                if (!acceptRead(page.readState, ticket)) readRefresh.current?.request();
              }).catch((error) => setErr(String(error)));
            }}
          />
        ) : (
          <>
            <header className="desk-h">
              <div>
                <h1>{activeChannel ? channelTitle(activeChannel) : sel.id}</h1>
                {activeChannel?.topic && <p>{activeChannel.topic}</p>}
                {activeChannel && (
                  <p className="members">
                    {memberNames(activeChannel, snap.agents)}
                  </p>
                )}
              </div>
              {(activeChannel?.type === "private" || activeChannel?.type === "public") && (
                <button type="button" className="text-btn" onClick={() => setInviteOpen(true)}>
                  Invite
                </button>
              )}
            </header>
            {pane?.historyThrough !== undefined && (
              <button type="button" className="older" onClick={() => {
                const id = sel.id;
                setPane(null);
                loadChannel(id).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
              }}>
                {pane.deferredLive ? "New messages — return to live" : "Return to live"}
              </button>
            )}
            <div className="stream" ref={channelStream} onScroll={() => {
              if (isReadingHistory(channelStream.current)) setPane((current) => current ? holdLivePane(current) : current);
            }}>
              {activeChannel && ['private', 'public'].includes(activeChannel.type) && <RoomPanel key={activeChannel.id} channel={activeChannel} agents={snap.agents} tick={roomTick} />}
              {pane?.hasOlder && (
                <button
                  type="button"
                  className="older"
                  onClick={() => {
                    const oldest = pane.messages[0]?.seq;
                    if (!oldest || sel.kind !== "channel") return;
                    stickBottom.current = false;
                    setPane((current) => current ? holdLivePane(current) : current);
                    const channelId = sel.id;
                    loadChannel(channelId, oldest).catch((error) => {
                      if (error?.name !== "AbortError") setErr(String(error));
                    });
                  }}
                >
                  Load older
                </button>
              )}
              {(pane?.channel.id === selectedChannelId ? pane.messages : []).map((m) => (
                <Msg
                  key={m.id}
                  m={m}
                  replies={pane?.replyCounts[m.id] ?? 0}
                  status={pane?.threads.find((t) => t.id === m.id)?.status ?? null}
                  onThread={() => {
                    if (sel.kind !== "channel") return;
                    go({ kind: "channel", id: sel.id, thread: m.id });
                  }}
                  onReact={(emoji) => api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine)).then((r) => {
                    recordChannelMessage(channelJournal.current, r.message, false);
                    setPane((p) => applyChannelMessage(p, r.message, false));
                  })}
                />
              ))}
              <div ref={bottomRef} />
            </div>
            <Composer
              agents={roomAgents}
              value={draft}
              onChange={setDraft}
              placeholder={
                activeChannel
                  ? `Message ${channelTitle(activeChannel)}`
                  : "Write…"
              }
              onSend={(files) => send(draft, undefined, files)}
            />
          </>
        )}
        {err && (
          <div className="err" onClick={() => setErr(null)}>
            {err}
          </div>
        )}
      </main>

      {threadId && threadPane && sel.kind === "channel" && threadPane.channel.id === sel.id && threadPane.threadId === threadId && (
        <aside className="thread">
          <header className="desk-h">
            <div>
              <h1>Thread</h1>
              <p>replies on this message</p>
            </div>
            <div className="thread-tools">
              {threadPane.task ? <span className="st">{threadPane.task.state.replaceAll('_', ' ')}</span> : <select
                value={threadPane.threads.find((t) => t.id === threadId)?.status ?? "open"}
                onChange={(e) => {
                  const status = e.target.value as ThreadStatus;
                  const channelId = sel.id;
                  const root = threadId;
                  api.setStatus(root, status).then(({ thread }) => {
                    if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || threadIdRef.current !== root) return;
                    setThreadPane((current) => current?.threadId === root ? { ...current, threads: upsertById(current.threads, thread) } : current);
                  }).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
                }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>}
              <button
                type="button"
                className="plus"
                onClick={() => {
                  if (sel.kind === "channel") go({ kind: "channel", id: sel.id });
                  else setThreadId(null);
                }}
              >
                ×
              </button>
            </div>
          </header>
          {threadPane.historyThrough !== undefined && (
            <button type="button" className="older" onClick={() => {
              const channelId = sel.id;
              const root = threadId;
              setThreadView(null);
              loadThread(channelId, root).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
            }}>
              {threadPane.deferredLive ? "New replies — refresh thread" : "Refresh thread"}
            </button>
          )}
          <div className="stream" ref={threadStream} onScroll={() => {
            if (isReadingHistory(threadStream.current)) setThreadPane((current) => current ? holdLivePane(current) : current);
          }}>
            {threadPane.task && <TaskCard task={threadPane.task} decisions={threadPane.decisions} />}
            {threadPane.decision && <DecisionCard decision={threadPane.decision}
              onAnswered={() => {
                setDecisionTick(t => t + 1);
                loadThread(threadPane.decision!.channelId, threadPane.decision!.id).catch(() => undefined);
              }} />}
            {threadPane.hasOlder && (
              <button type="button" className="older" onClick={() => {
                const channelId = sel.id;
                const root = threadId;
                const before = threadPane.messages[0]?.seq;
                if (!before) return;
                setThreadPane((current) => current ? holdLivePane(current) : current);
                const load = threadLoad.current.begin();
                api.messages(channelId, root, before, load.signal).then((page) => {
                  if (!load.valid() || !viewingThread(channelId, root)) return;
                  setThreadPane((current) => current?.channel.id === channelId && current.threadId === root ? {
                    ...current, hasOlder: page.hasOlder,
                    cursors: { ...current.cursors, before: page.cursors?.before },
                    messages: [...page.messages, ...current.messages.filter((message) => !page.messages.some((old) => old.id === message.id))]
                      .sort((a, b) => a.seq - b.seq),
                  } : current);
                }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); });
              }}>
                Load earlier replies
              </button>
            )}
            {threadPane.messages.map((m) => (
              <Msg
                key={m.id}
                m={m}
                replies={0}
                status={null}
                onReact={(emoji) => api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine)).then((r) => onThreadMessage(r.message))}
              />
            ))}
            {threadPane.hasNewer && (
              <button type="button" className="older" onClick={() => {
                const channelId = sel.id;
                const root = threadId;
                const after = threadPane.cursors?.after ?? threadPane.messages.at(-1)?.seq;
                if (!after) return;
                const load = threadLoad.current.begin();
                api.messages(channelId, root, undefined, load.signal, after).then((page) => {
                  if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== channelId || threadIdRef.current !== root) return;
                  setThreadPane((current) => current?.channel.id === channelId && current.threadId === root ? {
                    ...current, hasNewer: page.hasNewer, cursors: page.cursors,
                    historyThrough: Math.max(current.historyThrough ?? 0, ...current.messages.map((message) => message.seq), ...page.messages.map((message) => message.seq)),
                    deferredLive: page.hasNewer ? current.deferredLive : false,
                    messages: [...current.messages, ...page.messages.filter((m) => !current.messages.some((x) => x.id === m.id))]
                      .sort((a, b) => a.seq - b.seq),
                  } : current);
                }).catch((error) => { if (load.valid() && error?.name !== "AbortError") setErr(String(error)); });
              }}>
                Load more replies
              </button>
            )}
            <div ref={threadBottomRef} />
          </div>
          <Composer
            agents={roomAgents}
            value={threadDraft}
            onChange={setThreadDraft}
            placeholder="Reply in thread…"
            onSend={(files) => send(threadDraft, threadId, files)}
          />
        </aside>
      )}

      {creating && (
        <div className="modal" onClick={() => setCreating(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              onCreate().catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>New channel</h2>
            <label>
              Name
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="frontend" autoFocus />
            </label>
            <label>
              Topic
              <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="optional" />
            </label>
            <label>
              Visibility
              <select value={newType} onChange={(e) => setNewType(e.target.value as "public" | "private")}>
                <option value="public">public — everyone</option>
                <option value="private">private — invited</option>
              </select>
            </label>
            {newType === "private" && (
              <fieldset className="checks">
                <legend>Members</legend>
                {snap.agents
                  .filter((a) => a.role !== "human" && (!createIn || a.project === createIn))
                  .map((a) => (
                  <label key={a.id} className="check">
                    <input
                      type="checkbox"
                      checked={newMembers.includes(a.name)}
                      onChange={(e) =>
                        setNewMembers((cur) =>
                          e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="row">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {botProject && projects.some((p) => p.id === botProject) && (
        <div className="modal">
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Create project bot">
            <h2>Create bot</h2>
            <BotSetup key={botProject} project={projects.find((p) => p.id === botProject)!}
              onBusy={setBotBusy} onCreated={() => { void refreshSnap().catch((e) => setErr(String(e.message || e))); }} />
            <div className="row"><button type="button" disabled={botBusy} onClick={() => setBotProject(null)}>Close</button></div>
          </div>
        </div>
      )}

      {credentialBot && snap.agents.some(a => a.id === credentialBot.id) && <div className="modal">
        <div className="sheet" role="dialog" aria-modal="true" aria-label={credentialBot.role === "bot" ? "Manage bot credentials" : "Manage agent credentials"}>
          <h2>{credentialBot.role === "bot" ? "Bot credentials" : "Agent credentials"}</h2>
          <BotCredentials key={credentialBot.id} bot={credentialBot} onBusy={setCredentialBusy} />
          <div className="row"><button type="button" disabled={credentialBusy} onClick={() => setCredentialBot(null)}>Close</button></div>
        </div>
      </div>}

      {inviteOpen && activeChannel && (
        <div className="modal" onClick={() => setInviteOpen(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .invite(activeChannel.id, inviteNames)
                .then(async () => {
                  setInviteOpen(false);
                  setInviteNames([]);
                  await refreshSnap();
                  if (sel.kind === "channel") await loadChannel(sel.id);
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Invite to #{activeChannel.name}</h2>
            <fieldset className="checks">
              <legend>Agents and bots</legend>
              {snap.agents
                .filter(
                  (a) =>
                    a.role !== "human" &&
                    a.project === activeChannel.project &&
                    !activeChannel.memberIds.includes(a.id),
                )
                .map((a) => (
                  <label key={a.id} className="check">
                    <input
                      type="checkbox"
                      checked={inviteNames.includes(a.name)}
                      onChange={(e) =>
                        setInviteNames((cur) =>
                          e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                        )
                      }
                    />
                    {a.name} · {a.role}
                  </label>
                ))}
            </fieldset>
            <div className="row">
              <button type="button" onClick={() => setInviteOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Invite
              </button>
            </div>
          </form>
        </div>
      )}

      {editingProject && (
        <div
          className="modal"
          onClick={() => {
            setEditingProject(null);
            setProjectDeleteConfirm("");
          }}
        >
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .updateProject(editingProject, {
                  name: newProjectName.trim(),
                  worktree: newProjectTree.trim() || null,
                })
                .then(async () => {
                  setEditingProject(null);
                  setProjectDeleteConfirm("");
                  await refreshSnap();
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Project {editingProject}</h2>
            <button type="button" className="text-btn" onClick={() => setPluginsProject(editingProject)}>Plugins…</button>
            <label>
              Name
              <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} autoFocus />
            </label>
            <label>
              Worktree
              <input value={newProjectTree} onChange={(e) => setNewProjectTree(e.target.value)} placeholder="absolute path" />
            </label>
            <p className="help-p">Join from this path, or pass project={editingProject}. Agents cannot see other projects.</p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setEditingProject(null);
                  setProjectDeleteConfirm("");
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
            <div className="danger-block">
              <p className="help-p">
                Deletes this hive (channels, mail, roster, Telegram map). Does not touch the worktree.
              </p>
              {editingBusy.length > 0 && (
                <p className="help-p">
                  Cannot delete while {editingBusy.map((a) => a.name).join(", ")}{" "}
                  {editingBusy.length === 1 ? "is" : "are"} still online or waiting.
                </p>
              )}
              <label>
                Type {editingProject} to delete
                <input
                  value={projectDeleteConfirm}
                  onChange={(e) => setProjectDeleteConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  autoComplete="off"
                />
              </label>
              <div className="row">
                <button
                  type="button"
                  className="danger"
                  disabled={!canDeleteProject}
                  onClick={() => {
                    setDeletingProject(true);
                    api
                      .deleteProject(editingProject)
                      .then(async () => {
                        setEditingProject(null);
                        setProjectDeleteConfirm("");
                        await refreshSnap();
                      })
                      .catch((ex) => setErr(String(ex.message || ex)))
                      .finally(() => setDeletingProject(false));
                  }}
                >
                  Delete project
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {pluginsProject && projects.some((p) => p.slug === pluginsProject) && (
        <ProjectPlugins key={pluginsProject} project={projects.find((p) => p.slug === pluginsProject)!}
          onClose={() => setPluginsProject(null)} />
      )}

      {creatingProject && (
        <div className="modal" onClick={() => setCreatingProject(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .createProject(newProjectName.trim(), newProjectSlug.trim() || undefined, newProjectTree.trim() || undefined)
                .then(async ({ project }) => {
                  setCreatingProject(false);
                  setNewProjectName("");
                  setNewProjectSlug("");
                  setNewProjectTree("");
                  await refreshSnap();
                  setOpenProjects((g) => ({ ...g, [project.slug]: true }));
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>New project</h2>
            <label>
              Name
              <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="Another" autoFocus />
            </label>
            <label>
              Slug
              <input value={newProjectSlug} onChange={(e) => setNewProjectSlug(e.target.value)} placeholder="altro" />
            </label>
            <label>
              Worktree
              <input value={newProjectTree} onChange={(e) => setNewProjectTree(e.target.value)} placeholder="absolute path" />
            </label>
            <div className="row">
              <button type="button" onClick={() => setCreatingProject(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {telegramOpen && telegram && (
        <div className="modal" onClick={() => setTelegramOpen(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const known = new Set(projects.map((p) => p.slug));
              const mapped: Record<string, { groupChatId: string }> = {};
              for (const [slug, raw] of Object.entries(tgGroups)) {
                if (!known.has(slug) || !raw.trim()) continue;
                mapped[slug] = { groupChatId: raw.trim() };
              }
              api
                .saveTelegram({
                  botToken: tgToken.trim() || undefined,
                  allowUserIds: tgUsers.split(/[,\s]+/).filter(Boolean),
                  projects: mapped,
                })
                .then((t) => {
                  setTelegram(t);
                  setTgToken("");
                  latestTelegramHealth.current = newerTelegramHealth(latestTelegramHealth.current, t);
                  setSnap((s) => (s ? { ...s, telegram: { running: t.running, configured: t.configured, ...latestTelegramHealth.current } } : s));
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Telegram</h2>
            <p className="help-p">
              One bot, one forum group per project. The bot needs admin and Manage Topics. {telegram.running ? "Bridge is on." : "Bridge is off."}
            </p>
            <label>
              Bot token
              <input
                type="password"
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
                placeholder={telegram.tokenHint ? `saved ${telegram.tokenHint}` : "from BotFather"}
                autoComplete="off"
              />
            </label>
            <label>
              Allowed user ids
              <input
                value={tgUsers}
                onChange={(e) => setTgUsers(e.target.value)}
                placeholder="123456789"
              />
            </label>
            {projects.map((p) => (
              <label key={p.id}>
                {p.name} group chat id
                <input
                  value={tgGroups[p.slug] ?? ""}
                  onChange={(e) => setTgGroups((cur) => ({ ...cur, [p.slug]: e.target.value }))}
                  placeholder="-100…"
                />
              </label>
            ))}
            <p className="help-p">Unmapped groups are ignored. Saved next to the hive db, never in git.</p>
            <div className="row">
              <button type="button" onClick={() => setTelegramOpen(false)}>
                Close
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {launchOpen && (
        <LaunchSheet
          projects={projects}
          agents={snap.agents}
          defaultProject={selectedProject}
          onClose={() => setLaunchOpen(false)}
        />
      )}

      {helpOpen && (
        <div className="modal" onClick={() => setHelpOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How to join</h2>
            <p className="help-p">
              You open Codex, Claude, or Cursor yourself, pick the model, then register that terminal. Hivemind never wakes a closed session. Or use Launch to copy a command plus prompt.
            </p>
            <pre>{`npx tsx src/cli.ts mcp-config
npx tsx src/cli.ts join --as brain
npx tsx src/cli.ts join --as worker --seniority senior
export HIVEMIND_TOKEN=hm_…
npx tsx src/cli.ts wait`}</pre>
            <p className="help-p">
              Workers talk to brains only. Brains ask @Human here. Click an agent to DM them — including workers.
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelItem({
  ch,
  unread,
  active,
  onClick,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`} onClick={onClick}>
      <span>{ch.type === "dm" ? ch.name : `# ${ch.name}`}</span>
      {unread > 0 && <em>{unread}</em>}
    </button>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSearchBody(body: string, q: string) {
  const tokens = parseSearchQuery(q).filter((token) => token.length > 0);
  if (tokens.length === 0) return renderBody(body);
  const re = new RegExp(tokens.map(escapeRegExp).join("|"), "gi");
  const parts: ReturnType<typeof renderBody> = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index === last && m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) parts.push(...renderBody(body.slice(last, m.index)));
    parts.push(
      <mark className="hit" key={`hit-${key++}`}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(...renderBody(body.slice(last)));
  return parts;
}

function SearchHitMsg({ hit, q }: { hit: SearchHit; q: string }) {
  const time = new Date(hit.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <article className={`msg role-${hit.authorRole} kind-${hit.kind}`}>
      <Avatar name={hit.authorName} role={hit.authorRole} />
      <div>
        <div className="msg-h">
          <strong>{hit.authorName}</strong>
          <span className="role">{hit.authorRole}</span>
          <time dateTime={new Date(hit.createdAt).toISOString()}>{time}</time>
          <span className="seq">#{hit.seq}</span>
        </div>
        {hit.body ? <div className="msg-b">{renderSearchBody(hit.body, q)}</div> : null}
        {hit.attachments.length > 0 && (
          <div className="atts">
            {hit.attachments.map((name) => (
              <span key={name} className="att-chip">
                {name}
              </span>
            ))}
          </div>
        )}
        {hit.reactions.length > 0 && (
          <div className="reacts">
            {hit.reactions.map((emoji) => (
              <span key={emoji} className="react">
                {emoji}
              </span>
            ))}
          </div>
        )}
        {!hit.body && hit.attachments.length === 0 && <div className="msg-b muted">(empty)</div>}
      </div>
    </article>
  );
}

export function SearchDesk({
  hiveName,
  q,
  hits,
  hasMore,
  busy,
  onOpen,
  onOlder,
  onClear,
}: {
  hiveName: string;
  q: string;
  hits: SearchHit[];
  hasMore: boolean;
  busy: boolean;
  onOpen: (hit: SearchHit) => void;
  onOlder: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>Search</h1>
          <p>
            {hiveName}
            {q ? ` · “${q}”` : ""}
          </p>
        </div>
        <button type="button" className="text-btn" onClick={onClear}>
          Clear
        </button>
      </header>
      <div className="stream">
        {hits.length === 0 && !busy && <div className="empty">No messages match in this hive.</div>}
        {busy && hits.length === 0 && <div className="empty">Searching…</div>}
        {hits.map((hit) => {
          const where = hit.channelType === "dm" ? hit.channelName : `#${hit.channelName}`;
          return (
            <div key={hit.seq} className="inbox-item">
              <button type="button" className="search-hit-open" onClick={() => onOpen(hit)}>
                <SearchHitMsg hit={hit} q={q} />
                <span className="open-link">
                  {where}
                  {hit.threadId ? " · open thread" : " · open conversation"}
                </span>
              </button>
              <BotOrigin event={hit.botEvent} />
            </div>
          );
        })}
        {hasMore && (
          <button type="button" className="older" onClick={onOlder}>
            Older matches
          </button>
        )}
      </div>
    </>
  );
}

function Inbox({
  box,
  mentions,
  hasMore,
  channels,
  agents,
  onBox,
  onOpen,
  onOlder,
  onMarkSeen,
}: {
  box: InboxBox;
  mentions: Message[];
  hasMore: boolean;
  channels: Channel[];
  agents: Agent[];
  onBox: (box: InboxBox) => void;
  onOpen: (message: Message) => void;
  onOlder: () => void;
  onMarkSeen: () => void;
}) {
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>For you</h1>
          <p>
            {box === "all"
              ? "Every @Human mention and brain DM this browser has seen, newest first."
              : "@Human mentions not marked seen. Brains ask you here when a cycle is done or when they are stuck."}
          </p>
          <div className="inbox-tabs" role="tablist">
            <button type="button" className={box === "unread" ? "on" : ""} onClick={() => onBox("unread")}>
              Unread
            </button>
            <button type="button" className={box === "all" ? "on" : ""} onClick={() => onBox("all")}>
              All
            </button>
          </div>
        </div>
        {box === "unread" && mentions.length > 0 && (
          <button type="button" className="text-btn" onClick={onMarkSeen}>
            Mark seen
          </button>
        )}
      </header>
      <div className="stream">
        {mentions.length === 0 && (
          <div className="empty">
            {box === "all"
              ? "Nothing in this browser log yet. New @Human mail and brain DMs collect here while the UI is open. Opening a conversation also adds it. Older seen mail is not available without a hive change."
              : "No mentions. When a brain needs you, it shows up here."}
          </div>
        )}
        {mentions.map((m) => {
          const ch = channels.find((c) => c.id === m.channelId);
          const where = ch ? (ch.type === "dm" ? ch.name : `#${ch.name}`) : "";
          return (
            <button key={m.id} className="inbox-item" onClick={() => onOpen(m)}>
              <Msg m={m} replies={0} status={null} />
              <span className="open-link">
                {where ? `${where} · ` : ""}
                {m.threadId ? "open thread" : "open conversation"}
              </span>
            </button>
          );
        })}
        {hasMore && (
          <button type="button" className="older" onClick={onOlder}>
            Older mentions
          </button>
        )}
      </div>
      <div className="hint">
        {agents.filter((a) => a.role !== "human").length === 0
          ? "Nobody in the hive yet. Open a Codex, Claude, or Cursor terminal and join."
          : "You set the goals. Brains dispatch. Workers execute."}
      </div>
    </>
  );
}

function Msg({
  m,
  replies,
  status,
  onThread,
  onReact,
}: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  onThread?: () => void;
  onReact?: (emoji: string) => void;
}) {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const placed = (m.reactions ?? []).filter((r) => r.count > 0);
  return (
    <article className={`msg role-${m.authorRole} kind-${m.kind}`}>
      <Avatar name={m.authorName} role={m.authorRole} />
      <div>
        <div className="msg-h">
          <strong>{m.authorName}</strong>
          <span className="role">{m.authorRole}</span>
          <time>{time}</time>
          {m.taskEvent && <span className="st">Task {m.taskEvent.action.type} · v{m.taskEvent.revision}</span>}
          {status && <span className={`st st-${status}`}>{status.replace("_", " ")}</span>}
        </div>
        {m.body && <div className="msg-b">{renderBody(m.body)}</div>}
        <BotOrigin event={m.botEvent} />
        {(m.attachments?.length ?? 0) > 0 && (
          <div className="atts">
            {m.attachments!.map((a) =>
              a.mime.startsWith("image/") ? (
                <a key={a.id} href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  <img className="att-img" src={api.fileUrl(a.id)} alt={a.name} />
                </a>
              ) : (
                <a key={a.id} className="att-chip" href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  {a.name}
                  <small>{Math.max(1, Math.round(a.bytes / 1024))} KB</small>
                </a>
              ),
            )}
          </div>
        )}
        {m.kind === "chat" && placed.length > 0 && (
          <div className="reacts">
            {placed.map((hit) => (
              <button
                key={hit.emoji}
                type="button"
                className={`react ${hit.mine ? "mine" : ""}`}
                disabled={!onReact}
                onClick={() => onReact?.(hit.emoji)}
              >
                {hit.emoji}
                <em>{hit.count}</em>
              </button>
            ))}
          </div>
        )}
        {onThread && m.kind === "chat" && (
          <button type="button" className="replies" onClick={onThread}>
            {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Thread"}
          </button>
        )}
        {m.kind === "chat" && onReact && (
          <div className="react-pick" role="toolbar" aria-label="Add reaction">
            {REACTION_EMOJIS.map((emoji) => {
              const hit = m.reactions?.find((r) => r.emoji === emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`react-pick-btn ${hit?.mine ? "mine" : ""}`}
                  title={emoji}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

function Composer({
  agents,
  value,
  onChange,
  onSend,
  placeholder,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  onSend: (files?: File[]) => void;
  placeholder: string;
}) {
  const [hint, setHint] = useState<Agent[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const names = useMemo(() => agents.filter((a) => a.role !== "bot"), [agents]);
  const pick = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)].slice(0, 4);
    setFiles(next);
  };

  const flush = () => {
    onSend(files);
    setFiles([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flush();
    }
  };

  const onInput = (v: string) => {
    onChange(v);
    const at = v.split(/\s/).pop() ?? "";
    if (at.startsWith("@") && at.length > 1) {
      const q = at.slice(1).toLowerCase();
      setHint(names.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 6));
    } else setHint([]);
  };

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {hint.length > 0 && (
        <ul className="hints">
          {hint.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(value.replace(/@\w*$/, `@${a.name} `));
                  setHint([]);
                }}
              >
                @{a.name}
                <small>{a.role}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name}
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <input
          ref={pick}
          type="file"
          hidden
          multiple
          accept="image/*,.pdf,.txt,.csv,.json,.zip"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className="clip" title="Attach" onClick={() => pick.current?.click()}>
          📎
        </button>
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((f): f is File => Boolean(f));
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        <button type="button" className="send" onClick={flush} disabled={!value.trim() && files.length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}

function avatarHue(name: string): number {
  return [...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 360;
}

function Avatar({ name, role, online, small }: { name: string; role?: string; online?: boolean; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? "sm" : ""} role-${role ?? ""}`}
      style={{ "--h": String(avatarHue(name)) } as CSSProperties}
      data-on={online ? "1" : undefined}
      title={name}
    >
      {name.slice(0, 2)}
    </span>
  );
}

export function AgentList({
  agents,
  projectName,
  onCreateBot,
  onManageBot,
  queued,
  inbox = {},
  onOpen,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  agents: Agent[];
  projectName: string;
  onCreateBot: () => void;
  onManageBot?: (a: Agent) => void;
  queued: Record<string, number>;
  inbox?: Record<string, InboxStatus>;
  onOpen: (a: Agent) => void;
  confirmClear: string | null;
  setConfirmClear: (n: string | null) => void;
  onClear: (n: string) => void;
}) {
  const human = agents.find((a) => a.role === "human");
  const brains = agents.filter((a) => a.role === "brain");
  const workers = agents.filter((a) => a.role === "worker");
  const bots = agents.filter((a) => a.role === "bot");
  const rank = { senior: 0, mid: 1, junior: 2 } as const;
  workers.sort((a, b) => (rank[a.seniority ?? "mid"] ?? 3) - (rank[b.seniority ?? "mid"] ?? 3) || a.name.localeCompare(b.name));

  return (
    <div className="agents">
      {human && <PersonRow agent={human} onOpen={() => undefined} self />}
      {brains.length > 0 && <div className="subh">brain</div>}
      {brains.map((a) => (
        <PersonRow key={a.id} agent={a} queued={queued[a.id] ?? 0} inbox={inbox[a.id]} onOpen={() => onOpen(a)} onManageCredential={onManageBot ? () => onManageBot(a) : undefined} />
      ))}
      {workers.length > 0 && <div className="subh">worker</div>}
      {workers.map((a) => (
        <PersonRow
          key={a.id}
          agent={a}
          queued={queued[a.id] ?? 0}
          inbox={inbox[a.id]}
          onOpen={() => onOpen(a)}
          confirmClear={confirmClear}
          setConfirmClear={setConfirmClear}
          onClear={onClear}
          onManageCredential={onManageBot ? () => onManageBot(a) : undefined}
        />
      ))}
      <div className="subh bot-h">
        <span>bot · context only</span>
        <button type="button" className="plus" title={`Create bot in ${projectName}`}
          aria-label={`Create bot in ${projectName}`} onClick={onCreateBot}>+</button>
      </div>
      {bots.map((a) => <div key={a.id}>
        <PersonRow agent={a} onOpen={() => undefined} self />
        {onManageBot && <button type="button" aria-label={`Manage credentials for ${a.name}`} onClick={() => onManageBot(a)}>Credentials</button>}
      </div>)}
      {brains.length + workers.length === 0 && (
        <p className="empty-mini">
          Open Codex, Claude, or Cursor, then <code>hivemind join --as brain</code> or{" "}
          <code>--as worker --seniority senior</code>
        </p>
      )}
    </div>
  );
}

function PersonRow({
  onManageCredential,
  agent,
  queued,
  inbox,
  onOpen,
  self,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  onManageCredential?: () => void;
  agent: Agent;
  queued?: number;
  inbox?: InboxStatus;
  onOpen: () => void;
  self?: boolean;
  confirmClear?: string | null;
  setConfirmClear?: (n: string | null) => void;
  onClear?: (n: string) => void;
}) {
  const bars = seniorityBars(agent);
  return (
    <div className={`person ${agent.online ? "on" : "off"}`}>
      <button type="button" className="person-main" onClick={onOpen} disabled={self}>
        <Avatar name={agent.name} role={agent.role} online={agent.online} small />
        <span className="pn">{agent.name}</span>
        {bars > 0 && (
          <span className="stripes" title={agent.seniority ?? ""}>
            {Array.from({ length: bars }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        )}
        {agent.seniority && <span className="sen">{agent.seniority}</span>}
        {agent.focus && <span className="focus">{agent.focus}</span>}
        <InboxReceipt status={inbox} />
        <QueueBadge count={queued} estimate={inbox?.queued} />
      </button>
      {onManageCredential && <button type="button" aria-label={`Manage credentials for ${agent.name}`} onClick={onManageCredential}>Credentials</button>}
      {agent.role === "worker" && setConfirmClear && onClear && (
        confirmClear === agent.name ? (
          <span className="clear-ask">
            <button type="button" onClick={() => onClear(agent.name)}>
              clear
            </button>
            <button type="button" onClick={() => setConfirmClear(null)}>
              no
            </button>
          </span>
        ) : (
          <button type="button" className="ghost" title="clear context" onClick={() => setConfirmClear(agent.name)}>
            ⌧
          </button>
        )
      )}
    </div>
  );
}
