import type { Agent } from "../src/shared/types.ts";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { ProjectSheets } from "./use-sheets.ts";

export function ProjectSettingsSheet({ form, project, agents, onPlugins, refreshSnap, setErr }: {
  form: ProjectSheets;
  /** Slug of the project being edited. */
  project: string;
  agents: Agent[];
  onPlugins: () => void;
  refreshSnap: () => Promise<unknown>;
  setErr: (error: string) => void;
}) {
  const { setEditingProject, newProjectName, setNewProjectName, newProjectTree, setNewProjectTree,
    projectDeleteConfirm, setProjectDeleteConfirm, deletingProject, setDeletingProject } = form;
  const editingBusy = agents.filter((a) => a.role !== "human" && a.project === project && a.online);
  const canDeleteProject =
    !deletingProject &&
    projectDeleteConfirm.trim().toLowerCase() === project &&
    editingBusy.length === 0;
  const close = () => {
    setEditingProject(null);
    setProjectDeleteConfirm("");
  };

  return (
    <Modal onClose={close}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          api
            .updateProject(project, {
              name: newProjectName.trim(),
              worktree: newProjectTree.trim() || null,
            })
            .then(async () => {
              close();
              await refreshSnap();
            })
            .catch((ex) => setErr(String(ex.message || ex)));
        }}
      >
        <h2>Project {project}</h2>
        <button type="button" className="text-btn" onClick={onPlugins}>Plugins…</button>
        <label>
          Name
          <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} autoFocus />
        </label>
        <label>
          Worktree
          <input value={newProjectTree} onChange={(e) => setNewProjectTree(e.target.value)} placeholder="absolute path" />
        </label>
        <p className="help-p">Join from this path, or pass project={project}. Agents cannot see other projects.</p>
        <div className="row">
          <button type="button" onClick={close}>
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
            Type {project} to delete
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
                  .deleteProject(project)
                  .then(async () => {
                    close();
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
  );
}

export function CreateProjectSheet({ form, refreshSnap, setErr }: {
  form: ProjectSheets;
  refreshSnap: () => Promise<unknown>;
  setErr: (error: string) => void;
}) {
  const { setCreatingProject, newProjectName, setNewProjectName, newProjectSlug, setNewProjectSlug,
    newProjectTree, setNewProjectTree, setOpenProjects } = form;
  return (
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
  );
}
