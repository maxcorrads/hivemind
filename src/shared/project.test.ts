import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectSlug, resolveJoinProject } from "./project.ts";
import type { Project } from "./types.ts";

function p(slug: string, worktree: string | null = null): Project {
  return { id: slug, slug, name: slug, worktree, createdAt: 0 };
}

test("join project: flag wins, then worktree, then the only project", () => {
  const acme = p("acme", "/repo/acme");
  const altro = p("altro", "/repo/altro");
  assert.equal(resolveJoinProject([acme, altro], { project: "altro", cwd: "/repo/acme" }).slug, "altro");
  assert.equal(resolveJoinProject([acme, altro], { cwd: "/repo/altro" }).slug, "altro");
  assert.equal(resolveJoinProject([acme], { cwd: "/tmp" }).slug, "acme");
  assert.throws(() => resolveJoinProject([acme, altro], { cwd: "/tmp" }), /Pass project=slug/);
  assert.throws(() => resolveJoinProject([acme], { project: "missing" }), /No project/);
  assert.equal(parseProjectSlug("Alpha"), "alpha");
});
