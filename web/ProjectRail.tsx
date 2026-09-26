import { CircleHelp, Plus } from "lucide-react";
import type { Snapshot } from "./api.ts";
import { projectAttention, projectInitials } from "./nav-model.ts";
import { SettingsMenu, type SettingsMenuProps } from "./SettingsMenu.tsx";

/**
 * The narrow column of project tiles, with unread and mention marks, then Help, Settings and who you are at
 * the bottom. Those tools render only when `settings` is passed; without it the sidebar header keeps them.
 */
export function ProjectRail({ snap, selectedProject, onSelect, onNewProject, settings, live }: {
  snap: Snapshot;
  selectedProject: string;
  onSelect: (slug: string) => void;
  onNewProject: () => void;
  settings?: SettingsMenuProps;
  live?: boolean;
}) {
  return (
    <nav className="project-rail" aria-label="Projects">
      <img className="rail-mark" src="/icon.svg" alt="Hivemind" />
      {/* Only the tiles scroll: an overflow container would clip the Settings popover below. */}
      <div className="rail-projects">
        {snap.projects.map(project => {
          const { alerts, unread } = projectAttention(snap, project.slug);
          const active = project.slug === selectedProject;
          const label = [project.name, alerts ? `${alerts} unread for you` : unread ? "unread messages" : ""].filter(Boolean).join(", ");
          return (
            <button key={project.id} type="button" className={`rail-project ${active ? "active" : ""} ${unread || alerts ? "unread" : ""}`}
              aria-label={label} title={label} aria-current={active ? "page" : undefined} onClick={() => onSelect(project.slug)}>
              <span className="rail-initials" aria-hidden="true">{projectInitials(project.name)}</span>
              {alerts > 0
                ? <em className="rail-badge" aria-hidden="true">{alerts > 99 ? "99+" : alerts}</em>
                : unread && <i className="rail-dot" aria-hidden="true" />}
            </button>
          );
        })}
        <button type="button" className="rail-add" title="New project" aria-label="New project" onClick={onNewProject}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {settings && (
        <div className="rail-tools">
          <button type="button" className="icon-btn" title="How to join" aria-label="Help" onClick={settings.onHelp}>
            <CircleHelp size={17} aria-hidden="true" />
          </button>
          <SettingsMenu {...settings} iconOnly />
          <span className="rail-me" role="img" aria-label="You are Human" title="You are Human">
            Hu<i className={`sdot ${live ? "ok" : ""}`} aria-hidden="true" />
          </span>
        </div>
      )}
    </nav>
  );
}
