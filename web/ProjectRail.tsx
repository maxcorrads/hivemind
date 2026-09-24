import type { Snapshot } from "./api.ts";
import { projectAttention, projectInitials } from "./nav-model.ts";

/** The narrow column of project icons: one per project, with unread, mention and decision marks. */
export function ProjectRail({ snap, selectedProject, awaitingDecisions, onSelect, onNewProject }: {
  snap: Snapshot;
  selectedProject: string;
  awaitingDecisions: Record<string, number>;
  onSelect: (slug: string) => void;
  onNewProject: () => void;
}) {
  return (
    <nav className="project-rail" aria-label="Projects">
      {snap.projects.map(project => {
        const { alerts, unread, decisions } = projectAttention(snap, project.slug, awaitingDecisions);
        const active = project.slug === selectedProject;
        const label = [project.name,
          alerts ? `${alerts} unread for you` : unread ? "unread messages" : "",
          decisions ? `${decisions} ${decisions === 1 ? "decision" : "decisions"} awaiting` : ""].filter(Boolean).join(", ");
        return (
          <button key={project.id} type="button" className={`rail-project ${active ? "active" : ""} ${unread || alerts ? "unread" : ""}`}
            aria-label={label} title={label} aria-current={active ? "page" : undefined} onClick={() => onSelect(project.slug)}>
            <span className="rail-initials" aria-hidden="true">{projectInitials(project.name)}</span>
            {alerts > 0
              ? <em className="rail-badge" aria-hidden="true">{alerts > 99 ? "99+" : alerts}</em>
              : unread && <i className="rail-dot" aria-hidden="true" />}
            {decisions > 0 && <i className="rail-decision" aria-hidden="true" />}
          </button>
        );
      })}
      <button type="button" className="rail-add" title="New project" aria-label="New project" onClick={onNewProject}>+</button>
    </nav>
  );
}
