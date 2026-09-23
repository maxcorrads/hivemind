import { Modal } from "./Modal.tsx";
import { createSendOperations } from "./send-operation.ts";
import { beginChannelJournal, recordChannelMessage, recordChannelConfirmation, recordChannelThread, applyChannelMessage, reconcileChannelSnapshot, type ChannelJournal } from "./channel-state.ts";
import { newerTelegramHealth, telegramDegraded, type TelegramHealth } from "./telegram-health.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Agent, Channel, Message, SearchHit, Thread, ThreadStatus, InboxStatus } from "../src/shared/types.ts";
import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import { parseHash, repairSel, setHash, type InboxBox, type Sel } from "./selection.ts";
import { STATUSES, channelTitle, memberNames, upsertById } from "./labels.ts";
import { AgentList } from "./AgentList.tsx";
import { ChannelItem, DmRow } from "./ChannelNav.tsx";
import { Composer } from "./Composer.tsx";
import { Inbox } from "./Inbox.tsx";
import { Msg } from "./Msg.tsx";
import { SearchDesk } from "./SearchDesk.tsx";
import { api, connectWs, type ChannelPayload, type Snapshot, type TelegramSettings, type SendRoutingMode, type SendLockScope } from "./api.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { BotSetup, BotCredentials } from "./Bots.tsx";
import { ProjectPlugins } from "./ProjectPlugins.tsx";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";
import { AdaptiveRoutingPanel, routingEventLabel, topologyLabel } from "./AdaptiveRoutingPanel.tsx";
import type { AdaptiveExecutionState, AdaptiveRoutingEvent } from "../src/shared/adaptive-topology.ts";
import { useAdaptiveRouting } from "./use-adaptive-routing.ts";
import { JevLog } from "./JevLog.tsx";
import { routingStreamEntries } from "./adaptive-routing-view.ts";
import { loadClosedDms, saveClosedDms } from "./closed-dms.ts";
import { loadMailLog, mergeMailLog, saveMailLog } from "./mail-log.ts";
import type { MentionPage, ReadSnapshot } from "../src/shared/read-state.ts";
import { createReadFence, createReadRefresh, createReceiptQueue, createRequestGate, readFields } from "../src/shared/read-client.ts";
import { holdLivePane, isReadingHistory } from "./pane-window.ts";
import { mergeConfirmations } from "./message-confirmations.ts";
import { TaskCard } from './TaskCard.tsx';
import { RoomPanel } from './RoomPanel.tsx';
import { DecisionCard, DecisionQueue } from './DecisionQueue.tsx';
import type { DecisionView } from '../src/shared/decisions.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import { selectThread, beginThreadLoad, cancelThreadLoad, failThreadLoad, receiveThreadConfirmation, receiveThreadMessage, receiveThreadTask, receiveThreadSnapshot, receiveThreadStatus, type ThreadView } from './thread-state.ts';

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
  const [routingMode, setRoutingMode] = useState<SendRoutingMode>("auto");
  const [routingLockScope, setRoutingLockScope] = useState<SendLockScope>("none");
  // Jev routes every Human message addressed to a brain, so any channel with a brain has routing state.
  const routingChannelId = sel.kind === "channel" && snap?.channels.some(channel => channel.id === sel.id &&
    channel.memberIds.some(id => snap.agents.some(agent => agent.id === id && agent.role === "brain"))) ? sel.id : null;
  const { view: routingView, error: routingError, refresh: refreshRoutingView,
    onEvent: onRoutingEvent, onChange: changeRoutingView } = useAdaptiveRouting(routingChannelId);
  const [routingPanelOpen, setRoutingPanelOpen] = useState(false);
  const [threadDraft, setThreadDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [roomTick, setRoomTick] = useState(0);
  const [decisionTick, setDecisionTick] = useState(0);
  const [jevTick, setJevTick] = useState(0);
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
  const [agentConfirm, setAgentConfirm] = useState<{ name: string; kind: "clear" | "remove" } | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  /** Project preselected in the Launch sheet when it is opened from a project's roster. */
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const openLaunch = (project: string | null = null) => { setLaunchProject(project); setLaunchOpen(true); };
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [adaptiveRoutingOpen, setAdaptiveRoutingOpen] = useState(false);
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
  const [closedDms, setClosedDms] = useState<string[]>(loadClosedDms);
  const [dmPicker, setDmPicker] = useState<string | null>(null);
  const [dmPickQ, setDmPickQ] = useState("");
  const [dmMenu, setDmMenu] = useState<string | null>(null);
  const stickBottom = useRef(true);
  const themePainted = useRef(false);
  const channelStream = useRef<HTMLDivElement>(null);
  const threadStream = useRef<HTMLDivElement>(null);
  const threadOpenAnchor = useRef<{
    channelId: string; threadId: string; button: HTMLButtonElement; bottom: number; atBottom: boolean;
  } | null>(null);
  const threadAnchorHold = useRef<{ channelId: string; threadId: string; release: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadBottomRef = useRef<HTMLDivElement>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const panesRef = useRef({ pane, threadPane });
  panesRef.current = { pane, threadPane };
  const channelsRef = useRef<Channel[]>([]);
  const threadLoadIdRef = useRef(0);

  const viewingThread = useCallback((channelId: string, root: string) =>
    selRef.current.kind === 'channel' && selRef.current.id === channelId && threadIdRef.current === root, []);

  const loadThread = useCallback(async (channelId: string, root: string, confirmed?: Message, returnToLive = !!confirmed) => {
    if (!viewingThread(channelId, root)) return;
    const requestId = ++threadLoadIdRef.current;
    const load = threadLoad.current.begin();
    setThreadView(view => beginThreadLoad(view, channelId, root, requestId, returnToLive, confirmed ? [confirmed] : []));
    try {
      const data = await api.messages(channelId, root, undefined, load.signal);
      if (load.valid() && viewingThread(channelId, root)) setThreadView(view => receiveThreadSnapshot(view, root, data, requestId));
    } catch (error) {
      if (load.valid() && viewingThread(channelId, root) && requestId === threadLoadIdRef.current) {
        setThreadView(view => failThreadLoad(view, requestId));
        setErr("Thread could not refresh. Refresh thread to retry.");
        throw error;
      }
    }
  }, [viewingThread]);

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

  const readFence = useRef(createReadFence());
  const channelLoad = useRef(createRequestGate());
  const channelJournal = useRef<ChannelJournal | null>(null);
  const channelRefreshIntent = useRef<{ channelId: string; confirmations: Message[] } | null>(null);
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
      channelRefreshIntent.current = null;
      channelReads.current?.reset();
    }
    if (priorChannel !== nextChannel || threadIdRef.current !== nextThread) {
      threadLoad.current.cancel();
      setThreadView(null);
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

  const loadChannel = useCallback(async (id: string, before?: number, confirmed?: Message[]) => {
    // A replacement/reconnect GET must not silently cancel the Human's pending
    // return-to-live. Explicit older-page navigation and selection changes can.
    if (before !== undefined) channelRefreshIntent.current = null;
    else if (confirmed) {
      const previous = channelRefreshIntent.current;
      channelRefreshIntent.current = { channelId: id, confirmations: mergeConfirmations(
        previous?.channelId === id ? previous.confirmations : [], confirmed,
      ) };
    }
    const intent = channelRefreshIntent.current?.channelId === id ? channelRefreshIntent.current : null;
    const load = channelLoad.current.begin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const journal = beginChannelJournal(id, intent?.confirmations);
      channelJournal.current = journal;
      try {
        const data = await api.messages(id, null, before, load.signal);
        if (!load.valid() || selRef.current.kind !== "channel" || selRef.current.id !== id) return;
        if (journal.overflow) {
          if (attempt < 2) continue;
          throw new Error("Live traffic overtook the channel refresh. Reload the page to retry.");
        }
        setPane((current) => reconcileChannelSnapshot(current, data, journal, before !== undefined, !!intent));
        if (channelRefreshIntent.current === intent) channelRefreshIntent.current = null;
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
    refreshRoutingView(true);
    readFence.current.reset();
    channelLoad.current.cancel();
    channelJournal.current = null;
    threadLoad.current.cancel();
    inboxLoad.current.cancel();
    channelReads.current?.reset();
    threadReads.current?.reset();
    setReconnectTick((value) => value + 1);
    refreshSnap().catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
  }, [refreshSnap, refreshRoutingView]);

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
      if (ev.type === "jev-call") {
        if (selRef.current.kind === "jev") setJevTick(t => t + 1);
        return;
      }
      if (ev.type === "adaptive-routing") {
        onRoutingEvent(ev.payload as { channelId: string; event: AdaptiveRoutingEvent; state: AdaptiveExecutionState | null });
        return;
      }
      if (ev.type === "message") {
        const msg = ev.payload as Message;
        recordChannelMessage(channelJournal.current, msg);
        setPane((p) => applyChannelMessage(p && isReadingHistory(channelStream.current) ? holdLivePane(p) : p, msg));
        onThreadMessage(msg);
        readFence.current.observe(msg.seq);
        readRefresh.current?.request();
        setClosedDms((ids) => {
          if (!ids.includes(msg.channelId)) return ids;
          const next = ids.filter((id) => id !== msg.channelId);
          saveClosedDms(next);
          return next;
        });
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
    if (sel.kind !== "channel") return;
    setClosedDms((ids) => {
      if (!ids.includes(sel.id)) return ids;
      const next = ids.filter((id) => id !== sel.id);
      saveClosedDms(next);
      return next;
    });
  }, [sel]);

  useEffect(() => {
    if (!dmPicker && !dmMenu) return;
    const onDoc = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      const el = e.target as HTMLElement;
      if (el.closest(".dm-picker") || el.closest(".dm-row") || el.closest("[data-dm-open]")) return;
      setDmPicker(null);
      setDmMenu(null);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [dmPicker, dmMenu]);

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

  // Reflow happens before scroll events: keep a live pane pinned when the side
  // thread opens, even when the bounded message window keeps the same length.
  const threadVisible = !!threadPane;
  useLayoutEffect(() => {
    const stream = channelStream.current;
    const anchor = threadOpenAnchor.current;
    const hold = threadAnchorHold.current;
    if (hold && (hold.channelId !== selectedChannelId || hold.threadId !== threadId)) hold.release();
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
      // Late reflow (a web font swapping in, an image decoding) re-wraps the
      // messages after this first correction: keep the anchor briefly and
      // re-apply it until the layout settles or the user scrolls on their own.
      threadAnchorHold.current?.release();
      const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(correct);
      resize?.observe(stream);
      for (const child of Array.from(stream.children)) resize?.observe(child);
      const fonts = document.fonts as FontFaceSet | undefined;
      const userScroll = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      const timer = window.setTimeout(() => release(), 2_000);
      const release = () => {
        window.clearTimeout(timer);
        resize?.disconnect();
        fonts?.removeEventListener?.("loadingdone", correct);
        for (const type of userScroll) stream.removeEventListener(type, release);
        if (threadAnchorHold.current?.release === release) threadAnchorHold.current = null;
      };
      fonts?.addEventListener?.("loadingdone", correct);
      for (const type of userScroll) stream.addEventListener(type, release, { passive: true });
      threadAnchorHold.current = { channelId: anchor.channelId, threadId: anchor.threadId, release };
    } else if (stickBottom.current && pane?.historyThrough === undefined && stream) {
      stream.scrollTop = stream.scrollHeight;
    }
    stickBottom.current = true;
  }, [pane, threadVisible, selectedChannelId, threadId, threadPane?.threadId]);
  useEffect(() => () => threadAnchorHold.current?.release(), []);
  useLayoutEffect(() => {
    if (threadPane?.historyThrough === undefined && threadStream.current)
      threadStream.current.scrollTop = threadStream.current.scrollHeight;
  }, [threadPane]);

  useEffect(() => {
    if (!snap) return;
    setMailLog((prev) => {
      const next = mergeMailLog(prev, snap.mentions, channelsRef.current);
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
  const activeBrainChannel = Boolean(activeChannel?.memberIds.some(
    id => snap?.agents.some(agent => agent.id === id && agent.role === "brain"),
  ));
  const brainNames = Object.fromEntries((snap?.agents ?? []).filter(agent => agent.role === "brain").map(agent => [agent.id, agent.name]));
  const activeExecutions = (routingView?.executions ?? []).filter(item => item.channelId === activeChannel?.id && !item.completedAt).length;
  useEffect(() => { setRoutingPanelOpen(false); }, [activeChannel?.id]);
  const selectedProject =
    sel.kind === "inbox" || sel.kind === "decisions" || sel.kind === "jev" ? sel.project : (activeChannel?.project ?? projects[0]?.slug ?? "chapter");
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
  const send = async (body: string, tid?: string | null, files?: File[], routing: SendRoutingMode = "auto",
    lockScope: SendLockScope = "none") => {
    if (sel.kind !== "channel") return;
    const channelId = sel.id;
    const root = tid ?? null;
    if (!body.trim() && !files?.length) return;
    const result = await sendOperations.current(channelId, body.trim(), root, files, routing, lockScope);
    if (selRef.current.kind !== "channel" || selRef.current.id !== channelId || (root && threadIdRef.current !== root)) return;
    const sentPane = root ? panesRef.current.threadPane : panesRef.current.pane;
    const returnToLive = sentPane?.historyThrough !== undefined || isReadingHistory(root ? threadStream.current : channelStream.current);
    if (root) setThreadDraft((current) => current === body ? "" : current);
    else {
      setDraft((current) => current === body ? "" : current);
      setRoutingMode("auto");
      setRoutingLockScope("none");
    }
    // One directive per owning brain precedes the request.
    const routingMessages = result.routingMessages ?? (result.routingMessage ? [result.routingMessage] : []);
    for (const routingMessage of routingMessages) {
      recordChannelConfirmation(channelJournal.current, routingMessage);
      setPane((current) => applyChannelMessage(current, routingMessage));
    }
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
        else await loadChannel(channelId, undefined, [...routingMessages, result.message]);
      } catch (error) {
        setErr(`Message sent, but the conversation could not refresh. Return to live to retry. ${String(error)}`);
      }
    }
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

  const hideDm = (ch: Channel) => {
    setClosedDms((ids) => {
      if (ids.includes(ch.id)) return ids;
      const next = [...ids, ch.id];
      saveClosedDms(next);
      return next;
    });
    setDmMenu(null);
    if (sel.kind === "channel" && sel.id === ch.id) {
      go({ kind: "inbox", project: ch.project });
    }
  };

  const showDm = (ch: Channel) => {
    setClosedDms((ids) => {
      if (!ids.includes(ch.id)) return ids;
      const next = ids.filter((id) => id !== ch.id);
      saveClosedDms(next);
      return next;
    });
    setDmPicker(null);
    setDmPickQ("");
    go({ kind: "channel", id: ch.id });
  };

  const onAgent = async (agent: Agent) => {
    if (agent.id === "human") return;
    const { channel } = await api.openDm(agent.name);
    setClosedDms((ids) => {
      if (!ids.includes(channel.id)) return ids;
      const next = ids.filter((id) => id !== channel.id);
      saveClosedDms(next);
      return next;
    });
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
  };

  const onAgentConfirm = async () => {
    if (!agentConfirm) return;
    setAgentBusy(true);
    try {
      if (agentConfirm.kind === "clear") await api.clearContext(agentConfirm.name);
      else await api.removeAgent(agentConfirm.name);
      setAgentConfirm(null);
      await refreshSnap();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setAgentBusy(false);
    }
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
            <details className="tools-menu" onClick={event => {
              if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false;
            }}>
              <summary title="Settings and tools">Settings</summary>
              <div className="tools-popover">

            <button
              type="button"
              className="tool-action"
              title={theme === "dark" ? "Light" : "Dark"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
            <button
              type="button"
              className="tool-action"
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
              Telegram{telegramDegraded(snap.telegram) ? " · Needs attention" : ""}
            </button>
            <button
              type="button"
              className="tool-action"
              title="Adaptive routing"
              onClick={() => setAdaptiveRoutingOpen(true)}
            >
              Adaptive routing
            </button>
            <button type="button" className="tool-action" title="Launch agent" onClick={() => openLaunch()}>
              Launch agent
            </button>
            <button type="button" className="tool-action" title="How to join" onClick={() => setHelpOpen(true)}>
              Help
            </button>
              </div>
            </details>
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
          placeholder="Search projects and messages" aria-label="Search projects and messages"
        />
        {projects.length > 0 && (
          <button type="button" className="launch-cta" onClick={() => openLaunch()}>
            <span aria-hidden="true">+</span> Launch agent
          </button>
        )}

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
          const projectDms = channels.filter((c) => c.project === project.slug && c.type === "dm" && match(c.name));
          const openDms = projectDms
            .filter((c) => !closedDms.includes(c.id))
            .sort((a, b) => {
              const unreadDelta = (snap.unread[b.id] ?? 0) - (snap.unread[a.id] ?? 0);
              if (unreadDelta) return unreadDelta;
              const mine = Number(!a.memberIds.includes("human")) - Number(!b.memberIds.includes("human"));
              if (mine) return mine;
              return a.name.localeCompare(b.name);
            });
          const hiddenDms = projectDms
            .filter((c) => closedDms.includes(c.id))
            .filter((c) => !dmPickQ.trim() || c.name.toLowerCase().includes(dmPickQ.trim().toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name));
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
                  <button
                    className={`nav ${sel.kind === "jev" && sel.project === project.slug ? "active" : ""}`}
                    onClick={() => go({ kind: "jev", project: project.slug })}
                    title="Every request Hivemind sent to Jev (TypeSafe) and its answer"
                  >
                    <span>Routing log</span>
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
                      <button
                        type="button"
                        className="plus"
                        data-dm-open={project.slug}
                        title="Open a conversation"
                        onClick={() => {
                          setDmMenu(null);
                          setDmPickQ("");
                          setDmPicker((cur) => (cur === project.slug ? null : project.slug));
                        }}
                      >
                        +
                      </button>
                    </div>
                    {dmPicker === project.slug && (
                      <div className="dm-picker">
                        <input
                          autoFocus
                          value={dmPickQ}
                          onChange={(e) => setDmPickQ(e.target.value)}
                          placeholder="Find a closed conversation"
                        />
                        {hiddenDms.length === 0 && (
                          <div className="empty-mini">
                            {projectDms.some((c) => closedDms.includes(c.id))
                              ? "No match."
                              : "Nothing closed. Close a DM from its ··· menu."}
                          </div>
                        )}
                        {hiddenDms.map((ch) => (
                          <button
                            key={ch.id}
                            type="button"
                            className="nav"
                            onClick={() => showDm(ch)}
                          >
                            <span>{ch.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="subh">With you</div>
                    {!openDms.some(ch => ch.memberIds.includes("human")) && <p className="empty-mini">No conversations yet.</p>}
                    {openDms.filter(ch => ch.memberIds.includes("human")).map((ch) => (
                      <DmRow
                        key={ch.id}
                        ch={ch}
                        unread={snap.unread[ch.id] ?? 0}
                        active={sel.kind === "channel" && sel.id === ch.id}
                        menuOpen={dmMenu === ch.id}
                        onClick={() => go({ kind: "channel", id: ch.id })}
                        onMenu={() => setDmMenu((cur) => (cur === ch.id ? null : ch.id))}
                        onClose={() => hideDm(ch)}
                      />
                    ))}
                    <details className="agent-conversations" open={q || (sel.kind === "channel" && openDms.some(ch => ch.id === sel.id && !ch.memberIds.includes("human"))) ? true : undefined}>
                      <summary>Between agents <span>{openDms.filter(ch => !ch.memberIds.includes("human")).length}</span></summary>
                      {openDms.filter(ch => !ch.memberIds.includes("human")).map((ch) => (
                      <DmRow
                        key={ch.id}
                        ch={ch}
                        unread={snap.unread[ch.id] ?? 0}
                        active={sel.kind === "channel" && sel.id === ch.id}
                        menuOpen={dmMenu === ch.id}
                        onClick={() => go({ kind: "channel", id: ch.id })}
                        onMenu={() => setDmMenu((cur) => (cur === ch.id ? null : ch.id))}
                        onClose={() => hideDm(ch)}
                      />
                    ))}
                    </details>
                  </div>
                  <div className="group">
                    <div className="group-h">
                      <span>Hive</span>
                    </div>
                    <AgentList
                      agents={hiveAgents}
                      projectName={project.name}
                      onCreateBot={() => setBotProject(project.id)}
                      onLaunch={() => openLaunch(project.slug)}
                      onManageBot={setCredentialBot}
                      queued={snap.queued ?? {}}
                      inbox={snap.inbox}
                      onOpen={onAgent}
                      onAskClear={(name) => setAgentConfirm({ name, kind: "clear" })}
                      onAskRemove={(name) => setAgentConfirm({ name, kind: "remove" })}
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
        ) : sel.kind === "jev" ? (
          <JevLog project={sel.project} tick={jevTick}
            channelLabel={id => { const channel = channels.find(item => item.id === id); return channel ? channelTitle(channel) : "Deleted channel"; }}
            agentName={id => snap.agents.find(agent => agent.id === id)?.name ?? "Removed brain"}
            onOpenChannel={id => go({ kind: "channel", id })} />
        ) : sel.kind === "decisions" ? (
          <DecisionQueue project={sel.project} tick={decisionTick}
            onOpen={decision => go({ kind: "channel", id: decision.channelId, thread: decision.id })} />
        ) : sel.kind === "inbox" ? (
          <Inbox
            key={`${sel.project}:${inboxBox}`}
            onDecisions={() => go({ kind: "decisions", project: sel.project })}
            onMarkMessage={async (message) => {
              const project = sel.project;
              const ticket = readFence.current.ticket();
              const read = await api.markMessagesSeen(message.channelId, message.threadId, [message.seq]);
              if (acceptRead(read, ticket)) {
                setInboxPage(previous => previous?.project === project ? {
                  ...previous, messages: previous.messages.filter(item => item.id !== message.id),
                } : previous);
              } else readRefresh.current?.request();
            }}
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
                loadChannel(id, undefined, []).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
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
              {routingStreamEntries(pane?.channel.id === selectedChannelId ? pane.messages : [],
                routingView?.events ?? [], selectedChannelId ?? "").map(entry => entry.kind === "routing" ? (
                <div key={entry.event.id} className="routing-inline" data-human-only="routing">
                  {routingEventLabel(entry.event)}
                </div>
              ) : ((m) => (
                <Msg
                  key={m.id}
                  m={m}
                  replies={pane?.replyCounts[m.id] ?? 0}
                  status={pane?.threads.find((t) => t.id === m.id)?.status ?? null}
                  onThread={(button) => {
                    if (sel.kind !== "channel") return;
                    const stream = channelStream.current;
                    if (stream && threadPane?.threadId !== m.id) {
                      threadOpenAnchor.current = {
                        channelId: sel.id, threadId: m.id, button, bottom: button.getBoundingClientRect().bottom,
                        atBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 48,
                      };
                    }
                    go({ kind: "channel", id: sel.id, thread: m.id });
                  }}
                  onReact={(emoji) => api.react(m.seq, emoji, !m.reactions?.some(reaction => reaction.emoji === emoji && reaction.mine)).then((r) => {
                    recordChannelMessage(channelJournal.current, r.message, false);
                    setPane((p) => applyChannelMessage(p, r.message, false));
                  })}
                />
              ))(entry.message))}
              <div ref={bottomRef} />
            </div>
            {activeBrainChannel && routingView && routingView.state && routingView.state.channelId === activeChannel?.id && (
              <div className={`routing-strip ${routingView.state.warning ? "warning" : ""}`}>
                <button type="button" onClick={() => setRoutingPanelOpen(true)}>
                  <strong>{topologyLabel(routingView.state.currentTopology)}</strong>
                  {routingView.state.workerBudget > 0
                    ? ` · ${routingView.state.workerBudget} worker${routingView.state.workerBudget === 1 ? "" : "s"}`
                    : ""}
                  {routingView.state.lockScope !== "none" ? ` · locked ${routingView.state.lockScope}` : ""}
                  {activeExecutions > 1 ? ` · ${brainNames[routingView.state.brainId] ?? "brain"} · ${activeExecutions} brains` : ""}
                </button>
                <span>
                  {routingView.state.monitoring === "completed" ? "Execution completed" : routingView.state.monitoring === "disabled"
                    ? "Jev disabled · automatic verification is off" : routingView.state.monitoring === "pending"
                    ? "Jev enabled · awaiting next coordination event" : routingView.state.warning
                    ? `⚠ ${routingView.state.warning}`
                    : (() => {
                        const last = [...routingView.events].reverse().find(event => event.kind === "transition");
                        return last ? routingEventLabel(last) : "Jev continuous routing active";
                      })()}
                </span>
              </div>
            )}
            <Composer
              agents={roomAgents}
              value={draft}
              onChange={setDraft}
              placeholder={
                activeChannel
                  ? `Message ${channelTitle(activeChannel)}`
                  : "Write…"
              }
              routing={activeBrainChannel ? {
                value: routingMode,
                onChange: setRoutingMode,
                lockScope: routingLockScope,
                onLockScopeChange: setRoutingLockScope,
              } : undefined}
              onSend={(files) => send(
                draft,
                undefined,
                files,
                activeBrainChannel ? routingMode : "auto",
                activeBrainChannel ? routingLockScope : "none",
              )}
            />
          </>
        )}
        {routingError && activeBrainChannel && <div className="err" role="alert">Routing status unavailable: {routingError}</div>}
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
              loadThread(channelId, root, undefined, true).catch((error) => { if (error?.name !== "AbortError") setErr(String(error)); });
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
                setThreadView(cancelThreadLoad);
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
                setThreadView(cancelThreadLoad);
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
        <Modal onClose={() => setCreating(false)}>
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
        </Modal>
      )}

      {botProject && projects.some((p) => p.id === botProject) && (
        <Modal onClose={() => { if (!botBusy) setBotProject(null); }}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Create project bot">
            <h2>Create bot</h2>
            <BotSetup key={botProject} project={projects.find((p) => p.id === botProject)!}
              onBusy={setBotBusy} onCreated={() => { void refreshSnap().catch((e) => setErr(String(e.message || e))); }} />
            <div className="row"><button type="button" disabled={botBusy} onClick={() => setBotProject(null)}>Close</button></div>
          </div>
        </Modal>
      )}

      {credentialBot && snap.agents.some(a => a.id === credentialBot.id) && <Modal onClose={() => { if (!credentialBusy) setCredentialBot(null); }}>
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Manage bot credentials">
          <h2>Bot credentials</h2>
          <BotCredentials key={credentialBot.id} bot={credentialBot} onBusy={setCredentialBusy} />
          <div className="row"><button type="button" disabled={credentialBusy} onClick={() => setCredentialBot(null)}>Close</button></div>
        </div>
      </Modal>}

      {inviteOpen && activeChannel && (
        <Modal onClose={() => setInviteOpen(false)}>
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
        </Modal>
      )}

      {editingProject && (
        <Modal onClose={() => {
            setEditingProject(null);
            setProjectDeleteConfirm("");
          }}>
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
        </Modal>
      )}

      {pluginsProject && projects.some((p) => p.slug === pluginsProject) && (
        <ProjectPlugins key={pluginsProject} project={projects.find((p) => p.slug === pluginsProject)!}
          onClose={() => setPluginsProject(null)} />
      )}

      {creatingProject && (
        <Modal onClose={() => setCreatingProject(false)}>
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
        </Modal>
      )}

      {adaptiveRoutingOpen && (
        <AdaptiveRoutingSettings onClose={() => setAdaptiveRoutingOpen(false)} onSaved={() => refreshRoutingView()} />
      )}

      {routingPanelOpen && activeChannel && routingView && (
        <AdaptiveRoutingPanel
          channelId={activeChannel.id}
          view={routingView}
          brainNames={brainNames}
          onChange={changeRoutingView}
          onClose={() => setRoutingPanelOpen(false)}
        />
      )}

      {telegramOpen && telegram && (
        <Modal onClose={() => setTelegramOpen(false)}>
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
            <div className="sheet-body">
            <p className="config-status">{telegram.configured ? "Configured" : "Not configured"} · {telegram.running ? "Connected" : "Bridge is off"}</p>
            <h3>Connection</h3>
            <p className="help-p">Connect a bot with admin and Manage Topics permissions.</p>
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
            <details className="settings-disclosure"><summary>Project groups ({projects.filter(p => telegram.projects[p.slug] != null).length}/{projects.length} configured)</summary>
            <p className="help-p">Assign one forum group to each project you want to connect.</p>
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
            </details>
            <p className="help-p">Unmapped groups are ignored. Saved next to the hive db, never in git.</p>
            </div>
            <div className="row">
              <button type="button" onClick={() => setTelegramOpen(false)}>
                Close
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}

      {launchOpen && (
        <LaunchSheet
          projects={projects}
          agents={snap.agents}
          defaultProject={launchProject ?? selectedProject}
          onClose={() => { setLaunchOpen(false); setLaunchProject(null); }}
        />
      )}

      {agentConfirm && (
        <Modal onClose={() => !agentBusy && setAgentConfirm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {agentConfirm.kind === "clear" ? (
              <>
                <h2>Clear context</h2>
                <p className="help-p">
                  {agentConfirm.name} discards task memory, keeps identity and standing orders, then waits. They stay
                  in the hive.
                </p>
                <div className="row">
                  <button type="button" onClick={() => setAgentConfirm(null)} disabled={agentBusy}>
                    Cancel
                  </button>
                  <button type="button" className="primary" onClick={onAgentConfirm} disabled={agentBusy}>
                    Clear context
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Remove {agentConfirm.name}</h2>
                <p className="help-p">
                  Takes {agentConfirm.name} off the roster. Messages stay. They cannot come back with that name unless
                  they join again as someone new.
                </p>
                <div className="row">
                  <button type="button" onClick={() => setAgentConfirm(null)} disabled={agentBusy}>
                    Cancel
                  </button>
                  <button type="button" className="danger" onClick={onAgentConfirm} disabled={agentBusy}>
                    Remove
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {helpOpen && (
        <Modal onClose={() => setHelpOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How to join</h2>
            <p className="help-p">
              You open Codex, Claude, or Cursor yourself and pick the model; Hivemind never wakes a closed session.
              The quickest path is <strong>Launch agent</strong>: it copies a command and prompt for a new brain or worker.
            </p>
            <p className="help-p">
              Agents join through the Hivemind MCP server and call <code>join</code>. There is no token to copy or keep:
              to bring an agent back, join again with <code>resume=NAME</code> and it picks up its queued work.
            </p>
            <pre>{`npx tsx src/cli.ts mcp-config   # add the MCP server to your agent host
join role=brain                  # in the agent: a new brain
join role=worker seniority=senior resume=Forge   # in the agent: come back as Forge`}</pre>
            <p className="help-p">
              Workers only start conversations with brains; you can DM anyone. Brains ask @Human here.
            </p>
            <div className="row">
              <button type="button" onClick={() => { setHelpOpen(false); openLaunch(); }}>
                Launch agent
              </button>
              <button type="button" className="primary" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
