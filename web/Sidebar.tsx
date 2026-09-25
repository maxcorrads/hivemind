import { useLayoutEffect, useRef } from "react";
import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import type { AgentWork } from "../src/shared/tasks.ts";
import type { Agent, Channel, Project } from "../src/shared/types.ts";
import { AgentList } from "./AgentList.tsx";
import type { Snapshot } from "./api.ts";
import { ChannelItem, DmRow } from "./ChannelNav.tsx";
import type { DesktopNotifications } from "./desktop-notifications.ts";
import { ProjectRail } from "./ProjectRail.tsx";
import type { InboxBox, Sel } from "./selection.ts";
import { telegramDegraded } from "./telegram-health.ts";
import type { DmNav } from "./use-dm-nav.ts";
import type { ProjectSheets } from "./use-sheets.ts";

type AgentActions = {
  onAgent: (agent: Agent) => void;
  onCreateBot: (projectId: string) => void;
  onManageBot: (agent: Agent) => void;
  onAskAgent: (name: string, kind: "clear" | "remove") => void;
};

const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

/**
 * The project icon rail plus the sidebar of the selected project: brand and
 * tools, message search (which never filters this navigation), the quick
 * switcher and that project's sections.
 */
export function Sidebar({ snap, sel, go, live, theme, onToggleTheme, query, setQuery, onSearchNow, onTelegram,
  onAdaptiveRouting, onLaunch, onHelp, selectedProject, onSelectProject, onSwitcher, inboxBox, projectSheets, onNewChannel,
  dms, agentActions, agentWork, notifications, onUnread }: {
  snap: Snapshot;
  sel: Sel;
  go: (next: Sel) => void;
  live: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  query: string;
  setQuery: (query: string) => void;
  onSearchNow: () => void;
  onTelegram: () => void;
  onAdaptiveRouting: () => void;
  onLaunch: (project?: string | null) => void;
  onHelp: () => void;
  selectedProject: string;
  onSelectProject: (slug: string) => void;
  onSwitcher: () => void;
  inboxBox: InboxBox;
  projectSheets: ProjectSheets;
  onNewChannel: (project: string) => void;
  dms: DmNav;
  agentActions: AgentActions;
  agentWork: Record<string, AgentWork>;
  notifications: DesktopNotifications;
  onUnread: (channelId: string) => void;
}) {
  const projects = snap.projects ?? [];
  const project = projects.find(item => item.slug === selectedProject) ?? projects[0];
  return (
    <>
      <ProjectRail snap={snap} selectedProject={project?.slug ?? ""}
        onSelect={onSelectProject} onNewProject={() => projectSheets.setCreatingProject(true)} />
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
                  onClick={onToggleTheme}
                >
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </button>
                {notifications.supported && (
                  <button type="button" className="tool-action" aria-pressed={notifications.enabled}
                    title="Notify mentions and direct messages while Hivemind is in the background"
                    onClick={() => void notifications.toggle()}>
                    {notifications.blocked ? "Notifications blocked by the browser"
                      : `Desktop notifications: ${notifications.enabled ? "on" : "off"}`}
                  </button>
                )}
                <button
                  type="button"
                  className="tool-action"
                  title={telegramDegraded(snap.telegram) ? `Telegram · ${snap.telegram?.failures ?? 0} outbound failures · ${snap.telegram?.quarantined ?? 0} quarantined · ${snap.telegram?.retrying ?? 0} retrying${snap.telegram?.lastError ? ` · ${snap.telegram.lastError}` : ""}` : "Telegram"}
                  onClick={onTelegram}
                >
                  Telegram{telegramDegraded(snap.telegram) ? " · Needs attention" : ""}
                </button>
                <button
                  type="button"
                  className="tool-action"
                  title="Adaptive routing"
                  onClick={onAdaptiveRouting}
                >
                  Adaptive routing
                </button>
                <button type="button" className="tool-action" title="Launch agent" onClick={() => onLaunch()}>
                  Launch agent
                </button>
                <button type="button" className="tool-action" title="How to join" onClick={onHelp}>
                  Help
                </button>
              </div>
            </details>
            <span className={`pulse ${live ? "on" : ""}`} title={live ? "live" : "waiting"} role="img"
              aria-label={live ? "Connected" : "Not connected"} />
          </div>
        </div>
        <button type="button" className="switcher-open" onClick={onSwitcher} aria-keyshortcuts="Meta+K Control+K">
          <span>Jump to…</span><kbd>{shortcut}</kbd>
        </button>
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
        {projects.length > 0 && (
          <button type="button" className="launch-cta" onClick={() => onLaunch()}>
            <span aria-hidden="true">+</span> Launch agent
          </button>
        )}

        {!project && (
          <div className="group-h">
            <span>No projects.</span>
            <button type="button" className="plus" onClick={() => projectSheets.setCreatingProject(true)} title="New project"
              aria-label="New project">
              +
            </button>
          </div>
        )}
        {project && (
          <ProjectSection key={project.id} project={project} snap={snap} sel={sel} go={go}
            onSettings={() => projectSheets.editProject(project)} inboxBox={inboxBox} onNewChannel={onNewChannel}
            dms={dms} agentActions={agentActions} onLaunch={onLaunch} onUnread={onUnread}
            agentWork={agentWork} />
        )}
      </aside>
    </>
  );
}

