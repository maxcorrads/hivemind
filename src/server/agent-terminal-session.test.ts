import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { HiveError, type Agent } from "../shared/types.ts";

// The agent <-> tmux session label (docs/terminal-broker.md): `hivemind mcp` reports HIVEMIND_TMUX_SESSION on join,
// the server keeps it on the agent and the Human UI shows it. In-process only: no server or socket is started.

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-terminal-session-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const events: Agent[] = [];
  hive.bus.on("agent", agent => events.push(agent));
  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const response = await app.request(url, { method, headers: { "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  const snapshotAgent = async (id: string) =>
    ((await call("GET", "/api/ui/snapshot")).json.agents as Agent[]).find(agent => agent.id === id)!;
  return { hive, call, events, snapshotAgent };
}

const status = (code: number, message?: RegExp) => (error: unknown) =>
  error instanceof HiveError && error.status === code && (!message || message.test(error.message));

test("join stores the reported session; the UI snapshot shows it and the agents' own roster does not", async t => {
  const { call, snapshotAgent } = fixture(t);
  const joined = await call("POST", "/api/agent/join", { role: "worker", seniority: "mid", terminalSession: "hm-acme-new-1" });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.agent.terminalSession, "hm-acme-new-1");
  assert.equal((await snapshotAgent(joined.json.agent.id)).terminalSession, "hm-acme-new-1");

  const roster = await call("GET", "/api/agent/agents", undefined, joined.json.token);
  assert.equal(roster.status, 200);
  assert.ok((roster.json.agents as Agent[]).every(agent => !("terminalSession" in agent)));
  const me = await call("GET", "/api/agent/me", undefined, joined.json.token);
  assert.equal("terminalSession" in me.json.you, false);

  const plain = await call("POST", "/api/agent/join", { role: "brain" });
  assert.equal("terminalSession" in (await snapshotAgent(plain.json.agent.id)), false, "no session, no field");
});

test("a value that is not a Hivemind session name is refused, over HTTP and in the service", async t => {
  const { hive, call } = fixture(t);
  for (const terminalSession of ["", "hm-", "work", "hm-A", "hm-a;rm -rf ~", "hm-a\n", `hm-${"a".repeat(80)}`, 7, ["hm-a"]]) {
    const response = await call("POST", "/api/agent/join", { role: "brain", terminalSession });
    assert.equal(response.status, 400, JSON.stringify(terminalSession));
    assert.match(String(response.json.error), /terminalSession/);
  }
  assert.throws(() => hive.identity.join({ role: "brain", terminalSession: "=hm-a" }), status(400, /terminalSession/));
  assert.equal(hive.identity.listAgents().filter(agent => agent.role === "brain").length, 0, "nothing was created");
});

test("rejoin updates the label: resume and a repeated join set, replace or clear it", t => {
  const { hive, events } = fixture(t);
  const first = hive.identity.join({ role: "brain", terminalSession: "hm-acme-atlas" });
  const id = first.agent.id;
  assert.equal(hive.identity.getAgent(id).terminalSession, "hm-acme-atlas");

  events.length = 0;
  const same = hive.identity.join({ role: "brain", token: first.token, terminalSession: "hm-acme-atlas" });
  assert.equal(same.agent.terminalSession, "hm-acme-atlas");
  assert.equal(events.length, 0, "an unchanged label emits nothing");

  const moved = hive.identity.join({ role: "brain", resumeName: first.agent.name, terminalSession: "hm-acme-new-2" });
  assert.equal(moved.agent.terminalSession, "hm-acme-new-2");
  assert.equal(events.at(-1)?.terminalSession, "hm-acme-new-2", "the UI hears about the change");

  events.length = 0;
  const outside = hive.identity.join({ role: "brain", resumeName: first.agent.name });
  assert.equal(outside.agent.terminalSession, undefined, "a resume from outside a session clears it");
  assert.equal(hive.identity.getAgent(id).terminalSession, undefined);
  assert.equal(events.at(-1)?.id, id);
  assert.equal(events.at(-1)?.terminalSession, undefined);

  const back = hive.identity.join({ role: "brain", token: outside.token, terminalSession: "hm-acme-atlas" });
  assert.equal(back.agent.terminalSession, "hm-acme-atlas", "a repeated join with the session key sets it too");
});

test("a session labels one agent: the latest joiner takes it over", t => {
  const { hive, events } = fixture(t);
  const old = hive.identity.join({ role: "worker", seniority: "mid", terminalSession: "hm-acme-new-1" });
  events.length = 0;
  const next = hive.identity.join({ role: "worker", seniority: "senior", terminalSession: "hm-acme-new-1" });
  assert.equal(next.agent.terminalSession, "hm-acme-new-1");
  assert.equal(hive.identity.getAgent(old.agent.id).terminalSession, undefined);
  const byId = new Map(events.map(agent => [agent.id, agent]));
  assert.equal(byId.get(old.agent.id)?.terminalSession, undefined, "the previous holder is announced without it");
  assert.equal(byId.get(next.agent.id)?.terminalSession, "hm-acme-new-1");

  hive.identity.join({ role: "worker", resumeName: old.agent.name, terminalSession: "hm-acme-new-1" });
  assert.equal(hive.identity.getAgent(old.agent.id).terminalSession, "hm-acme-new-1");
  assert.equal(hive.identity.getAgent(next.agent.id).terminalSession, undefined);
});

test("removing an agent drops its label", t => {
  const { hive } = fixture(t);
  const worker = hive.identity.join({ role: "worker", seniority: "mid", terminalSession: "hm-acme-forge" });
  hive.identity.removeAgent(hive.identity.getAgent("human"), worker.agent.name);
  const tombstone = hive.identity.getAgent(worker.agent.id);
  assert.equal(typeof tombstone.removedAt, "number");
  assert.equal(tombstone.terminalSession, undefined);
});

test("the label carries no capability: only identity storage and the join/snapshot paths know it", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path.relative(src, full).split(path.sep).join("/")] : [];
  });
  const mentions = (pattern: RegExp) => sources(src).filter(file => pattern.test(readFileSync(path.join(src, file), "utf8"))).sort();
  assert.deepEqual(mentions(/\bterminal_session\b/),
    ["server/migrations/agent-terminal-session.ts", "server/services/identity.ts", "server/services/rows.ts"]);
  assert.deepEqual(mentions(/terminalSession/), ["cli.ts", "mcp/index.ts", "server/app.ts", "server/services/identity.ts",
    "shared/api-contract.ts", "shared/terminal-session.ts", "shared/types.ts"]);
});
