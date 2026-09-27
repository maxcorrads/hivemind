import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTraffic } from "./agent-traffic.ts";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import type { AgentTrafficView } from "../shared/types.ts";

// Per-agent bytes of the agent API (Phase T, #267). In-process only: no server or socket is started.

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agent-traffic-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const response = await app.request(url, { method, headers: { "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), json: JSON.parse(text) as Record<string, any> };
  };
  const traffic = async () => (await call("GET", "/api/ui/snapshot")).json.agentTraffic as Record<string, AgentTrafficView>;
  return { hive, call, traffic };
}

test("records bytes and calls per agent and route pattern, and copies on snapshot", () => {
  const traffic = new AgentTraffic();
  traffic.record("a", "/api/agent/wait", 100, 5);
  traffic.record("a", "/api/agent/wait", 50, 9);
  traffic.record("a", "/api/agent/me", 10, 9);
  traffic.record("b", "/api/agent/me", 7, 9);
  const view = traffic.snapshot(["a", "gone"]);
  assert.deepEqual(Object.keys(view), ["a"]);
  assert.deepEqual(view.a, { since: 5, bytes: 160, calls: 3,
    routes: { "/api/agent/wait": { bytes: 150, calls: 2 }, "/api/agent/me": { bytes: 10, calls: 1 } } });
  view.a!.routes["/api/agent/wait"]!.bytes = 0;
  assert.equal(traffic.snapshot(["a"]).a!.routes["/api/agent/wait"]!.bytes, 150, "a snapshot is a copy");
  traffic.forget("a");
  assert.deepEqual(traffic.snapshot(["a", "b"]), { b: { since: 9, bytes: 7, calls: 1, routes: { "/api/agent/me": { bytes: 7, calls: 1 } } } });
});

test("the Human snapshot shows the exact JSON bytes each agent received, join included", async t => {
  const { call, traffic } = fixture(t);
  const joined = await call("POST", "/api/agent/join", { role: "worker", seniority: "mid" });
  assert.equal(joined.status, 200);
  const id = joined.json.agent.id as string;
  const me = await call("GET", "/api/agent/me", undefined, joined.json.token);
  const roster = await call("GET", "/api/agent/agents", undefined, joined.json.token);
  const view = (await traffic())[id]!;
  assert.equal(view.calls, 3);
  assert.equal(view.bytes, joined.bytes + me.bytes + roster.bytes);
  assert.deepEqual(view.routes["/api/agent/join"], { bytes: joined.bytes, calls: 1 });
  assert.deepEqual(view.routes["/api/agent/me"], { bytes: me.bytes, calls: 1 });
});

test("rejected calls and removed agents are not reported", async t => {
  const { hive, call, traffic } = fixture(t);
  const joined = await call("POST", "/api/agent/join", { role: "worker", seniority: "mid" });
  const id = joined.json.agent.id as string;
  assert.equal((await call("GET", "/api/agent/me", undefined, "hm_wrong")).status, 401);
  assert.equal((await traffic())[id]!.calls, 1, "only the join");
  hive.identity.removeAgent(hive.identity.getAgent("human"), joined.json.agent.name);
  assert.equal(id in await traffic(), false);
});
