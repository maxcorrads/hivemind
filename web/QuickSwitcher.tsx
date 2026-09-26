import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CornerDownLeft, Hash, Lock, Plus, Search } from "lucide-react";
import type { Snapshot } from "./api.ts";
import { avatarHue } from "./labels.ts";
import { Modal } from "./Modal.tsx";
import { projectInitials, projectSwitchItems, switcherItems, type SwitchItem } from "./nav-model.ts";

const GROUP_LABEL = { channel: "Channels", dm: "Direct messages", agent: "Agents", project: "Projects" } as const;

/** The row's tile, drawn as the sidebar draws it: hash or lock, tinted initials for people, initials for projects. */
function Tile({ item, snap }: { item: SwitchItem; snap: Snapshot }) {
  if (item.kind === "channel") {
    const Icon = item.channel.type === "private" ? Lock : Hash;
    return <span className="switcher-tile" aria-hidden="true"><Icon size={14} /></span>;
  }
  if (item.kind === "project") return <span className="switcher-tile" aria-hidden="true">{projectInitials(item.label)}</span>;
  const name = item.kind === "agent" ? item.agent.name
    : snap.agents.find(agent => agent.id !== "human" && item.channel.memberIds.includes(agent.id))?.name ?? item.label;
  return <span className="switcher-tile avatar" aria-hidden="true" style={{ "--h": String(avatarHue(name)) } as CSSProperties}>
    {name.slice(0, 2)}</span>;
}

/**
 * Cmd/Ctrl+K: jump to any channel, DM, agent or project by typing part of its name. With scope "projects"
 * it is the project picker of the single-sidebar layout, which has no rail: every project plus New project.
 * Matches are grouped by kind, the groups in the order of their best match, so the first row stays the best one.
 */
export function QuickSwitcher({ snap, currentProject, onPick, onClose, scope = "all", onNewProject }: {
  snap: Snapshot;
  currentProject: string;
  onPick: (item: SwitchItem) => void;
  onClose: () => void;
  scope?: "all" | "projects";
  onNewProject?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const projectsOnly = scope === "projects";
  const groups = useMemo(() => {
    const ranked = projectsOnly ? projectSwitchItems(snap, query, currentProject) : switcherItems(snap, query, currentProject);
    return [...new Set(ranked.map(item => item.kind))].map(kind => ({ kind, items: ranked.filter(item => item.kind === kind) }));
  }, [snap, query, currentProject, projectsOnly]);
  // Arrow keys walk the rows in the order they are shown.
  const items = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const current = items[Math.min(active, items.length - 1)];
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (current) document.getElementById(`switch-${current.key}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  return (
    <Modal onClose={onClose}>
      <div className="sheet switcher" role="dialog" aria-modal="true" aria-label={projectsOnly ? "Switch project" : "Jump to"}>
        <div className="switcher-field">
          <Search size={18} aria-hidden="true" />
          <input className="switcher-input" autoFocus value={query} onChange={event => setQuery(event.target.value)}
            role="combobox" aria-expanded="true" aria-controls="switcher-options" aria-autocomplete="list"
            aria-activedescendant={current ? `switch-${current.key}` : undefined}
            aria-label={projectsOnly ? "Find a project" : "Jump to a channel, conversation, agent or project"}
            placeholder={projectsOnly ? "Switch project…" : "Jump to…"}
            onKeyDown={event => {
              const last = items.length - 1;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(index => (Math.min(index, last) + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1));
              } else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); setActive(0); }
              else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); setActive(last); }
              else if (event.key === "Enter" && current) { event.preventDefault(); onPick(current); }
            }} />
          <kbd className="kbd" aria-hidden="true">esc</kbd>
        </div>
        <ul className="switcher-options" id="switcher-options" role="listbox" aria-label="Matches">
          {groups.map(group => (
            <li key={group.kind} role="presentation">
              <ul role="group" aria-labelledby={`switch-group-${group.kind}`}>
                {/* The project picker lists only projects: a visible heading would just repeat the dialog's name. */}
                <li role="presentation" id={`switch-group-${group.kind}`} className={projectsOnly ? "sr-only" : "switcher-group"}>
                  {GROUP_LABEL[group.kind]}</li>
                {group.items.map(item => {
                  const index = items.indexOf(item);
                  // Under the Projects heading "project" says nothing; the current one is worth pointing out.
                  const hint = item.kind === "project" && !projectsOnly ? (item.project.slug === currentProject ? "current project" : "") : item.hint;
                  return (
                    <li key={item.key} id={`switch-${item.key}`} role="option" aria-selected={item === current}
                      className={item === current ? "active" : ""}
                      onPointerMove={() => { if (index !== active) setActive(index); }}
                      onClick={() => onPick(item)}>
                      <Tile item={item} snap={snap} />
                      {/* The tile draws the hash; the label still reads "# name", as the sidebar row does. */}
                      <span className="switcher-label">{item.kind === "channel"
                        ? <><span className="sr-only"># </span>{item.channel.name}</> : item.label}</span>
                      {hint && <span className="switcher-hint">{hint}</span>}
                      {(item.kind === "channel" || item.kind === "dm") && item.unread > 0 && <em className="count">{item.unread}</em>}
                      {item === current && <CornerDownLeft className="switcher-enter" size={14} aria-hidden="true" />}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="empty-mini">{projectsOnly ? "No project matches." : "No channel, conversation, agent or project matches."}</p>}
        {projectsOnly && onNewProject && <button type="button" className="btn btn-ghost switcher-new" onClick={onNewProject}>
          <Plus size={14} aria-hidden="true" />New project</button>}
        <p className="switcher-keys">
          <span><kbd>↑ ↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>
          <span className="switcher-scope">{projectsOnly ? "Projects" : "Channels · DMs · Agents · Projects"}</span>
        </p>
      </div>
    </Modal>
  );
}
