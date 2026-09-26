import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsUpDown, Inbox, Plus, Route, Search, SlidersHorizontal, SquareTerminal, Terminal, TextSearch } from "lucide-react";
import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import type { AgentWork } from "../src/shared/tasks.ts";
import type { Agent, Channel, Project } from "../src/shared/types.ts";
import { AgentList } from "./AgentList.tsx";
import type { Snapshot } from "./api.ts";
import { ChannelItem, DmRow } from "./ChannelNav.tsx";
import { projectAttention, projectInitials, SWITCHER_SHORTCUT } from "./nav-model.ts";
import { SessionsSheet } from "./SessionsSheet.tsx";
import type { InboxBox, Sel } from "./selection.ts";
import type { DmNav } from "./use-dm-nav.ts";
import { useTerminalState } from "./use-terminal.ts";
import type { ProjectSheets } from "./use-sheets.ts";

type AgentActions = {
  onAgent: (agent: Agent) => void;
  onCreateBot: (projectId: string) => void;
  onManageBot: (agent: Agent) => void;
  onAskAgent: (name: string, kind: "clear" | "remove") => void;
};

/**
 * The sidebar of the selected project: its header (name, connection, project settings), the quick switcher,
 * message search (which never filters this navigation), that project's sections and Launch agent pinned at
 * the bottom. In the single-sidebar layout a project card opens the project picker and the top bar holds the
 * connection state. Settings sits at the foot of the project rail, or in the top bar.
 */
