import { useEffect, useRef, useState } from "react";
import type { Agent } from "../src/shared/types.ts";
import type { TaskOverview } from "../src/shared/task-views.ts";
import { AdaptiveRoutingPanel } from "./AdaptiveRoutingPanel.tsx";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";
import { api } from "./api.ts";
import { ChannelDesk } from "./ChannelDesk.tsx";
import { CreateChannelSheet, InviteSheet } from "./ChannelSheets.tsx";
import { useDesktopNotifications } from "./desktop-notifications.ts";
import { AgentConfirmSheet, HelpSheet } from "./HiveSheets.tsx";
import { AgentPanel } from './AgentPanel.tsx';
import { Inbox } from "./Inbox.tsx";
import { JevLog } from "./JevLog.tsx";
import { channelTitle } from "./labels.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { LaunchRequests, useLaunchRequests } from "./LaunchRequests.tsx";
import { channelBack, mobileScreen, mobileTab, tabTarget, useMobile } from "./mobile-nav.ts";
import { MobileDms, MobileTabs, projectDms } from "./MobileNav.tsx";
import { useNativeBridge } from "./native-bridge.ts";
import { attentionTotal, documentTitle, loadSelectedProject, projectLanding, saveProjectView, saveSelectedProject, type SwitchItem } from "./nav-model.ts";
import { ProjectBots } from "./ProjectBots.tsx";
import { WorkerTemplatesSheet } from "./WorkerTemplates.tsx";
import { ProjectRail } from "./ProjectRail.tsx";
import { CreateProjectSheet, ProjectSettingsSheet } from "./ProjectSheets.tsx";
import { QuickSwitcher } from "./QuickSwitcher.tsx";
import { SearchDesk } from "./SearchDesk.tsx";
import { hashFor, type Sel } from "./selection.ts";
import { Sidebar } from "./Sidebar.tsx";
import { newerTelegramHealth } from "./telegram-health.ts";
import { TelegramSheet } from "./TelegramSheet.tsx";
import { TaskViews } from "./TaskViews.tsx";
import { ThreadAside } from "./ThreadAside.tsx";
import { ThreadResizer } from "./ThreadResizer.tsx";
import { TopBar } from "./TopBar.tsx";
import { useAdaptiveRouting } from "./use-adaptive-routing.ts";
import { useChannelPane } from "./use-channel-pane.ts";
import { useConversationLoads } from "./use-conversation-loads.ts";
import { useDmNav } from "./use-dm-nav.ts";
import { useHiveSnapshot } from "./use-hive-snapshot.ts";
import { useInbox } from "./use-inbox.ts";
import { useLayout } from "./use-layout.ts";
import { useRealtime } from "./use-realtime.ts";
import { useSearch } from "./use-search.ts";
import { useChangeSelection, useSelection, useSelectionRepair } from "./use-selection.ts";
import { useSend } from "./use-send.ts";
import { useAgentConfirm, useChannelSheets, useProjectSheets, useTelegramSheet } from "./use-sheets.ts";
import { useTheme } from "./use-theme.ts";
import { useThreadPane } from "./use-thread-pane.ts";
import { useThreadScrollAnchor } from "./use-thread-scroll-anchor.ts";
import { useUnreadJump } from "./use-unread-jump.ts";

