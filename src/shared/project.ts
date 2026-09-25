import { realpathSync } from "node:fs";
import { HiveError, type Project } from "./types.ts";

export function parseProjectSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    throw new HiveError(400, "Project slug must be 1–32 characters: lowercase letters, digits, hyphen");
  }
  return slug;
}

export function canonicalWorktree(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  try {
    return realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

export function resolveJoinProject(
  projects: Project[],
  input: { project?: string | null; cwd?: string | null },
): Project {
  if (input.project) {
    const slug = parseProjectSlug(input.project);
    const hit = projects.find((p) => p.slug === slug);
    if (!hit) throw new HiveError(404, `No project named ${slug}`);
    return hit;
  }
  const cwd = canonicalWorktree(input.cwd);
  if (cwd) {
    const hit = projects.find((p) => p.worktree && canonicalWorktree(p.worktree) === cwd);
    if (hit) return hit;
  }
  if (projects.length === 1) return projects[0]!;
  const slugs = projects.map((p) => p.slug).join(", ");
  throw new HiveError(
    400,
    `Pass project=slug. cwd is not a registered worktree. Projects: ${slugs || "none"}`,
  );
}
