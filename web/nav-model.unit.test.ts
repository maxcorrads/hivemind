import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentWork } from "../src/shared/tasks.ts";
import type { Agent, Channel, Message, Project } from "../src/shared/types.ts";
import type { DecisionView } from "../src/shared/decisions.ts";
import { noticeFor } from "./desktop-notifications.ts";
import { agentStatusLine, attentionTotal, documentTitle, projectAttention, projectInitials, switcherItems } from "./nav-model.ts";

const project = (slug: string, name = slug): Project => ({ id: `p-${slug}`, slug, name, worktree: null, createdAt: 0 });
const channel = (id: string, name: string, slug: string, type: Channel["type"] = "public", memberIds: string[] = []): Channel =>
  ({ id, name, type, topic: null, createdBy: "human", createdAt: 0, memberIds, projectId: `p-${slug}`, project: slug });
const agent = (id: string, role: Agent["role"], slug: string | null, online = true): Agent =>
  ({ id, name: id, role, seniority: role === "worker" ? "mid" : null, focus: null, online, lastSeenAt: 0, createdAt: 0, projectId: slug && `p-${slug}`, project: slug });

const projects = [project("alpha", "Alpha Hive"), project("beta", "Beta")];
const channels = [
  channel("gen", "general", "alpha"), channel("old", "old-room", "alpha"),
  channel("dm-ada", "Ada", "alpha", "dm", ["human", "ada"]), channel("dm-agents", "Ada, Bo", "alpha", "dm", ["ada", "bo"]),
  channel("beta-gen", "general", "beta"), channel("release", "release", "beta"),
];
const snap = { projects, channels, archivedChannelIds: ["old"], agents: [agent("human", "human", null), agent("ada", "brain", "alpha"),
  agent("bo", "worker", "alpha"), agent("cy", "worker", "beta"), agent("hook", "bot", "beta")],
  unread: { gen: 2, old: 9, "dm-ada": 3, "dm-agents": 5, release: 1 }, mentionCounts: { alpha: 1, beta: 0 } };

test("project attention counts mentions and Human DMs, ignores archived rooms and agent-only DMs", () => {
  assert.deepEqual(projectAttention(snap, "alpha", { alpha: 2 }), { alerts: 4, unread: true, decisions: 2 });
  assert.deepEqual(projectAttention(snap, "beta"), { alerts: 0, unread: true, decisions: 0 });
  const quiet = { ...snap, unread: { old: 9, "dm-agents": 5 }, mentionCounts: {} };
  assert.deepEqual(projectAttention(quiet, "alpha"), { alerts: 0, unread: false, decisions: 0 });
  assert.equal(attentionTotal(snap), 4);
  assert.equal(documentTitle(0), "hivemind");
  assert.equal(documentTitle(4), "(4) hivemind");
  assert.equal(documentTitle(120), "(99+) hivemind");
});

test("project initials", () => {
  assert.equal(projectInitials("Alpha Hive"), "AH");
  assert.equal(projectInitials("chapter"), "CH");
  assert.equal(projectInitials("my-app"), "MA");
});

test("agent status line names the current task and state", () => {
  const work = (extra: Partial<AgentWork>): AgentWork => ({ task: null, assigned: 0, delegated: 0, toReview: 0, ...extra });
  const task = (state: NonNullable<AgentWork["task"]>["state"], needed: string | null = null) =>
    ({ id: "t", channelId: "c", state, objective: "Draft the API", needed });
  const bo = agent("bo", "worker", "alpha");
  assert.equal(agentStatusLine(bo, work({ task: task("blocked", "API contract"), assigned: 1 })), "blocked: API contract");
  assert.equal(agentStatusLine(bo, work({ task: task("accepted"), assigned: 3 })), "working: Draft the API (+2 more)");
  assert.equal(agentStatusLine(bo, work({ task: task("sent"), assigned: 1 })), "assigned: Draft the API");
  assert.equal(agentStatusLine(agent("ada", "brain", "alpha"), work({ delegated: 3, toReview: 1 })), "reviewing 1 result");
  assert.equal(agentStatusLine(agent("ada", "brain", "alpha"), work({ delegated: 2 })), "coordinating 2 tasks");
  assert.equal(agentStatusLine(bo), "idle");
  assert.equal(agentStatusLine(agent("bo", "worker", "alpha", false)), "offline");
  assert.equal(agentStatusLine(agent("hook", "bot", "beta")), null);
  assert.equal(agentStatusLine(agent("human", "human", null)), null);
});

test("switcher lists the current project's live conversations when empty and ranks matches", () => {
  const empty = switcherItems(snap, "", "alpha").map(item => item.label);
  assert.deepEqual(empty, ["# general", "Ada", "Beta"], "unread first, no archived rooms or agent-only DMs, other projects last");
  assert.deepEqual(switcherItems(snap, "gen", "beta").map(item => `${item.label} ${item.hint}`), ["# general Beta", "# general Alpha Hive"]);
  assert.deepEqual(switcherItems(snap, "#old", "alpha").map(item => item.hint), ["Alpha Hive · archived"]);
  assert.ok(switcherItems(snap, "bo", "alpha").some(item => item.kind === "agent" && item.agent.id === "bo"), "agents without a Human DM are listed");
  assert.ok(!switcherItems(snap, "ada", "alpha").some(item => item.kind === "agent"), "the Human DM stands for Ada");
  assert.ok(!switcherItems(snap, "hook", "alpha").some(item => item.kind === "agent"), "bots are not DM targets");
  assert.deepEqual(switcherItems(snap, "beta", "alpha").map(item => item.kind), ["project"]);
  assert.deepEqual(switcherItems(snap, "(", "alpha"), [], "regex characters are literal");
});

test("desktop notices cover mentions, Human DMs and new decisions only", () => {
  const message = (extra: Partial<Message>): Message => ({ id: "m", seq: 1, channelId: "gen", threadId: null, authorId: "ada",
    authorName: "Ada", authorRole: "brain", body: "hello", kind: "chat", control: null, mentions: [], createdAt: 0, ...extra });
  const seen = new Set<string>();
  const notice = (type: string, payload: unknown) => noticeFor({ type, payload }, channels, seen);
  assert.equal(notice("message", message({})), null, "plain channel chatter is not notified");
  assert.deepEqual(notice("message", message({ mentions: ["human"], threadId: "root" })),
    { title: "Ada in #general", body: "hello", tag: "m", target: { kind: "channel", id: "gen", thread: "root" } });
  assert.equal(notice("message", message({ channelId: "dm-ada" }))?.title, "Ada");
  assert.equal(notice("message", message({ channelId: "dm-agents" })), null);
  assert.equal(notice("message", message({ authorId: "human", mentions: ["human"] })), null);
  assert.equal(notice("message", message({ kind: "system", mentions: ["human"] })), null);
  const decision = { id: "d", channelId: "gen", state: "awaiting_input", revision: 1, requesterName: "Ada", question: "Which?" } as DecisionView;
  assert.deepEqual(notice("decision", decision)?.target, { kind: "channel", id: "gen", thread: "d" });
  assert.equal(notice("decision", decision), null, "each decision is announced once");
  assert.equal(notice("decision", { ...decision, id: "e", state: "answered" }), null);
  assert.equal(notice("agent", {}), null);
});