export function Sidebar({ snap, sel, go, live, unified, query, setQuery, onSearchNow, onLaunch, selectedProject,
  onSwitcher, onProjectSwitcher, inboxBox, projectSheets, onNewChannel, dms, agentActions, agentWork, onUnread }: {
  snap: Snapshot;
  sel: Sel;
  go: (next: Sel) => void;
  live: boolean;
  unified: boolean;
  query: string;
  setQuery: (query: string) => void;
  onSearchNow: () => void;
  onLaunch: (project?: string | null) => void;
  selectedProject: string;
  onSwitcher: () => void;
  onProjectSwitcher: () => void;
  inboxBox: InboxBox;
  projectSheets: ProjectSheets;
  onNewChannel: (project: string) => void;
  dms: DmNav;
  agentActions: AgentActions;
  agentWork: Record<string, AgentWork>;
  onUnread: (channelId: string) => void;
}) {
  const projects = snap.projects ?? [];
  const project = projects.find(item => item.slug === selectedProject) ?? projects[0];
  // Hivemind.app only: the tmux sessions agents run in, beside Launch agent.
  const terminals = useTerminalState();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const running = terminals.sessions?.filter(item => item.alive).length ?? 0;
  // The top bar shows the connection in the single-sidebar layout.
  const tools = !unified && (
    <span className="side-live">
      <span className={`pulse ${live ? "on" : ""}`} title={live ? "live" : "waiting"} role="img"
        aria-label={live ? "Connected" : "Not connected"} />
      <span aria-hidden="true">{live ? "Live" : "Offline"}</span>
    </span>
  );
  const find = (
    <div className="side-find">
      {!unified && (
        <button type="button" className="switcher-open" onClick={onSwitcher} aria-keyshortcuts="Meta+K Control+K">
          <Search size={14} aria-hidden="true" />
          <span>Jump to…</span><kbd>{SWITCHER_SHORTCUT}</kbd>
        </button>
      )}
      <div className="side-search">
        <TextSearch size={14} aria-hidden="true" />
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && isLiveSearchQuery(query)) {
              e.preventDefault();
              onSearchNow();
            }
          }}
          placeholder={project ? `Search messages in ${project.name}` : "Search messages"} aria-label="Search messages"
        />
      </div>
    </div>
  );
  return (
    <aside className="rail">
      {unified && project && (
        <div className="project-switch-row">
          <ProjectSwitch snap={snap} project={project} onOpen={onProjectSwitcher} />
          <button type="button" className="icon-btn project-settings" title="Project settings" aria-label={`Settings for ${project.name}`}
            onClick={() => projectSheets.editProject(project)}>
            <SlidersHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {/* Only this part scrolls: the project header sticks to its top, Launch agent stays pinned below. */}
      <div className="side-scroll">
        {!project && (
          <>
            <div className="brand side-head">
              <img className="mark" src="/icon.svg" alt="" />
              <span className="word">hivemind</span>
              {tools}
            </div>
            {find}
            <div className="group-h">
              <span>No projects.</span>
              <button type="button" className="plus" onClick={() => projectSheets.setCreatingProject(true)} title="New project"
                aria-label="New project">
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
        {project && (
          <ProjectSection key={project.id} project={project} snap={snap} sel={sel} go={go} unified={unified} tools={tools} find={find}
            onProjectSwitcher={onProjectSwitcher}
            onSettings={() => projectSheets.editProject(project)} inboxBox={inboxBox} onNewChannel={onNewChannel}
            dms={dms} agentActions={agentActions} onLaunch={onLaunch} onUnread={onUnread}
            agentWork={agentWork} />
        )}
      </div>
      {terminals.native && (
        <button type="button" className="sessions-cta" data-platform={terminals.platform ?? undefined} onClick={() => setSessionsOpen(true)}
          aria-haspopup="dialog">
          <SquareTerminal size={14} aria-hidden="true" /> <span>Terminal sessions</span>
          {running > 0 && <em className="count soft" aria-label={`${running} running`}>{running}</em>}
        </button>
      )}
      {sessionsOpen && <SessionsSheet agents={snap.agents ?? []} projects={projects} onClose={() => setSessionsOpen(false)} />}
      {projects.length > 0 && (
        <button type="button" className="launch-cta" onClick={() => onLaunch()}>
          <Terminal size={15} aria-hidden="true" /> Launch agent
        </button>
      )}
    </aside>
  );
}

/** Single-sidebar layout: the current project as a card that opens the project picker, with other projects' alerts or unread. */
function ProjectSwitch({ snap, project, onOpen }: { snap: Snapshot; project: Project; onOpen: () => void }) {
  const online = snap.agents.filter(agent => agent.project === project.slug && agent.online
    && (agent.role === "brain" || agent.role === "worker")).length;
  const others = snap.projects.filter(other => other.slug !== project.slug).map(other => projectAttention(snap, other.slug));
  const elsewhere = others.reduce((sum, other) => sum + other.alerts, 0);
  // Like the rail: a count for alerts, else a dot for plain unread messages.
  const unreadElsewhere = !elsewhere && others.some(other => other.unread);
  const count = snap.projects.length;
  const label = [`Switch project, current: ${project.name}`,
    elsewhere ? `${elsewhere} unread for you in other projects` : unreadElsewhere ? "unread messages in other projects" : ""]
    .filter(Boolean).join(", ");
  return (
    <button type="button" className="project-switch" onClick={onOpen} aria-haspopup="dialog" aria-label={label} title={label}>
      <span className="project-switch-mark" aria-hidden="true">{projectInitials(project.name)}</span>
      <span className="project-switch-text" aria-hidden="true">
        <strong>{project.name}</strong>
        {/* Each clause stays whole, so a narrow card breaks after the "·". */}
        <small><span>{online} {online === 1 ? "agent" : "agents"} online ·</span> <span>{count} {count === 1 ? "project" : "projects"}</span></small>
      </span>
      {elsewhere > 0
        ? <em className="count" aria-hidden="true">{elsewhere > 99 ? "99+" : elsewhere}</em>
        : unreadElsewhere && <i className="project-switch-dot" aria-hidden="true" />}
      <ChevronsUpDown size={14} aria-hidden="true" />
    </button>
  );
}

/** "#general", or "#general +2" for a bot linked to several channels. */
function botWhere(channels: Channel[], bot: Agent): string | undefined {
  const linked = channels.filter(ch => ch.type !== "dm" && ch.memberIds.includes(bot.id));
  if (!linked.length) return undefined;
  return `#${linked[0]!.name}${linked.length > 1 ? ` +${linked.length - 1}` : ""}`;
}

function ProjectSection({ project, snap, sel, go, unified, tools, find, onProjectSwitcher, onSettings, inboxBox, onNewChannel, dms,
  agentActions, onLaunch, agentWork, onUnread }: {
  project: Project;
  snap: Snapshot;
  sel: Sel;
  go: (next: Sel) => void;
  unified: boolean;
  /** The connection state for the header (rail layout only). */
  tools: ReactNode;
  /** The quick switcher button and message search, under the header. */
  find: ReactNode;
  onProjectSwitcher: () => void;
  onSettings: () => void;
  inboxBox: InboxBox;
  onNewChannel: (project: string) => void;
  dms: DmNav;
  agentActions: AgentActions;
  onLaunch: (project: string) => void;
  agentWork: Record<string, AgentWork>;
  onUnread: (channelId: string) => void;
}) {
  const { closedDms, closeDm, reopenDm, dmPicker, setDmPicker, dmPickQ, setDmPickQ, dmMenu, setDmMenu } = dms;
  const channels = snap.channels ?? [];

  const hideDm = (ch: Channel) => {
    closeDm(ch.id);
    setDmMenu(null);
    if (sel.kind === "channel" && sel.id === ch.id) {
      go({ kind: "inbox", project: ch.project });
    }
  };

  const showDm = (ch: Channel) => {
    reopenDm(ch.id);
    setDmPicker(null);
    setDmPickQ("");
    go({ kind: "channel", id: ch.id });
  };

  const publics = channels.filter(
    (c) => c.project === project.slug && (c.type === "public" || c.type === "brains" || c.type === "private"),
  );
  const archivedIds = new Set(snap.archivedChannelIds ?? []);
  const activeChannels = publics.filter(ch => !archivedIds.has(ch.id));
  const archivedChannels = publics.filter(ch => archivedIds.has(ch.id));
  const selectedArchived = sel.kind === "channel" && archivedChannels.some(ch => ch.id === sel.id) ? sel.id : null;
  const archivedSection = useRef<HTMLDetailsElement>(null);
  const hasArchived = archivedChannels.length > 0;
  // Keep native disclosure state (including manual toggles) in the DOM. Reveal
  // a newly selected archived channel, but never collapse it for the Human.
  useLayoutEffect(() => {
    if (archivedSection.current && selectedArchived) archivedSection.current.open = true;
  }, [selectedArchived, hasArchived]);
  const projectDms = channels.filter((c) => c.project === project.slug && c.type === "dm");
  const openDms = projectDms
    .filter((c) => !closedDms.includes(c.id))
    .sort((a, b) => {
      const unreadDelta = (snap.unread[b.id] ?? 0) - (snap.unread[a.id] ?? 0);
      if (unreadDelta) return unreadDelta;
      const mine = Number(!a.memberIds.includes("human")) - Number(!b.memberIds.includes("human"));
      if (mine) return mine;
      return a.name.localeCompare(b.name);
    });
  const withYou = openDms.filter(ch => ch.memberIds.includes("human"));
  const between = openDms.filter(ch => !ch.memberIds.includes("human"));
  const hiddenDms = projectDms
    .filter((c) => closedDms.includes(c.id))
    .filter((c) => !dmPickQ.trim() || c.name.toLowerCase().includes(dmPickQ.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hiveAgents = (snap.agents ?? []).filter((a) => a.role === "human" || a.project === project.slug);
  const online = hiveAgents.filter(a => a.online && (a.role === "brain" || a.role === "worker")).length;
  const botChannels = Object.fromEntries(hiveAgents.filter(a => a.role === "bot")
    .flatMap(bot => { const where = botWhere(channels, bot); return where ? [[bot.id, where]] : []; }));
  const n = snap.mentionCounts[project.slug] ?? 0;
  const inboxActive = sel.kind === "inbox" && sel.project === project.slug;
  const jevActive = sel.kind === "jev" && sel.project === project.slug;
  const channelRow = (ch: Channel) => (
    <ChannelItem
      key={ch.id}
      ch={ch}
      unread={snap.unread[ch.id] ?? 0}
      active={sel.kind === "channel" && sel.id === ch.id}
      onClick={() => go({ kind: "channel", id: ch.id })}
      onUnread={() => onUnread(ch.id)}
    />
  );
  const dmRow = (ch: Channel) => (
    <DmRow
      key={ch.id}
      ch={ch}
      unread={snap.unread[ch.id] ?? 0}
      active={sel.kind === "channel" && sel.id === ch.id}
      peer={ch.memberIds.includes("human") ? snap.agents.find(a => a.id !== "human" && ch.memberIds.includes(a.id)) : undefined}
      menuOpen={dmMenu === ch.id}
      onClick={() => go({ kind: "channel", id: ch.id })}
      onUnread={() => { setDmMenu(null); onUnread(ch.id); }}
      onMenu={() => setDmMenu((cur) => (cur === ch.id ? null : ch.id))}
      onClose={() => hideDm(ch)}
    />
  );
  return (
    <div className="project-sec">
      {/* The card above names the project in the single-sidebar layout; the heading stays for screen readers. */}
      <div className={`project-head ${unified ? "sr-only" : ""}`}>
        {unified ? <h2>{project.name}</h2> : <>
          <h2 title={project.name}>
            <button type="button" className="project-name" onClick={onProjectSwitcher} aria-haspopup="dialog">
              <span>{project.name}</span><ChevronDown size={14} aria-hidden="true" />
            </button>
          </h2>
          {tools}
          <button type="button" className="icon-btn project-settings" title="Project settings" aria-label={`Settings for ${project.name}`}
            onClick={onSettings}>
            <SlidersHorizontal size={15} aria-hidden="true" />
          </button>
        </>}
      </div>
      {find}
      <button
        className={`nav ${inboxActive ? "active" : ""}`}
        aria-current={inboxActive ? "page" : undefined}
        onClick={() => go({ kind: "inbox", project: project.slug, box: inboxBox })}
      >
        <Inbox className="nav-icon" size={15} aria-hidden="true" />
        <span>For you</span>
        {n > 0 && <em>{n}</em>}
      </button>
      {snap.jev?.enabled && (
        <button
          className={`nav ${jevActive ? "active" : ""}`}
          aria-current={jevActive ? "page" : undefined}
          onClick={() => go({ kind: "jev", project: project.slug })}
          title="Every request Hivemind sent to Jev (TypeSafe) and its answer"
        >
          <Route className="nav-icon" size={15} aria-hidden="true" />
          <span>Routing log</span>
        </button>
      )}
      <div className="group">
        <div className="group-h">
          <span>Channels</span>
          <button
            type="button"
            className="plus"
            onClick={() => onNewChannel(project.slug)}
            title="New channel"
            aria-label={`New channel in ${project.name}`}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {activeChannels.map(channelRow)}
        {archivedChannels.length > 0 && (
          <details className="archived-channels" ref={archivedSection}>
            <summary><ChevronRight size={13} aria-hidden="true" />Archived <span>{archivedChannels.length}</span></summary>
            {archivedChannels.map(channelRow)}
          </details>
        )}
      </div>
      <div className="group">
        <div className="group-h">
          <span>Direct messages</span>
          <button
            type="button"
            className="plus"
            data-dm-open={project.slug}
            title="Reopen a closed conversation"
            aria-label={`Open a closed conversation in ${project.name}`}
            onClick={() => {
              setDmMenu(null);
              setDmPickQ("");
              setDmPicker((cur) => (cur === project.slug ? null : project.slug));
            }}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {dmPicker === project.slug && (
          <div className="dm-picker">
            <input
              autoFocus
              value={dmPickQ}
              onChange={(e) => setDmPickQ(e.target.value)}
              placeholder="Find a closed conversation"
              aria-label="Find a closed conversation"
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
        {withYou.length === 0 && <p className="empty-mini">No conversations yet.</p>}
        {withYou.map(dmRow)}
        <details className="agent-conversations" open={sel.kind === "channel" && between.some(ch => ch.id === sel.id) ? true : undefined}>
          <summary><ChevronRight size={13} aria-hidden="true" />Between agents <span>{between.length}</span></summary>
          {between.map(dmRow)}
        </details>
      </div>
      <div className="group">
        <div className="group-h">
          <span>Hive</span>
          <small>{online} online</small>
        </div>
        <AgentList
          agents={hiveAgents}
          projectName={project.name}
          onCreateBot={() => agentActions.onCreateBot(project.id)}
          onLaunch={() => onLaunch(project.slug)}
          onManageBot={agentActions.onManageBot}
          queued={snap.queued ?? {}}
          inbox={snap.inbox}
          work={agentWork}
          botChannels={botChannels}
          onOpen={agentActions.onAgent}
          onAskClear={(name) => agentActions.onAskAgent(name, "clear")}
          onAskRemove={(name) => agentActions.onAskAgent(name, "remove")}
        />
      </div>
    </div>
  );
}