export function App() {
  // Hook order is effect order: the read queues (useHiveSnapshot) exist before
  // the first snapshot and WebSocket (useRealtime), which start before the
  // channel and thread loads (useConversationLoads).
  const [err, setErr] = useState<string | null>(null);
  const selection = useSelection();
  const { sel, threadId, setThreadId, selRef } = selection;
  const hive = useHiveSnapshot(setErr);
  const { snap, setSnap, refreshSnap, latestTelegramHealth } = hive;
  // Jev advises on every Human message addressed to a brain, so any channel with a brain has advice state.
  const routingChannelId = sel.kind === "channel" && snap?.channels.some(channel => channel.id === sel.id &&
    channel.memberIds.some(id => snap.agents.some(agent => agent.id === id && agent.role === "brain"))) ? sel.id : null;
  const { view: routingView, refresh: refreshRoutingView,
    onEvent: onRoutingEvent } = useAdaptiveRouting(routingChannelId);
  const [routingPanelOpen, setRoutingPanelOpen] = useState(false);
  const channelPane = useChannelPane(selRef, selection.unreadLookup);
  const threadState = useThreadPane(selection, setErr);
  const { pane } = channelPane;
  const { threadPane } = threadState;
  const dms = useDmNav(sel);

  const channels = snap?.channels ?? [];
  const projects = snap?.projects ?? [];
  const activeChannel = sel.kind === "channel" ? channels.find((c) => c.id === sel.id) : undefined;
  const activeBrainChannel = Boolean(activeChannel?.memberIds.some(
    id => snap?.agents.some(agent => agent.id === id && agent.role === "brain"),
  ));
  const brainNames = Object.fromEntries((snap?.agents ?? []).filter(agent => agent.role === "brain").map(agent => [agent.id, agent.name]));
  const storedProject = loadSelectedProject();
  const selectedProject = sel.kind !== "channel" ? sel.project ?? projects.find(p => p.slug === storedProject)?.slug ?? projects[0]?.slug ?? ""
    : (activeChannel?.project ?? projects.find(p => p.slug === storedProject)?.slug ?? projects[0]?.slug ?? "");

  const search = useSearch({ selectedProject, projects, setErr });
  const inbox = useInbox({ sel, selRef, projects, hive, setErr });
  const { changeSelection, go } = useChangeSelection(selection, {
    channelLoad: channelPane.channelLoad, channelJournal: channelPane.channelJournal,
    channelJumpIntent: channelPane.channelJumpIntent, threadJumpIntent: threadState.threadJumpIntent,
    channelRefreshIntent: channelPane.channelRefreshIntent, channelReads: hive.channelReads,
    threadLoad: threadState.threadLoad, setThreadView: threadState.setThreadView, threadReads: hive.threadReads,
    inboxLoad: inbox.inboxLoad,
  });
  // Leaving search for any destination closes its results view.
  const navigate = (next: Parameters<typeof go>[0]) => {
    if (search.query) search.setQuery("");
    go(next);
  };
  const notifications = useDesktopNotifications(channels, navigate);
  const launchRequests = useLaunchRequests(projects, snap?.agents ?? []);
  const [taskTick, setTaskTick] = useState(0);
  const taskRefreshTimer = useRef<number | null>(null);
  const requestTaskRefresh = () => {
    if (taskRefreshTimer.current !== null) return;
    taskRefreshTimer.current = window.setTimeout(() => { taskRefreshTimer.current = null; setTaskTick(value => value + 1); }, 80);
  };
  useEffect(() => () => { if (taskRefreshTimer.current !== null) window.clearTimeout(taskRefreshTimer.current); }, []);
  const { live, roomTick, jevTick, subscribeJev } = useRealtime({
    selection, hive, channel: channelPane, thread: threadState, inboxLoad: inbox.inboxLoad, changeSelection,
    reopenDm: dms.reopenDm, onActivity: inbox.receive, refreshRoutingView, onRoutingEvent, setErr,
    onLiveEvent: event => {
      notifications.onLiveEvent(event); launchRequests.onLiveEvent(event);
      if (event.type === 'task' || event.type === 'job' || event.type === 'launch-requests' ||
        event.type === 'agent' || event.type === 'hello') requestTaskRefresh();
    },
  });
  useSelectionRepair(snap, sel, changeSelection);
  // Phones show one screen at a time with bottom tabs (#223); the hash stays the single source of navigation.
  const mobile = useMobile();
  const screen = mobileScreen(sel, search.searching);
  const lastList = useRef<Sel | null>(null);
  useEffect(() => { if (sel.kind !== "channel") lastList.current = sel; }, [sel]);
  useEffect(() => {
    const replace = (next: Sel) => {
      changeSelection(next);
      history.replaceState(null, "", `#${hashFor(next)}`);
    };
    // A phone opened without a route starts on Home; the list screens have no desktop page and fall back to For you.
    if (mobile && !location.hash.replace(/^#\/?/, "")) replace({ kind: "home", project: "" });
    else if (!mobile && (sel.kind === "home" || sel.kind === "dms")) replace({ kind: "inbox", project: sel.project });
  }, [mobile, sel, changeSelection]);
  const channelSheets = useChannelSheets();
  const projectSheets = useProjectSheets(snap, channelSheets);

  const selectedChannelId = sel.kind === "channel" ? sel.id : null;
  const missingChannel = Boolean(snap && sel.kind === "channel" && !snap.channels.some((c) => c.id === sel.id));
  useConversationLoads({ selectedChannelId, threadId, missingChannel, query: search.query, hive,
    channel: channelPane, thread: threadState, setErr });
  const [theme, setTheme] = useTheme();
  const { layout, setLayout, unified } = useLayout();
  const { stickBottom, threadOpenAnchor } = useThreadScrollAnchor({ channelStream: channelPane.channelStream,
    threadStream: threadState.threadStream, pane, threadPane, selectedChannelId, threadId });
  const { openUnread, target: unreadTarget } = useUnreadJump({ selection, channel: channelPane, thread: threadState, go,
    clearSearch: () => search.setQuery(''), refreshSnap, setErr });
  useEffect(() => { setRoutingPanelOpen(false); }, [activeChannel?.id]);
  const compose = useSend({ sel, selection, channel: channelPane, thread: threadState, activeBrainChannel,
    refreshRoutingView, setErr });

  const telegramSheet = useTelegramSheet(setErr);
  const agentConfirm = useAgentConfirm(refreshSnap, setErr);
  const [botProject, setBotProject] = useState<string | null>(null);
  const [credentialBot, setCredentialBot] = useState<Agent | null>(null);
  const [templatesProject, setTemplatesProject] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adaptiveRoutingOpen, setAdaptiveRoutingOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [agentPanelId, setAgentPanelId] = useState<string | null>(null);
  const [resumeAgentId, setResumeAgentId] = useState<string | null>(null);
  const [resumeAliases, setResumeAliases] = useState<string[]>([]);
  /** Project preselected in the Launch sheet when it is opened from a project's roster. */
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState<{ channelId: string; token: string; text: string } | null>(null);
  const openLaunch = (project: string | null = null) => { setResumeAgentId(null); setResumeAliases([]); setLaunchProject(project); setLaunchOpen(true); };

  const roomAgents = (snap?.agents ?? []).filter((a) => a.role === "human" || !a.project || a.project === selectedProject);
  const { inboxBox, inboxItems, inboxPage, inboxBusy } = inbox;

  const onAgent = async (agent: Agent) => {
    if (agent.id === "human") return;
    try {
      const { channel } = await api.openDm(agent.name);
      dms.reopenDm(channel.id);
      await refreshSnap();
      navigate({ kind: "channel", id: channel.id });
    } catch (error) {
      setErr(String((error as Error)?.message || error));
    }
  };
  const messageTaskBrain = async (item: TaskOverview) => {
    try {
      const { channel } = await api.openDm(item.brain.name);
      dms.reopenDm(channel.id);
      await refreshSnap();
      const thread = `#/c/${encodeURIComponent(item.task.channelId)}/t/${encodeURIComponent(item.task.id)}`;
      setTaskDraft({ channelId: channel.id, token: crypto.randomUUID(), text: `[Task ${item.task.id}](${thread})` });
      navigate({ kind: 'channel', id: channel.id });
    } catch (error) { setErr(String((error as Error)?.message || error)); }
  };
  const setAgentLaunchMode = async (agent: Agent, mode: "approval" | "auto") => {
    const { agent: saved } = await api.setAgentLaunchMode(agent.name, mode);
    setSnap(current => current ? { ...current,
      agents: current.agents.map(item => item.id === saved.id ? saved : item) } : current);
  };
  /** Error banner retry: reload the snapshot and whatever conversation or inbox is on screen. */
  const retry = () => {
    setErr(null);
    hive.setReconnectTick((value) => value + 1);
    refreshSnap().catch((error) => { if (error?.name !== "AbortError") setErr(String(error.message || error)); });
  };
  // "Reconnecting" only after the socket was live once, so the first connect does not flash a banner.
  const [wasLive, setWasLive] = useState(false);
  useEffect(() => { if (live) setWasLive(true); }, [live]);

  const selectProject = (slug: string) => { if (snap) navigate(projectLanding(slug, snap)); };
  /** The quick switcher, or ("projects") the single-sidebar layout's project picker. */
  const [switcher, setSwitcher] = useState<"all" | "projects" | null>(null);
  const onSwitch = (item: SwitchItem) => {
    setSwitcher(null);
    if (item.kind === "project") selectProject(item.project.slug);
    else if (item.kind === "agent") void onAgent(item.agent);
    else navigate({ kind: "channel", id: item.channel.id });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSwitcher(open => (open ? null : "all"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The rail's selection and each project's last view are remembered in this browser.
  const knownProject = projects.some(p => p.slug === selectedProject);
  useEffect(() => {
    if (!knownProject) return;
    saveSelectedProject(selectedProject);
    if (sel.kind !== 'tasks' || sel.project !== null)
      saveProjectView(selectedProject, sel.kind === "channel" ? { kind: "channel", id: sel.id } : sel);
  }, [knownProject, selectedProject, sel]);
  const attention = snap ? attentionTotal(snap) : 0;
  useEffect(() => { document.title = documentTitle(attention); }, [attention]);
  // The macOS app's menus and Dock badge; inert in a browser.
  const [settingsRequest, setSettingsRequest] = useState(0);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  useNativeBridge({ ready: Boolean(snap), badge: snap ? attention : null, handlers: {
    // Opens rather than toggles: a ⌘K the page already handled may reach the app's menu too.
    jump: () => setSwitcher("all"),
    forYou: () => { if (selectedProject) navigate({ kind: "inbox", project: selectedProject }); },
    newChannel: () => { channelSheets.setCreateIn(selectedProject || null); channelSheets.setCreating(true); },
    settings: () => setSettingsRequest(n => n + 1),
    toggleTheme,
    navigate,
  } });

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
        <p role="status">Opening the hive…</p>
      </div>
    );
  }

  const settings = {
    theme, onToggleTheme: toggleTheme, layout, onLayout: setLayout, notifications, openRequest: settingsRequest,
    telegram: snap.telegram, onTelegram: () => telegramSheet.openTelegram(snap?.projects ?? []),
    onAdaptiveRouting: () => setAdaptiveRoutingOpen(true), onLaunch: () => openLaunch(), onHelp: () => setHelpOpen(true),
    autoArchive: snap.autoArchiveTaskChannels === undefined ? undefined : {
      enabled: snap.autoArchiveTaskChannels,
      // Channels it archives arrive as room events; only the flag is patched here.
      onToggle: () => api.setAutoArchiveTaskChannels(!snap.autoArchiveTaskChannels)
        .then(({ enabled }) => setSnap(previous => previous ? { ...previous, autoArchiveTaskChannels: enabled } : previous))
        .catch(error => setErr(String(error))),
    },
  };
  const railProject = projects.some(p => p.slug === selectedProject) ? selectedProject : projects[0]?.slug ?? "";
  const threadVisible = Boolean(threadId && threadPane && sel.kind === "channel" &&
    threadPane.channel.id === sel.id && threadPane.threadId === threadId);

  return (
    <div className="shell" data-m={screen}>
      {unified ? (
        <TopBar live={live} projectName={projects.find(p => p.slug === railProject)?.name} onSwitcher={() => setSwitcher("all")}
          onAllTasks={() => navigate({ kind: 'tasks', project: null })} allTasksActive={sel.kind === 'tasks' && sel.project === null}
          settings={settings} />
      ) : (
        <ProjectRail snap={snap} selectedProject={sel.kind === 'tasks' && sel.project === null ? '' : railProject} onSelect={selectProject}
          onAllTasks={() => navigate({ kind: 'tasks', project: null })} allTasksActive={sel.kind === 'tasks' && sel.project === null}
          onNewProject={() => projectSheets.setCreatingProject(true)} settings={settings} live={live} />
      )}
      {/* Settings lives at the foot of the rail or in the top bar, never in the sidebar. */}
      <Sidebar snap={snap} sel={sel} go={navigate} live={live} unified={unified} onUnread={openUnread}
        resizable={!mobile} threadOpen={threadVisible}
        query={search.query} setQuery={search.setQuery} onSearchNow={search.searchNow} onLaunch={openLaunch}
        selectedProject={selectedProject} onSwitcher={() => setSwitcher("all")} onProjectSwitcher={() => setSwitcher("projects")}
        agentWork={snap.agentWork ?? {}}
        inboxBox={inboxBox} projectSheets={projectSheets}
        onNewChannel={(project) => {
          channelSheets.setCreateIn(project);
          channelSheets.setCreating(true);
        }}
        dms={dms}
        agentActions={{
          onAgent, onOpenPanel: agent => setAgentPanelId(agent.id),
          onCreateBot: id => { setCredentialBot(null); setBotProject(id); }, onManageBot: bot => { setCredentialBot(bot); setBotProject(bot.projectId!); },
          onAskAgent: (name, kind) => kind === 'remove'
            ? setAgentPanelId(snap.agents.find(agent => agent.name === name)?.id ?? null)
            : agentConfirm.setAgentConfirm({ name, kind }),
          onSetLaunchMode: setAgentLaunchMode,
        }} />

      <main className="desk">
        {wasLive && !live && <div className="conn-banner" role="status">Reconnecting… Live updates are paused.</div>}
        {projects.length === 0 ? (
          <header className="desk-h">
            <div>
              <h1>No projects</h1>
              <p>Create one from the sidebar. The worktree on disk is never deleted.</p>
            </div>
          </header>
        ) : search.searching ? (
          <SearchDesk
            hiveName={projects.find((p) => p.slug === selectedProject)?.name ?? selectedProject}
            q={search.query.trim()}
            hits={search.hits}
            hasMore={search.hitsMore}
            busy={search.hitsBusy}
            onOpen={(hit) => {
              search.setQuery("");
              go({ kind: "channel", id: hit.channelId, thread: hit.threadId ?? undefined });
            }}
            onOlder={search.loadOlderHits}
            onClear={() => search.setQuery("")}
          />
        ) : sel.kind === "jev" ? (
          <JevLog project={sel.project} tick={jevTick} subscribe={subscribeJev}
            projectId={projects.find(p => p.slug === sel.project || p.id === sel.project)?.id}
            channelLabel={id => { const channel = channels.find(item => item.id === id); return channel ? channelTitle(channel) : "Deleted channel"; }}
            agentName={id => snap.agents.find(agent => agent.id === id)?.name ?? "Removed brain"}
            onOpenChannel={id => go({ kind: "channel", id })} />
        ) : sel.kind === "tasks" ? (
          <TaskViews project={sel.project} projects={projects} agents={snap.agents} traffic={snap.agentTraffic ?? {}}
            tick={taskTick} onProject={slug => navigate({ kind: 'tasks', project: slug })}
            onBack={() => navigate({ kind: 'home', project: sel.project ?? selectedProject })}
            onAll={() => navigate({ kind: 'tasks', project: null })}
            onOpenThread={item => navigate({ kind: 'channel', id: item.task.channelId, thread: item.task.id })}
            onOpenWorker={item => setAgentPanelId(item.worker.id)}
            onMessageBrain={item => void messageTaskBrain(item)}
            requests={<LaunchRequests requests={sel.project
              ? launchRequests.requests.filter(request => projects.find(project => project.id === request.projectId)?.slug === sel.project)
              : launchRequests.requests} projects={projects} agents={snap.agents}
              launcherAvailable={Boolean(snap.launcherAvailable)} error={launchRequests.error} loading={launchRequests.loading}
              onRetry={() => void launchRequests.refresh()} onDecide={launchRequests.decide} />} />
        ) : sel.kind === "inbox" ? (
          <Inbox
            key={`${sel.project}:${inboxBox}`}
            onMarkMessage={inbox.markMessage}
            box={inboxBox}
            items={inboxItems}
            unread={snap.mentionCounts[sel.project] ?? 0}
            filter={inbox.filter}
            onFilter={inbox.setFilter}
            loading={inbox.inboxLoading}
            failed={inbox.inboxFailed}
            hasMore={!inboxBusy && inboxPage?.project === sel.project && inboxItems.length > 0 && Boolean(inboxPage.hasMore)}
            channels={channels}
            agents={snap.agents.filter((a) => a.role === "human" || a.project === sel.project)}
            onBox={(box) => go({ kind: "inbox", project: sel.project, box })}
            onOpen={({ message: m }) =>
              go({ kind: "channel", id: m.channelId, thread: m.threadId ?? undefined })
            }
            onOlder={inbox.loadOlder}
            onMarkSeen={inbox.markAllSeen}
            requests={<LaunchRequests requests={launchRequests.requests} projects={projects} agents={snap.agents}
              launcherAvailable={Boolean(snap.launcherAvailable)} error={launchRequests.error} loading={launchRequests.loading}
              onRetry={() => void launchRequests.refresh()} onDecide={launchRequests.decide} />}
          />
        ) : sel.kind === "dms" ? (
          <MobileDms snap={snap} project={sel.project} onOpen={id => go({ kind: "channel", id })} onUnread={openUnread} />
        ) : sel.kind === "home" ? null : (
          <ChannelDesk channelId={sel.id} activeChannel={activeChannel} archived={snap.archivedChannelIds?.includes(sel.id) ?? false} agents={snap.agents} roomAgents={roomAgents}
            unreadTarget={unreadTarget}
            channel={channelPane} threadPaneId={threadPane?.threadId} stickBottom={stickBottom}
            threadOpenAnchor={threadOpenAnchor} go={go} roomTick={roomTick} routingView={routingView}
            onReopenThread={threadState.refreshThread}
            activeBrainChannel={activeBrainChannel} brainNames={brainNames}
            onOpenRouting={() => setRoutingPanelOpen(true)} onInvite={() => channelSheets.setInviteOpen(true)}
            compose={compose} draftInsert={taskDraft?.channelId === sel.id ? taskDraft : null}
            onDraftInserted={token => setTaskDraft(current => current?.token === token ? null : current)}
            setErr={setErr} onMarkUnread={async (channelId, seq) => {
              const ticket = hive.readFence.current.ticket();
              const next = await api.markUnread(channelId, seq);
              if (!hive.acceptRead(next, ticket)) hive.readRefresh.current?.request();
            }}
            onBack={() => go(channelBack(activeChannel, lastList.current, selectedProject))} />
        )}
        {err && (
          <div className="err with-actions" role="alert">
            <span>{err}</span>
            <button type="button" onClick={retry}>Retry</button>
            <button type="button" aria-label="Dismiss error" onClick={() => setErr(null)}>Dismiss</button>
          </div>
        )}
      </main>

      {threadVisible && !mobile && <ThreadResizer />}
      {threadVisible && threadId && threadPane && sel.kind === "channel" && (
        <ThreadAside channelId={sel.id} threadId={threadId} threadPane={threadPane} thread={threadState}
          onClose={() => {
            if (sel.kind === "channel") go({ kind: "channel", id: sel.id });
            else setThreadId(null);
          }}
          roomAgents={roomAgents} compose={compose} />
      )}

      {mobileTab(screen) && (
        <MobileTabs active={mobileTab(screen)} onTab={tab => go(tabTarget(tab, selectedProject, inboxBox))}
          badges={{
            dms: projectDms(snap, selectedProject).withYou.reduce((sum, ch) => sum + (snap.unread[ch.id] ?? 0), 0),
            activity: snap.mentionCounts[selectedProject] ?? 0,
          }} />
      )}

      {channelSheets.creating && (
        <CreateChannelSheet form={channelSheets} agents={snap.agents}
          defaultProject={activeChannel?.project ?? snap?.projects[0]?.slug}
          onCreated={async (channel) => {
            await refreshSnap();
            go({ kind: "channel", id: channel.id });
          }}
          setErr={setErr} />
      )}

      {botProject && projects.some((p) => p.id === botProject) && (
        <ProjectBots key={botProject} project={projects.find((p) => p.id === botProject)!} initialBot={credentialBot?.id}
          onChanged={() => { void refreshSnap().catch((e) => setErr(String(e.message || e))); }}
          onClose={() => { setBotProject(null); setCredentialBot(null); }} />
      )}

      {channelSheets.inviteOpen && activeChannel && (
        <InviteSheet form={channelSheets} channel={activeChannel} agents={snap.agents}
          onInvited={async () => {
            await refreshSnap();
            if (sel.kind === "channel") await channelPane.loadChannel(sel.id);
          }}
          setErr={setErr} />
      )}

      {projectSheets.editingProject && (
        <ProjectSettingsSheet form={projectSheets} project={projectSheets.editingProject} agents={snap?.agents ?? []}
          onBots={() => { setCredentialBot(null); setBotProject(projects.find(p => p.slug === projectSheets.editingProject)!.id); projectSheets.setEditingProject(null); }}
          onWorkerTemplates={() => setTemplatesProject(projectSheets.editingProject)} refreshSnap={refreshSnap} setErr={setErr} />
      )}

      {templatesProject && projects.some((p) => p.slug === templatesProject) && (
        <WorkerTemplatesSheet key={templatesProject} project={projects.find((p) => p.slug === templatesProject)!}
          onClose={() => setTemplatesProject(null)} />
      )}

      {projectSheets.creatingProject && (
        <CreateProjectSheet form={projectSheets} refreshSnap={refreshSnap} setErr={setErr}
          onCreated={slug => navigate({ kind: "inbox", project: slug })} />
      )}

      {adaptiveRoutingOpen && (
        <AdaptiveRoutingSettings onClose={() => setAdaptiveRoutingOpen(false)} onSaved={(settings) => {
          setSnap((s) => (s ? { ...s, jev: { enabled: settings.enabled } } : s));
          refreshRoutingView();
        }} />
      )}

      {routingPanelOpen && activeChannel && routingView && (
        <AdaptiveRoutingPanel
          channelId={activeChannel.id}
          view={routingView}
          brainNames={brainNames}
          onClose={() => setRoutingPanelOpen(false)}
        />
      )}

      {telegramSheet.telegramOpen && telegramSheet.telegram && (
        <TelegramSheet form={telegramSheet} telegram={telegramSheet.telegram} projects={projects}
          onSaved={(t) => {
            latestTelegramHealth.current = newerTelegramHealth(latestTelegramHealth.current, t);
            setSnap((s) => (s ? { ...s, telegram: { running: t.running, configured: t.configured, ...latestTelegramHealth.current } } : s));
          }}
          setErr={setErr} />
      )}

      {launchOpen && (
        <LaunchSheet
          key={resumeAgentId ?? 'new'}
          projects={projects}
          agents={snap.agents}
          defaultProject={launchProject ?? selectedProject}
          resumeAgentId={resumeAgentId ?? undefined}
          resumeAliases={resumeAliases}
          onClose={() => { setLaunchOpen(false); setLaunchProject(null); setResumeAgentId(null); setResumeAliases([]); }}
        />
      )}

      {agentPanelId && <AgentPanel key={agentPanelId} agentId={agentPanelId} agents={snap.agents} projects={projects} tick={taskTick}
        onClose={() => setAgentPanelId(current => current === agentPanelId ? null : current)} onChanged={refreshSnap}
        onMessage={agent => { setAgentPanelId(null); void onAgent(agent); }}
        onClear={agent => { setAgentPanelId(null); agentConfirm.setAgentConfirm({ name: agent.name, kind: 'clear' }); }}
        onResume={(agent, aliases) => { setAgentPanelId(null); setResumeAgentId(agent.id); setResumeAliases(aliases);
          setLaunchProject(agent.project); setLaunchOpen(true); }}
        onOpenTask={item => { setAgentPanelId(null); navigate({ kind: 'tasks', project: item.project }); }}
        onOpenThread={item => { setAgentPanelId(null); navigate({ kind: 'channel', id: item.task.channelId, thread: item.task.id }); }} />}

      {agentConfirm.agentConfirm && (
        <AgentConfirmSheet target={agentConfirm.agentConfirm} busy={agentConfirm.agentBusy}
          onCancel={() => agentConfirm.setAgentConfirm(null)} onConfirm={agentConfirm.onAgentConfirm} />
      )}

      {switcher && <QuickSwitcher key={switcher} snap={snap} currentProject={selectedProject} onPick={onSwitch} scope={switcher}
        onNewProject={() => { setSwitcher(null); projectSheets.setCreatingProject(true); }}
        onClose={() => setSwitcher(null)} />}

      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} onLaunch={() => openLaunch()} />}
    </div>
  );
}
