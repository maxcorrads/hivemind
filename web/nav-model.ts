import type { AgentWork, TaskState } from "../src/shared/tasks.ts";
import type { Agent, Channel, Project } from "../src/shared/types.ts";
import type { Snapshot } from "./api.ts";
import { hashFor, parseHash, type Sel } from "./selection.ts";

// Project rail, quick switcher, roster status and page title: pure helpers
// over the snapshot so the components stay thin and the rules are testable.

const PROJECT_KEY = "hivemind-project";
const VIEWS_KEY = "hivemind-project-views";

/** The project last shown in this browser, if any. */
export function loadSelectedProject(): string | null {
  try { return localStorage.getItem(PROJECT_KEY) || null; } catch { return null; }
}

export function saveSelectedProject(slug: string) {
  try { localStorage.setItem(PROJECT_KEY, slug); } catch { /* storage unavailable: the rail still works for this tab */ }
}

function loadViews(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

/** Remembers the view last open in a project, so switching back returns to it. */
export function saveProjectView(slug: string, sel: Sel) {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify({ ...loadViews(), [slug]: hashFor(sel) })); } catch { /* see above */ }
}

/** Where selecting `slug` on the rail goes: its last view while that still exists in the project, else For you. */
export function projectLanding(slug: string, snap: Pick<Snapshot, "channels">): Sel {
  const saved = loadViews()[slug];
  const view = typeof saved === "string" ? parseHash(saved) : null;
  if (view?.kind === "channel" && snap.channels.some(channel => channel.id === view.id && channel.project === slug)) return view;
  if (view && view.kind !== "channel") return { ...view, project: slug };
  return { kind: "inbox", project: slug };
}

/** DMs between the Human and one agent; conversations between agents never count as the Human's unread. */
export const isHumanDm = (channel: Channel) => channel.type === "dm" && channel.memberIds.includes("human");

export type ProjectAttention = {
  /** Unread mentions of the Human plus unread messages in the Human's DMs. */
  alerts: number;
  /** Any unread message in an active channel or a Human DM. */
  unread: boolean;
};

export function projectAttention(snap: Pick<Snapshot, "channels" | "unread" | "mentionCounts" | "archivedChannelIds">,
  slug: string): ProjectAttention {
  const archived = new Set(snap.archivedChannelIds ?? []);
  let dmUnread = 0, unread = false;
  for (const channel of snap.channels) {
    if (channel.project !== slug) continue;
    const n = snap.unread[channel.id] ?? 0;
    if (!n) continue;
    if (isHumanDm(channel)) { dmUnread += n; unread = true; }
    else if (channel.type !== "dm" && !archived.has(channel.id)) unread = true;
  }
  return { alerts: (snap.mentionCounts[slug] ?? 0) + dmUnread, unread };
}

/** The count shown in the browser tab: every project's alerts. */
export function attentionTotal(snap: Pick<Snapshot, "projects" | "channels" | "unread" | "mentionCounts" | "archivedChannelIds">) {
  return snap.projects.reduce((sum, project) => sum + projectAttention(snap, project.slug).alerts, 0);
}

export function documentTitle(count: number) {
  return count > 0 ? `(${count > 99 ? "99+" : count}) hivemind` : "hivemind";
}

