import { useEffect, useRef, useState } from "react";
import type { Agent } from "../src/shared/types.ts";
import { AdaptiveRoutingPanel } from "./AdaptiveRoutingPanel.tsx";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";
import { api } from "./api.ts";
import { ChannelDesk } from "./ChannelDesk.tsx";
import { CreateChannelSheet, InviteSheet } from "./ChannelSheets.tsx";
import { DecisionQueue } from './DecisionQueue.tsx';
import { useDesktopNotifications } from "./desktop-notifications.ts";
import { AgentConfirmSheet, BotSheet, CredentialSheet, HelpSheet } from "./HiveSheets.tsx";
import { Inbox } from "./Inbox.tsx";
import { JevLog } from "./JevLog.tsx";
import { channelTitle } from "./labels.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { channelBack, mobileScreen, mobileTab, tabTarget, useMobile } from "./mobile-nav.ts";
import { MobileDms, MobileTabs, projectDms } from "./MobileNav.tsx";
import { attentionTotal, documentTitle, loadSelectedProject, projectLanding, saveProjectView, saveSelectedProject, type SwitchItem } from "./nav-model.ts";
import { ProjectPlugins } from "./ProjectPlugins.tsx";
import { CreateProjectSheet, ProjectSettingsSheet } from "./ProjectSheets.tsx";
import { QuickSwitcher } from "./QuickSwitcher.tsx";
import { SearchDesk } from "./SearchDesk.tsx";
import { hashFor, type Sel } from "./selection.ts";
import { Sidebar } from "./Sidebar.tsx";
import { newerTelegramHealth } from "./telegram-health.ts";
import { TelegramSheet } from "./TelegramSheet.tsx";
import { ThreadAside } from "./ThreadAside.tsx";
import { useAdaptiveRouting } from "./use-adaptive-routing.ts";
import { useChannelPane } from "./use-channel-pane.ts";
import { useConversationLoads } from "./use-conversation-loads.ts";
import { useDmNav } from "./use-dm-nav.ts";
import { useHiveSnapshot } from "./use-hive-snapshot.ts";
import { useInbox } from "./use-inbox.ts";
import { useNavStatus } from "./use-nav-status.ts";
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
  const selectedProject = sel.kind !== "channel" ? sel.project
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
  const navStatus = useNavStatus();
  const notifications = useDesktopNotifications(channels, navigate);
  const { live, roomTick, decisionTick, setDecisionTick, jevTick, subscribeJev } = useRealtime({
    selection, hive, channel: channelPane, thread: threadState, inboxLoad: inbox.inboxLoad, changeSelection,
    reopenDm: dms.reopenDm, onActivity: inbox.receive, refreshRoutingView, onRoutingEvent, setErr,
    onLiveEvent: event => { navStatus.onLiveEvent(event); notifications.onLiveEvent(event); },
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
  const [botBusy, setBotBusy] = useState(false);
  const [credentialBot, setCredentialBot] = useState<Agent | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [pluginsProject, setPluginsProject] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adaptiveRoutingOpen, setAdaptiveRoutingOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  /** Project preselected in the Launch sheet when it is opened from a project's roster. */
  const [launchProject, setLaunchProject] = useState<string | null>(null);
  const openLaunch = (project: string | null = null) => { setLaunchProject(project); setLaunchOpen(true); };

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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const onSwitch = (item: SwitchItem) => {
    setSwitcherOpen(false);
    if (item.kind === "project") selectProject(item.project.slug);
    else if (item.kind === "agent") void onAgent(item.agent);
    else navigate({ kind: "channel", id: item.channel.id });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSwitcherOpen(open => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The rail's selection and each project's last view are remembered in this browser.
  const knownProject = projects.some(p => p.slug === selectedProject);
  useEffect(() => {
    if (!knownProject) return;
    saveSelectedProject(selectedProject);
    saveProjectView(selectedProject, sel.kind === "channel" ? { kind: "channel", id: sel.id } : sel);
  }, [knownProject, selectedProject, sel]);
  const attention = snap ? attentionTotal(snap) : 0;
  useEffect(() => { document.title = documentTitle(attention); }, [attention]);

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

  return (
    <div className="shell" data-m={screen}>
      <Sidebar snap={snap} sel={sel} go={navigate} live={live} theme={theme} onUnread={openUnread}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        query={search.query} setQuery={search.setQuery} onSearchNow={search.searchNow}
        onTelegram={() => telegramSheet.openTelegram(snap?.projects ?? [])}
        onAdaptiveRouting={() => setAdaptiveRoutingOpen(true)} onLaunch={openLaunch} onHelp={() => setHelpOpen(true)}
        selectedProject={selectedProject} onSelectProject={selectProject} onSwitcher={() => setSwitcherOpen(true)}
        awaitingDecisions={navStatus.awaitingDecisions} agentWork={navStatus.agentWork} notifications={notifications}
        inboxBox={inboxBox} projectSheets={projectSheets}
        onNewChannel={(project) => {
          channelSheets.setCreateIn(project);
          channelSheets.setCreating(true);
        }}
        dms={dms}
        agentActions={{
          onAgent, onCreateBot: setBotProject, onManageBot: setCredentialBot,
          onAskAgent: (name, kind) => agentConfirm.setAgentConfirm({ name, kind }),
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
        ) : sel.kind === "decisions" ? (
          <DecisionQueue project={sel.project} tick={decisionTick}
            onOpen={decision => go({ kind: "channel", id: decision.channelId, thread: decision.id })} />
        ) : sel.kind === "inbox" ? (
          <Inbox
            key={`${sel.project}:${inboxBox}`}
            onDecisions={() => go({ kind: "decisions", project: sel.project })}
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
          />
        ) : sel.kind === "dms" ? (
          <MobileDms snap={snap} project={sel.project} onOpen={id => go({ kind: "channel", id })} onUnread={openUnread} />
        ) : sel.kind === "home" ? null : (
          <ChannelDesk channelId={sel.id} activeChannel={activeChannel} agents={snap.agents} roomAgents={roomAgents}
            unreadTarget={unreadTarget}
            channel={channelPane} threadPaneId={threadPane?.threadId} stickBottom={stickBottom}
            threadOpenAnchor={threadOpenAnchor} go={go} roomTick={roomTick} decisionTick={decisionTick}
            onDecisionAnswered={() => setDecisionTick(t => t + 1)} routingView={routingView}
            activeBrainChannel={activeBrainChannel} brainNames={brainNames}
            onOpenRouting={() => setRoutingPanelOpen(true)} onInvite={() => channelSheets.setInviteOpen(true)}
            compose={compose} setErr={setErr} onMarkUnread={async (channelId, seq) => {
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

      {threadId && threadPane && sel.kind === "channel" && threadPane.channel.id === sel.id && threadPane.threadId === threadId && (
        <ThreadAside channelId={sel.id} threadId={threadId} threadPane={threadPane} thread={threadState}
          onClose={() => {
            if (sel.kind === "channel") go({ kind: "channel", id: sel.id });
            else setThreadId(null);
          }}
          onDecisionAnswered={() => setDecisionTick(t => t + 1)} roomAgents={roomAgents} compose={compose} />
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
        <BotSheet project={projects.find((p) => p.id === botProject)!} busy={botBusy} onBusy={setBotBusy}
          onCreated={() => { void refreshSnap().catch((e) => setErr(String(e.message || e))); }}
          onClose={() => setBotProject(null)} />
      )}

      {credentialBot && snap.agents.some(a => a.id === credentialBot.id) &&
        <CredentialSheet bot={credentialBot} busy={credentialBusy} onBusy={setCredentialBusy}
          onClose={() => setCredentialBot(null)} />}

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
          onPlugins={() => setPluginsProject(projectSheets.editingProject)} refreshSnap={refreshSnap} setErr={setErr} />
      )}

      {pluginsProject && projects.some((p) => p.slug === pluginsProject) && (
        <ProjectPlugins key={pluginsProject} project={projects.find((p) => p.slug === pluginsProject)!}
          onClose={() => setPluginsProject(null)} />
      )}

      {projectSheets.creatingProject && (
        <CreateProjectSheet form={projectSheets} refreshSnap={refreshSnap} setErr={setErr}
          onCreated={slug => navigate({ kind: "inbox", project: slug })} />
      )}

      {adaptiveRoutingOpen && (
        <AdaptiveRoutingSettings onClose={() => setAdaptiveRoutingOpen(false)} onSaved={() => refreshRoutingView()} />
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
          projects={projects}
          agents={snap.agents}
          defaultProject={launchProject ?? selectedProject}
          onClose={() => { setLaunchOpen(false); setLaunchProject(null); }}
        />
      )}

      {agentConfirm.agentConfirm && (
        <AgentConfirmSheet target={agentConfirm.agentConfirm} busy={agentConfirm.agentBusy}
          onCancel={() => agentConfirm.setAgentConfirm(null)} onConfirm={agentConfirm.onAgentConfirm} />
      )}

      {switcherOpen && <QuickSwitcher snap={snap} currentProject={selectedProject} onPick={onSwitch}
        onClose={() => setSwitcherOpen(false)} />}

      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} onLaunch={() => openLaunch()} />}
    </div>
  );
}
