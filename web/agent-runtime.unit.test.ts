import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentWork } from "../src/shared/tasks.ts";
import type { Agent } from "../src/shared/types.ts";
import { agentRuntime } from "./agent-runtime.ts";
import type { TerminalSessionInfo } from "./native-bridge.ts";
import type { TerminalState } from "./use-terminal.ts";

const agent = (name: string, patch: Partial<Agent> = {}): Agent => ({ id: name.toLowerCase(), name, role: "worker",
  seniority: "mid", focus: null, online: true, lastSeenAt: 0, createdAt: 0, projectId: "p1", project: "acme", ...patch });
const session = (name: string, patch: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ name, project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 0, ...patch });
const terminals = (sessions: TerminalSessionInfo[] | null, patch: Partial<TerminalState> = {}): TerminalState =>
  ({ native: true, platform: "macos", tmux: "available", broker: "connected", sessions,
    lastKnownSessions: sessions, lastError: null, ...patch });

test("reported session wins; a missing or ambiguous fallback never claims another agent's terminal", () => {
  const atlas = agent("Atlas", { terminalSession: "hm-acme-atlas" });
  const bea = agent("Bea");
  const listed = terminals([session("hm-acme-atlas"), session("hm-acme-bea", { agent: "Bea" })]);
  assert.equal(agentRuntime(atlas, { agents: [atlas, bea] }, listed).sessionState, "running");
  assert.equal(agentRuntime(bea, { agents: [atlas, bea] }, listed).sessionName, "hm-acme-bea");
  const unlabeled = agent("Atlas");
  assert.equal(agentRuntime(unlabeled, { agents: [unlabeled, atlas] }, listed).sessionState, "absent",
    "a reported label owns its session");
  const duplicate = terminals([session("hm-acme-a"), session("hm-acme-b")]);
  assert.equal(agentRuntime(unlabeled, { agents: [unlabeled] }, duplicate).sessionState, "absent");
});

test("unknown broker state retains only a reconnect hint; known empty and dead lists are distinct", () => {
  const atlas = agent("Atlas", { terminalSession: "hm-acme-atlas" });
  const known = terminals([session("hm-acme-atlas")]);
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, known).sessionState, "running");
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, terminals(null, { broker: "unavailable",
    lastKnownSessions: known.sessions })).sessionState, "reconnecting");
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, terminals(null, { broker: "connecting",
    lastKnownSessions: null })).sessionState, "unknown");
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, terminals([])).sessionState, "absent");
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, terminals([session("hm-acme-atlas", { alive: false })])).sessionState, "ended");
  assert.equal(agentRuntime(atlas, { agents: [atlas] }, terminals(null, { native: false, broker: null })).sessionState, "unknown");
  assert.equal(agentRuntime(agent("Atlas", { archivedAt: 10 }), { agents: [atlas] }, known).sessionName, null);
});

test("server activity supplies a stalled hint independently of a live terminal and work counts", () => {
  const work: AgentWork = { task: { id: "t", channelId: "c", state: "accepted", objective: "Draft API", needed: null },
    assigned: 1, delegated: 0, toReview: 0 };
  const atlas = agent("Atlas", { activity: { state: "stalled", since: 100, hint: "Mail waits for a poll." } });
  const runtime = agentRuntime(atlas, { agents: [atlas] }, terminals([session("hm-acme-atlas")]), work);
  assert.equal(runtime.sessionState, "running");
  assert.equal(runtime.activity?.state, "stalled");
  assert.equal(runtime.statusLine, "stalled: Mail waits for a poll.");
  assert.equal(agentRuntime(agent("Bea", { activity: { state: "offline", since: 50 } }), null,
    terminals([]), work).statusLine, "offline · working: Draft API");
  assert.equal(agentRuntime(agent("Cy"), null, terminals([])).statusLine, "idle", "legacy fixture fallback");
});
