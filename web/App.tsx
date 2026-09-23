import { useEffect, useState } from "react";
import type { Agent } from "../src/shared/types.ts";
import { AdaptiveRoutingPanel } from "./AdaptiveRoutingPanel.tsx";
import { AdaptiveRoutingSettings } from "./AdaptiveRoutingSettings.tsx";
import { api } from "./api.ts";
import { ChannelDesk } from "./ChannelDesk.tsx";
import { CreateChannelSheet, InviteSheet } from "./ChannelSheets.tsx";
import { DecisionQueue } from './DecisionQueue.tsx';
import { AgentConfirmSheet, BotSheet, CredentialSheet, HelpSheet } from "./HiveSheets.tsx";
import { Inbox } from "./Inbox.tsx";
import { JevLog } from "./JevLog.tsx";
import { channelTitle } from "./labels.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { ProjectPlugins } from "./ProjectPlugins.tsx";
import { CreateProjectSheet, ProjectSettingsSheet } from "./ProjectSheets.tsx";
import { SearchDesk } from "./SearchDesk.tsx";
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
import { useMailLog } from "./use-mail-log.ts";
import { useRealtime } from "./use-realtime.ts";
import { useSearch } from "./use-search.ts";
import { useChangeSelection, useSelection, useSelectionRepair } from "./use-selection.ts";
import { useSend } from "./use-send.ts";
import { useAgentConfirm, useChannelSheets, useProjectSheets, useTelegramSheet } from "./use-sheets.ts";
import { useTheme } from "./use-theme.ts";
import { useThreadPane } from "./use-thread-pane.ts";
import { useThreadScrollAnchor } from "./use-thread-scroll-anchor.ts";

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
  const { view: routingView, error: routingError, refresh: refreshRoutingView,
    onEvent: onRoutingEvent } = useAdaptiveRouting(routingChannelId);
  const [routingPanelOpen, setRoutingPanelOpen] = useState(false);
  const channelPane = useChannelPane(selRef);
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
  const selectedProject =
    sel.kind === "inbox" || sel.kind === "decisions" || sel.kind === "jev" ? sel.project : (activeChannel?.project ?? projects[0]?.slug ?? "chapter");

  const search = useSearch({ selectedProject, projects, setErr });
  const inbox = useInbox({ sel, selRef, projects, hive, setErr });
  const { mailLog, mergeMail } = useMailLog({ snap, channels, pane, threadPane, inboxPage: inbox.inboxPage });
  const { changeSelection, go } = useChangeSelection(selection, {
    channelLoad: channelPane.channelLoad, channelJournal: channelPane.channelJournal,
    channelRefreshIntent: channelPane.channelRefreshIntent, channelReads: hive.channelReads,
    threadLoad: threadState.threadLoad, setThreadView: threadState.setThreadView, threadReads: hive.threadReads,
    inboxLoad: inbox.inboxLoad,
  });
  const { live, roomTick, decisionTick, setDecisionTick, jevTick } = useRealtime({
    selection, hive, channel: channelPane, thread: threadState, inboxLoad: inbox.inboxLoad, changeSelection,
    reopenDm: dms.reopenDm, mergeMail, refreshRoutingView, onRoutingEvent, setErr,
  });
  useSelectionRepair(snap, sel, changeSelection);
  const channelSheets = useChannelSheets();
  const projectSheets = useProjectSheets(snap, channelSheets);

  const selectedChannelId = sel.kind === "channel" ? sel.id : null;
  const missingChannel = Boolean(snap && sel.kind === "channel" && !snap.channels.some((c) => c.id === sel.id));
  useConversationLoads({ selectedChannelId, threadId, missingChannel, query: search.query, hive,
    channel: channelPane, thread: threadState, setErr });
  const [theme, setTheme] = useTheme();
  const { stickBottom, threadOpenAnchor } = useThreadScrollAnchor({ channelStream: channelPane.channelStream,
    threadStream: threadState.threadStream, pane, threadPane, selectedChannelId, threadId });
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

  const q = search.query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const roomAgents = (snap?.agents ?? []).filter((a) => {
    if (a.role !== "human" && a.project && a.project !== selectedProject) return false;
    if (!q) return true;
    return match(a.name) || match(a.focus ?? "") || match(a.role);
  });
  const inboxProject = sel.kind === "inbox" ? sel.project : selectedProject;
  const allForYou = mailLog.filter((m) => channels.find((c) => c.id === m.channelId)?.project === inboxProject);
  const { inboxBox, inboxMentions, inboxPage, inboxBusy } = inbox;

  const onAgent = async (agent: Agent) => {
    if (agent.id === "human") return;
    const { channel } = await api.openDm(agent.name);
    dms.reopenDm(channel.id);
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
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
      <Sidebar snap={snap} sel={sel} go={go} live={live} theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        query={search.query} setQuery={search.setQuery} onSearchNow={search.searchNow}
        onTelegram={() => telegramSheet.openTelegram(snap?.projects ?? [])}
        onAdaptiveRouting={() => setAdaptiveRoutingOpen(true)} onLaunch={openLaunch} onHelp={() => setHelpOpen(true)}
        selectedProject={selectedProject} inboxBox={inboxBox} projectSheets={projectSheets}
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
            onMarkMessage={(message) => inbox.markMessage(sel.project, message)}
            box={inboxBox}
            mentions={inboxBox === "all" ? allForYou : inboxMentions}
            hasMore={inboxBox === "unread" && !inboxBusy && inboxPage?.project === sel.project && Boolean(inboxPage.hasMore)}
            channels={channels}
            agents={snap.agents.filter((a) => a.role === "human" || a.project === sel.project)}
            onBox={(box) => go({ kind: "inbox", project: sel.project, box })}
            onOpen={(m) =>
              go({ kind: "channel", id: m.channelId, thread: m.threadId ?? undefined })
            }
            onOlder={() => inbox.loadOlder(sel.project)}
            onMarkSeen={() => inbox.markAllSeen(sel.project)}
          />
        ) : (
          <ChannelDesk channelId={sel.id} activeChannel={activeChannel} agents={snap.agents} roomAgents={roomAgents}
            channel={channelPane} threadPaneId={threadPane?.threadId} stickBottom={stickBottom}
            threadOpenAnchor={threadOpenAnchor} go={go} roomTick={roomTick} routingView={routingView}
            activeBrainChannel={activeBrainChannel} brainNames={brainNames}
            onOpenRouting={() => setRoutingPanelOpen(true)} onInvite={() => channelSheets.setInviteOpen(true)}
            compose={compose} setErr={setErr} />
        )}
        {routingError && activeBrainChannel && <div className="err" role="alert">Routing status unavailable: {routingError}</div>}
        {err && (
          <div className="err" onClick={() => setErr(null)}>
            {err}
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
        <CreateProjectSheet form={projectSheets} refreshSnap={refreshSnap} setErr={setErr} />
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

      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} onLaunch={() => openLaunch()} />}
    </div>
  );
}
