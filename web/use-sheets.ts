import { useEffect, useState } from "react";
import type { Project } from "../src/shared/types.ts";
import { api, type Snapshot, type TelegramSettings } from "./api.ts";

// Sheet form state lives above the sheets so a cancelled draft is still there
// when the sheet opens again.

/** New-channel and invite sheets. */
export function useChannelSheets() {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [newType, setNewType] = useState<"public" | "private">("public");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [createIn, setCreateIn] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteNames, setInviteNames] = useState<string[]>([]);
  return {
    creating, setCreating, newName, setNewName, newTopic, setNewTopic, newType, setNewType, newMembers, setNewMembers,
    createIn, setCreateIn, inviteOpen, setInviteOpen, inviteNames, setInviteNames,
  };
}

export type ChannelSheets = ReturnType<typeof useChannelSheets>;

/**
 * Sidebar project sections plus the new-project and project-settings sheets
 * (which share the name and worktree fields). Sheets aimed at a project that
 * disappeared from the snapshot close.
 */
export function useProjectSheets(snap: Snapshot | null, { createIn, setCreateIn }: Pick<ChannelSheets, "createIn" | "setCreateIn">) {
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [newProjectTree, setNewProjectTree] = useState("");
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    if (!snap) return;
    if (editingProject && !snap.projects.some((p) => p.slug === editingProject)) {
      setEditingProject(null);
      setProjectDeleteConfirm("");
      setDeletingProject(false);
    }
    if (createIn && !snap.projects.some((p) => p.slug === createIn)) setCreateIn(null);
  }, [snap, editingProject, createIn]);

  const editProject = (project: Project) => {
    setEditingProject(project.slug);
    setNewProjectName(project.name);
    setNewProjectTree(project.worktree ?? "");
    setProjectDeleteConfirm("");
  };

  return {
    openProjects, setOpenProjects, creatingProject, setCreatingProject, editingProject, setEditingProject,
    newProjectName, setNewProjectName, newProjectSlug, setNewProjectSlug, newProjectTree, setNewProjectTree,
    projectDeleteConfirm, setProjectDeleteConfirm, deletingProject, setDeletingProject, editProject,
  };
}

export type ProjectSheets = ReturnType<typeof useProjectSheets>;

/** The Telegram sheet opens only once the saved settings are loaded into its fields. */
export function useTelegramSheet(setErr: (error: string) => void) {
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgUsers, setTgUsers] = useState("");
  const [tgGroups, setTgGroups] = useState<Record<string, string>>({});

  const openTelegram = (projects: Project[]) => {
    api
      .telegram()
      .then((t) => {
        setTelegram(t);
        setTgToken("");
        setTgUsers(t.allowUserIds.join(", "));
        setTgGroups(
          Object.fromEntries(
            projects.map((p) => [
              p.slug,
              t.projects[p.slug] != null ? String(t.projects[p.slug]) : "",
            ]),
          ),
        );
        setTelegramOpen(true);
      })
      .catch((e) => setErr(String(e.message || e)));
  };

  return {
    telegramOpen, setTelegramOpen, telegram, setTelegram, tgToken, setTgToken, tgUsers, setTgUsers, tgGroups, setTgGroups,
    openTelegram,
  };
}

export type TelegramSheetState = ReturnType<typeof useTelegramSheet>;

/** Clear-context and remove confirmations for a brain or worker. */
export function useAgentConfirm(refreshSnap: () => Promise<unknown>, setErr: (error: string) => void) {
  const [agentConfirm, setAgentConfirm] = useState<{ name: string; kind: "clear" | "remove" } | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);

  const onAgentConfirm = async () => {
    if (!agentConfirm) return;
    setAgentBusy(true);
    try {
      if (agentConfirm.kind === "clear") await api.clearContext(agentConfirm.name);
      else await api.removeAgent(agentConfirm.name);
      setAgentConfirm(null);
      await refreshSnap();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setAgentBusy(false);
    }
  };

  return { agentConfirm, setAgentConfirm, agentBusy, onAgentConfirm };
}

export type AgentConfirm = ReturnType<typeof useAgentConfirm>;
