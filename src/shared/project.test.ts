import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectSlug, resolveJoinProject } from "./project.ts";
import type { Project } from "./types.ts";

function p(slug: string, worktree: string | null = null): Project {
  return { id: slug, slug, name: slug, worktree, createdAt: 0 };
}

test("join project: flag wins, then worktree, then the only project", () => {
  const chapter = p("chapter", "/repo/chapter");
  const altro = p("altro", "/repo/altro");
  assert.equal(resolveJoinProject([chapter, altro], { project: "altro", cwd: "/repo/chapter" }).slug, "altro");
  assert.equal(resolveJoinProject([chapter, altro], { cwd: "/repo/altro" }).slug, "altro");
  assert.equal(resolveJoinProject([chapter], { cwd: "/tmp" }).slug, "chapter");
  assert.throws(() => resolveJoinProject([chapter, altro], { cwd: "/tmp" }), /Pass project=slug/);
  assert.throws(() => resolveJoinProject([chapter], { project: "missing" }), /No project/);
  assert.equal(parseProjectSlug("Alpha"), "alpha");
});
