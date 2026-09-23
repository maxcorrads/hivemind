import assert from "node:assert/strict";
import { test } from "node:test";
import type { Channel, Project } from "../src/shared/types.ts";
import { hashFor, parseHash, repairSel, type Sel } from "./selection.ts";

const project = (slug: string): Project => ({ id: `p-${slug}`, slug, name: slug, worktree: null, createdAt: 0 });
const channel = (id: string, slug = "alpha"): Channel => ({ id, name: id, type: "public", topic: null, createdBy: "human",
  createdAt: 0, memberIds: ["human"], projectId: `p-${slug}`, project: slug });

test("parseHash defaults to #general and reads every route", () => {
  assert.deepEqual(parseHash(""), { kind: "channel", id: "general", thread: undefined });
  assert.deepEqual(parseHash("#/"), { kind: "channel", id: "general" });
  assert.deepEqual(parseHash("#/c/ch%201"), { kind: "channel", id: "ch 1", thread: undefined });
  assert.deepEqual(parseHash("#/c/ch/t/root%2F1"), { kind: "channel", id: "ch", thread: "root/1" });
  assert.deepEqual(parseHash("#/c/ch/t"), { kind: "channel", id: "ch", thread: undefined });
  assert.deepEqual(parseHash("#/inbox"), { kind: "inbox", project: "", box: "unread" });
  assert.deepEqual(parseHash("#/inbox/alpha/all"), { kind: "inbox", project: "alpha", box: "all" });
  assert.deepEqual(parseHash("#/inbox/alpha/other"), { kind: "inbox", project: "alpha", box: "unread" });
  assert.deepEqual(parseHash("#/decisions/alpha"), { kind: "decisions", project: "alpha" });
  assert.deepEqual(parseHash("#/decisions"), { kind: "decisions", project: "" });
  assert.deepEqual(parseHash("#/routing-log/alpha"), { kind: "jev", project: "alpha" });
  assert.deepEqual(parseHash("#/jev/alpha"), { kind: "jev", project: "alpha" });
});

test("hashFor round-trips through parseHash", () => {
  const selections: Sel[] = [
    { kind: "inbox", project: "alpha", box: "unread" },
    { kind: "inbox", project: "alpha", box: "all" },
    { kind: "inbox", project: "", box: "unread" },
    { kind: "decisions", project: "a b" },
    { kind: "jev", project: "alpha" },
    { kind: "channel", id: "ch/1", thread: undefined },
    { kind: "channel", id: "ch", thread: "root 1" },
  ];
  for (const sel of selections) assert.deepEqual(parseHash(`#${hashFor(sel)}`), sel);
  assert.equal(hashFor({ kind: "jev", project: "" }), "/routing-log");
  assert.equal(hashFor({ kind: "inbox", project: "alpha" }), "/inbox/alpha");
  assert.equal(hashFor({ kind: "channel", id: "ch", thread: null }), "/c/ch");
});

test("repairSel keeps valid selections and falls back to the first project", () => {
  const snap = { projects: [project("alpha"), project("beta")], channels: [channel("general")] };
  assert.equal(repairSel({ kind: "channel", id: "general" }, snap), null);
  assert.equal(repairSel({ kind: "inbox", project: "beta" }, snap), null);
  assert.deepEqual(repairSel({ kind: "inbox", project: "", box: "all" }, snap), { kind: "inbox", project: "alpha", box: "all" });
  assert.deepEqual(repairSel({ kind: "decisions", project: "gone" }, snap), { kind: "decisions", project: "alpha" });
  assert.deepEqual(repairSel({ kind: "jev", project: "gone" }, snap), { kind: "jev", project: "alpha" });
  assert.deepEqual(repairSel({ kind: "channel", id: "gone" }, snap), { kind: "inbox", project: "alpha" });
});

test("repairSel without projects", () => {
  const empty = { projects: [], channels: [] };
  assert.equal(repairSel({ kind: "inbox", project: "" }, empty), null);
  assert.deepEqual(repairSel({ kind: "jev", project: "gone" }, empty), { kind: "jev", project: "" });
  assert.deepEqual(repairSel({ kind: "channel", id: "gone" }, empty), { kind: "inbox", project: "" });
});
