import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Channel } from "../src/shared/types.ts";
import { avatarHue, channelTitle, memberNames, seniorityBars, upsertById } from "./labels.ts";
import { escapeRegExp, renderSearchBody } from "./search-highlight.tsx";

const agent = (id: string, role: Agent["role"], seniority: Agent["seniority"] = null): Agent => ({ id, name: id.toUpperCase(),
  role, seniority, focus: null, online: true, lastSeenAt: 0, createdAt: 0, projectId: null, project: null });
const channel = (type: Channel["type"], memberIds: string[] = []): Channel => ({ id: "c", name: "room", type, topic: null,
  createdBy: "human", createdAt: 0, memberIds, projectId: "p", project: "alpha" });

test("seniority bars only apply to workers", () => {
  assert.equal(seniorityBars(agent("b", "brain", "senior")), 0);
  assert.equal(seniorityBars(agent("w", "worker", "senior")), 3);
  assert.equal(seniorityBars(agent("w", "worker", "mid")), 2);
  assert.equal(seniorityBars(agent("w", "worker", "junior")), 1);
  assert.equal(seniorityBars(agent("w", "worker")), 1);
});

test("channel titles and member names", () => {
  assert.equal(channelTitle(channel("dm")), "room");
  assert.equal(channelTitle(channel("public")), "#room");
  assert.equal(memberNames(channel("public"), []), "No members");
  assert.equal(memberNames(channel("public", ["a", "gone", "b"]), [agent("a", "brain"), agent("b", "worker")]), "A, B");
});

test("avatar hue is a stable angle", () => {
  assert.equal(avatarHue("Ab"), (65 + 98) % 360);
  assert.ok(avatarHue("Forge") >= 0 && avatarHue("Forge") < 360);
});

test("upsertById replaces in place or appends", () => {
  const list = [{ id: "a", v: 1 }, { id: "b", v: 2 }];
  assert.deepEqual(upsertById(list, { id: "a", v: 3 }), [{ id: "a", v: 3 }, { id: "b", v: 2 }]);
  assert.deepEqual(upsertById(list, { id: "c", v: 4 }), [...list, { id: "c", v: 4 }]);
  assert.deepEqual(list, [{ id: "a", v: 1 }, { id: "b", v: 2 }]);
});

test("search highlighting escapes tokens and marks every match", () => {
  assert.equal(escapeRegExp("a.b*(c)"), "a\\.b\\*\\(c\\)");
  const html = renderToStaticMarkup(<>{renderSearchBody("Deploy a.b then DEPLOY", "deploy a.b")}</>);
  assert.equal(html, '<mark class="hit">Deploy</mark> <mark class="hit">a.b</mark> then <mark class="hit">DEPLOY</mark>');
  assert.equal(renderToStaticMarkup(<>{renderSearchBody("plain", "")}</>), "plain");
});