/** Up to two letters for a project's rail icon. */
export function projectInitials(name: string) {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const STATE_LABEL: Record<TaskState, string> = {
  sent: "assigned", delivered: "assigned", accepted: "working", blocked: "blocked",
  result_submitted: "in review", changes_requested: "changes requested", rejected: "rejected", accepted_complete: "done", cancelled: "cancelled",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line under an agent's name: its current task and state, what it waits on, or idle/offline. */
export function agentStatusLine(agent: Agent, work?: AgentWork): string | null {
  if (agent.role === "human" || agent.role === "bot") return null;
  if (work?.task) {
    const { state, needed, objective } = work.task;
    const more = work.assigned > 1 ? ` (+${work.assigned - 1} more)` : "";
    return `${STATE_LABEL[state]}: ${state === "blocked" && needed ? needed : objective}${more}`;
  }
  if (work?.toReview) return `reviewing ${plural(work.toReview, "result")}`;
  if (work?.delegated) return `coordinating ${plural(work.delegated, "task")}`;
  return agent.online ? "idle" : "offline";
}

/** The quick switcher's shortcut as this platform writes it. */
export const SWITCHER_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

export type SwitchItem =
  | { key: string; kind: "project"; label: string; hint: string; project: Project }
  | { key: string; kind: "channel" | "dm"; label: string; hint: string; channel: Channel; unread: number }
  | { key: string; kind: "agent"; label: string; hint: string; agent: Agent };

const KIND_ORDER = { channel: 0, dm: 1, agent: 2, project: 3 } as const;

function score(label: string, q: string): number | null {
  const text = label.toLowerCase();
  if (text.startsWith(q)) return 0;
  if (new RegExp(`[\\s#_,.-]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)) return 1;
  return text.includes(q) ? 2 : null;
}

/**
 * Quick switcher entries for `query`: channels, DMs, agents and projects of the
 * whole hive, best match first and the current project ahead of others. An
 * empty query lists the current project's conversations, unread first.
 */
export function switcherItems(snap: Pick<Snapshot, "projects" | "channels" | "agents" | "unread" | "archivedChannelIds">,
  query: string, currentProject: string, limit = 50): SwitchItem[] {
  const projectName = (slug: string | null) => snap.projects.find(project => project.slug === slug)?.name ?? slug ?? "";
  const archived = new Set(snap.archivedChannelIds ?? []);
  const withHuman = new Set(snap.channels.filter(isHumanDm).flatMap(channel => channel.memberIds));
  const items: Array<{ item: SwitchItem; home: boolean; recent: boolean }> = [];
  for (const channel of snap.channels) {
    const dm = channel.type === "dm", unread = snap.unread[channel.id] ?? 0;
    const hint = [projectName(channel.project), dm && !isHumanDm(channel) ? "between agents" : "",
      archived.has(channel.id) ? "archived" : ""].filter(Boolean).join(" · ");
    items.push({ item: { key: `c:${channel.id}`, kind: dm ? "dm" : "channel", label: dm ? channel.name : `# ${channel.name}`, hint, channel, unread },
      home: channel.project === currentProject, recent: !archived.has(channel.id) && (!dm || isHumanDm(channel)) });
  }
  for (const agent of snap.agents) {
    // A DM with the Human already stands for this agent.
    if ((agent.role !== "brain" && agent.role !== "worker") || withHuman.has(agent.id)) continue;
    items.push({ item: { key: `a:${agent.id}`, kind: "agent", label: agent.name, hint: `${agent.role} · ${projectName(agent.project)}`, agent },
      home: agent.project === currentProject, recent: false });
  }
  for (const project of snap.projects)
    items.push({ item: { key: `p:${project.slug}`, kind: "project", label: project.name, hint: "project", project },
      home: project.slug === currentProject, recent: project.slug !== currentProject });
  const q = query.trim().toLowerCase().replace(/^#\s*/, "");
  const ranked = items.flatMap(({ item, home, recent }) => {
    if (!q) {
      // Nothing typed: this project's live conversations (unread first), then the other projects.
      if (item.kind === "project") return recent ? [{ item, rank: 2 }] : [];
      return home && recent ? [{ item, rank: item.kind !== "agent" && item.unread ? 0 : 1 }] : [];
    }
    const s = score(item.label.replace(/^# /, ""), q);
    return s === null ? [] : [{ item, rank: s * 2 + (home ? 0 : 1) }];
  });
  ranked.sort((a, b) => a.rank - b.rank || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.label.localeCompare(b.item.label));
  return ranked.slice(0, limit).map(({ item }) => item);
}

/** The project picker behind the sidebar's project card: every project matching `query`, the current one first. */
export function projectSwitchItems(snap: Pick<Snapshot, "projects">, query: string, currentProject: string): SwitchItem[] {
  const q = query.trim().toLowerCase();
  return snap.projects
    .flatMap(project => {
      const rank = q ? score(project.name, q) : 0;
      return rank === null ? [] : [{ project, rank }];
    })
    .sort((a, b) => a.rank - b.rank || Number(b.project.slug === currentProject) - Number(a.project.slug === currentProject)
      || a.project.name.localeCompare(b.project.name))
    .map(({ project }) => ({ key: `p:${project.slug}`, kind: "project" as const, label: project.name,
      hint: project.slug === currentProject ? "current" : "", project }));
}
