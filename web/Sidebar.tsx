import { isLiveSearchQuery } from "../src/shared/search-query.ts";
import type { Agent, Channel, Project } from "../src/shared/types.ts";
import { AgentList } from "./AgentList.tsx";
import type { Snapshot } from "./api.ts";
import { ChannelItem, DmRow } from "./ChannelNav.tsx";
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

/** The left rail: brand and tools, the search box and one section per project. */
export function Sidebar({ snap, sel, go, live, theme, onToggleTheme, query, setQuery, onSearchNow, onTelegram,
  onAdaptiveRouting, onLaunch, onHelp, selectedProject, inboxBox, projectSheets, onNewChannel, dms, agentActions }: {
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
  inboxBox: InboxBox;
  projectSheets: ProjectSheets;
  onNewChannel: (project: string) => void;
  dms: DmNav;
  agentActions: AgentActions;
}) {
  const projects = snap.projects ?? [];
  return (
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
            onSearchNow();
          }
        }}
        placeholder="Search projects and messages" aria-label="Search projects and messages"
      />
      {projects.length > 0 && (
        <button type="button" className="launch-cta" onClick={() => onLaunch()}>
          <span aria-hidden="true">+</span> Launch agent
        </button>
      )}

      <div className="group-h">
        <span>Projects</span>
        <button type="button" className="plus" onClick={() => projectSheets.setCreatingProject(true)} title="New project">
          +
        </button>
      </div>

      {projects.length === 0 && <p className="help-p">No projects.</p>}
      {projects.map((project) => (
        <ProjectSection key={project.id} project={project} snap={snap} sel={sel} go={go} query={query}
          open={projectSheets.openProjects[project.slug] ?? project.slug === selectedProject}
          onToggle={(open) => projectSheets.setOpenProjects((g) => ({ ...g, [project.slug]: open }))}
          onSettings={() => projectSheets.editProject(project)} inboxBox={inboxBox} onNewChannel={onNewChannel}
          dms={dms} agentActions={agentActions} onLaunch={onLaunch} />
      ))}
    </aside>
  );
}

function ProjectSection({ project, snap, sel, go, query, open, onToggle, onSettings, inboxBox, onNewChannel, dms, agentActions,
  onLaunch }: {
  project: Project;
  snap: Snapshot;
  sel: Sel;
  go: (next: Sel) => void;
  query: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  onSettings: () => void;
  inboxBox: InboxBox;
  onNewChannel: (project: string) => void;
  dms: DmNav;
  agentActions: AgentActions;
  onLaunch: (project: string) => void;
}) {
  const { closedDms, closeDm, reopenDm, dmPicker, setDmPicker, dmPickQ, setDmPickQ, dmMenu, setDmMenu } = dms;
  const channels = snap.channels ?? [];
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);

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
  const n = snap.mentionCounts[project.slug] ?? 0;
  const dmRow = (ch: Channel) => (
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
  );
  return (
    <div className="project-sec">
      <div className="group-h">
        <button
          type="button"
          className="twist"
          onClick={() => onToggle(!open)}
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
          onClick={onSettings}
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
                onClick={() => onNewChannel(project.slug)}
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
            {openDms.filter(ch => ch.memberIds.includes("human")).map(dmRow)}
            <details className="agent-conversations" open={q || (sel.kind === "channel" && openDms.some(ch => ch.id === sel.id && !ch.memberIds.includes("human"))) ? true : undefined}>
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
              onOpen={agentActions.onAgent}
              onAskClear={(name) => agentActions.onAskAgent(name, "clear")}
              onAskRemove={(name) => agentActions.onAskAgent(name, "remove")}
            />
          </div>
        </>
      )}
    </div>
  );
}