function ProjectSection({ project, snap, sel, go, onSettings, inboxBox, onNewChannel, dms, agentActions, onLaunch,
  agentWork, onUnread }: {
  project: Project;
  snap: Snapshot;
  sel: Sel;
  go: (next: Sel) => void;
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
  const hiddenDms = projectDms
    .filter((c) => closedDms.includes(c.id))
    .filter((c) => !dmPickQ.trim() || c.name.toLowerCase().includes(dmPickQ.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hiveAgents = (snap.agents ?? []).filter((a) => a.role === "human" || a.project === project.slug);
  const n = snap.mentionCounts[project.slug] ?? 0;
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
      menuOpen={dmMenu === ch.id}
      onClick={() => go({ kind: "channel", id: ch.id })}
      onUnread={() => { setDmMenu(null); onUnread(ch.id); }}
      onMenu={() => setDmMenu((cur) => (cur === ch.id ? null : ch.id))}
      onClose={() => hideDm(ch)}
    />
  );
  return (
    <div className="project-sec">
      <div className="project-head">
        <h2 title={project.name}>{project.name}</h2>
        <button type="button" className="project-settings" title="Project settings" aria-label={`Settings for ${project.name}`}
          onClick={onSettings}>
          Settings
        </button>
      </div>
      <button
        className={`nav ${sel.kind === "inbox" && sel.project === project.slug ? "active" : ""}`}
        aria-current={sel.kind === "inbox" && sel.project === project.slug ? "page" : undefined}
        onClick={() => go({ kind: "inbox", project: project.slug, box: inboxBox })}
      >
        <span>For you</span>
        {n > 0 && <em>{n}</em>}
      </button>
      {snap.jev?.enabled && (
        <button
          className={`nav ${sel.kind === "jev" && sel.project === project.slug ? "active" : ""}`}
          aria-current={sel.kind === "jev" && sel.project === project.slug ? "page" : undefined}
          onClick={() => go({ kind: "jev", project: project.slug })}
          title="Every request Hivemind sent to Jev (TypeSafe) and its answer"
        >
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
            +
          </button>
        </div>
        {activeChannels.map(channelRow)}
        {archivedChannels.length > 0 && (
          <details className="archived-channels" ref={archivedSection}>
            <summary>Archived <span>{archivedChannels.length}</span></summary>
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
        <div className="subh">With you</div>
        {!openDms.some(ch => ch.memberIds.includes("human")) && <p className="empty-mini">No conversations yet.</p>}
        {openDms.filter(ch => ch.memberIds.includes("human")).map(dmRow)}
        <details className="agent-conversations" open={sel.kind === "channel" && openDms.some(ch => ch.id === sel.id && !ch.memberIds.includes("human")) ? true : undefined}>
          <summary>Between agents <span>{openDms.filter(ch => !ch.memberIds.includes("human")).length}</span></summary>
          {openDms.filter(ch => !ch.memberIds.includes("human")).map(dmRow)}
        </details>
      </div>
      <div className="group">
        <div className="group-h">
          <span>Hive</span>
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
          onOpen={agentActions.onAgent}
          onAskClear={(name) => agentActions.onAskAgent(name, "clear")}
          onAskRemove={(name) => agentActions.onAskAgent(name, "remove")}
        />
      </div>
    </div>
  );
}
