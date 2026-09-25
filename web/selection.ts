import type { Snapshot } from "./api.ts";

export type InboxBox = "unread" | "all";

export type Sel =
  | { kind: "inbox"; project: string; box?: InboxBox }
  | { kind: "decisions"; project: string }
  /** Routing log: every Jev exchange of a project. Hash `#/routing-log/<project>`; `#/jev/<project>` is an alias. */
  | { kind: "jev"; project: string }
  /** Mobile list screens (#223): a project's channels (`#/home/<project>`) and its direct messages (`#/dms/<project>`). */
  | { kind: "home"; project: string }
  | { kind: "dms"; project: string }
  | { kind: "channel"; id: string; thread?: string | null };

export function parseHash(hash: string = location.hash): Sel {
  const raw = hash.replace(/^#/, "") || "/c/general";
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "inbox") {
    return {
      kind: "inbox",
      project: parts[1] ? decodeURIComponent(parts[1]) : "",
      box: parts[2] === "all" ? "all" : "unread",
    };
  }
  if (parts[0] === "decisions") return { kind: "decisions", project: parts[1] ? decodeURIComponent(parts[1]) : "" };
  if (parts[0] === "home" || parts[0] === "dms") return { kind: parts[0], project: parts[1] ? decodeURIComponent(parts[1]) : "" };
  if (parts[0] === "routing-log" || parts[0] === "jev") return { kind: "jev", project: parts[1] ? decodeURIComponent(parts[1]) : "" };
  if (parts[1]) {
    const thread = parts[2] === "t" && parts[3] ? decodeURIComponent(parts[3]) : undefined;
    return { kind: "channel", id: decodeURIComponent(parts[1]), thread };
  }
  return { kind: "channel", id: "general" };
}

/** The location hash (without `#`) that `parseHash` reads back as `sel`. */
export function hashFor(sel: Sel): string {
  return sel.kind === "inbox"
    ? `${sel.project ? `/inbox/${encodeURIComponent(sel.project)}` : "/inbox"}${sel.box === "all" ? "/all" : ""}`
    : sel.kind !== "channel"
      ? `/${sel.kind === "jev" ? "routing-log" : sel.kind}${sel.project ? `/${encodeURIComponent(sel.project)}` : ""}`
      : `/c/${encodeURIComponent(sel.id)}${sel.thread ? `/t/${encodeURIComponent(sel.thread)}` : ""}`;
}

export function setHash(sel: Sel) {
  location.hash = hashFor(sel);
}

/**
 * A valid replacement when `sel` points at a project or channel the snapshot no longer has; null when it is fine.
 * Replacements land in `preferred` (the project last shown in this browser) while it exists, else the first project.
 */
export function repairSel(sel: Sel, snap: Pick<Snapshot, "projects" | "channels" | "jev">, preferred?: string | null): Sel | null {
  const fallback = snap.projects.find((p) => p.slug === preferred) ?? snap.projects[0];
  // The Routing log exists only while Jev is on: its link then opens the project's For you.
  if (sel.kind === "jev" && !snap.jev?.enabled) {
    const project = snap.projects.find((p) => p.slug === sel.project) ?? fallback;
    return { kind: "inbox", project: project?.slug ?? "" };
  }
  if (sel.kind !== "channel") {
    if (!sel.project) return fallback ? { ...sel, project: fallback.slug } : null;
    if (snap.projects.some((p) => p.slug === sel.project)) return null;
    return fallback ? { ...sel, project: fallback.slug } : { ...sel, project: "" };
  }
  if (snap.channels.some((c) => c.id === sel.id)) return null;
  return fallback ? { kind: "inbox", project: fallback.slug } : { kind: "inbox", project: "" };
}
