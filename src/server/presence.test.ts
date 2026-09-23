import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import type { Agent } from "../shared/types.ts";
import type { RealtimeEvent } from "../shared/realtime-client.ts";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-presence-"));
  const dbPath = path.join(dir, "hive.db");
  let hive = new Hive(dbPath);
  const events: Agent[] = [];
  const onAgent = (agent: Agent) => events.push(agent);
  hive.bus.on("agent", onAgent);
  t.after(() => {
    hive.bus.off("agent", onAgent);
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get hive() { return hive; },
    events,
    reopen() {
      hive.bus.off("agent", onAgent);
      hive.db.close();
      hive = new Hive(dbPath);
      hive.bus.on("agent", onAgent);
    },
    // schema-level assertion: counts physical row writes on the connection.
    writes() { return Number(hive.db.prepare("SELECT total_changes() AS n").get()!.n); },
  };
}

test("presence writes coalesce 10,000 authenticated touches at the exact heartbeat boundary", (t) => {
  let at = 1_800_000_000_000;
  t.mock.method(Date, "now", () => at);
  const f = fixture(t);
  const agent = f.hive.identity.join({ role: "worker", seniority: "mid" }).agent;
  f.events.length = 0;
  const before = f.writes();
  for (let i = 0; i < 10_000; i++) f.hive.identity.touch(agent.id);
  assert.equal(f.writes(), before);
  assert.equal(f.events.length, 0);
  at += 14_999;
  f.hive.identity.touch(agent.id);
  assert.equal(f.writes(), before);
  at += 1;
  f.hive.identity.touch(agent.id);
  assert.equal(f.writes(), before + 1);
  assert.equal(f.hive.identity.getAgent(agent.id).lastSeenAt, at);
  assert.equal(f.events.length, 0);
  f.hive.identity.touch(agent.id);
  assert.equal(f.writes(), before + 1);
});

test("online/offline oscillation emits immediately and redundant offline calls are no-ops", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const f = fixture(t);
  const agent = f.hive.identity.join({ role: "worker", seniority: "mid" }).agent;
  f.events.length = 0;
  const before = f.writes();
  for (let i = 0; i < 4; i++) {
    f.hive.identity.setOffline(agent.id);
    f.hive.identity.setOffline(agent.id);
    f.hive.identity.touch(agent.id);
    f.hive.identity.touch(agent.id);
  }
  assert.deepEqual(f.events.map((a) => a.online), [false, true, false, true, false, true, false, true]);
  assert.equal(f.writes(), before + 8);
  f.hive.identity.setOffline("human");
  assert.equal(f.hive.identity.getAgent("human").online, true);
  assert.equal(f.writes(), before + 8);
});

test("presence coalescing and deletion stay independent across projects and survive restart", (t) => {
  let at = 1_800_000_000_000;
  t.mock.method(Date, "now", () => at);
  const f = fixture(t);
  const human = f.hive.identity.getAgent("human");
  const first = f.hive.projects.listProjects()[0]!;
  const second = f.hive.projects.createProject(human, { name: "Other", slug: "other" });
  const a = f.hive.identity.join({ role: "worker", seniority: "mid", project: first.slug }).agent;
  at += 1_000;
  const b = f.hive.identity.join({ role: "worker", seniority: "mid", project: second.slug }).agent;
  f.events.length = 0;
  at += 14_000;
  const before = f.writes();
  f.hive.identity.touch(a.id);
  f.hive.identity.touch(b.id);
  assert.equal(f.writes(), before + 1);
  assert.equal(f.events.length, 0);
  f.reopen();
  assert.equal(f.hive.identity.getAgent(a.id).lastSeenAt, at);
  assert.equal(f.hive.identity.getAgent(b.id).lastSeenAt, at - 14_000);
  const afterRestart = f.writes();
  f.hive.identity.touch(a.id);
  assert.equal(f.writes(), afterRestart);
  f.hive.identity.setOffline(a.id);
  f.hive.projects.deleteProject(human, first.slug);
  const afterDelete = f.writes();
  assert.doesNotThrow(() => f.hive.identity.touch(a.id));
  assert.doesNotThrow(() => f.hive.identity.setOffline("does-not-exist"));
  assert.equal(f.writes(), afterDelete);
  assert.equal(f.hive.identity.getAgent(b.id).online, true);
  assert.deepEqual(f.hive.identity.listAgents(b).map((agent) => agent.id).sort(), ["human", b.id].sort());
});

test("real WebSocket connections share one ordered stream and hello gives the reconnect baseline", async (t) => {
  const f = fixture(t);
  const service = startServer({ hive: f.hive, port: 0, telegram: false });
  const clients: WebSocket[] = [];
  t.after(async () => {
    await Promise.all(clients.map(async (ws) => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = once(ws, "close");
      ws.terminate();
      await closed;
    }));
    const closed = once(service.server, "close");
    service.shutdown();
    await closed;
  });
  const port = await service.ready;
  const origin = `http://127.0.0.1:${port}`;
  const session = await fetch(`${origin}/api/ui/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin, cookie, "sec-fetch-site": "same-origin" },
    });
    clients.push(ws);
    const [raw] = await once(ws, "message");
    return { ws, hello: JSON.parse(String(raw)) as RealtimeEvent };
  }
  const first = await connect();
  assert.equal(first.hello.type, "hello");
  assert.equal(typeof first.hello.streamId, "string");
  assert.equal(first.hello.sequence, 0);
  const received = once(first.ws, "message");
  f.hive.bus.emit("agent", f.hive.identity.getAgent("human"));
  const event = JSON.parse(String((await received)[0])) as RealtimeEvent;
  assert.equal(event.streamId, first.hello.streamId);
  assert.equal(event.sequence, 1);
  const second = await connect();
  assert.equal(second.hello.streamId, first.hello.streamId);
  assert.equal(second.hello.sequence, 1);
  const both = [once(first.ws, "message"), once(second.ws, "message")];
  f.hive.bus.emit("queued", { agentId: "human", n: 3, inbox: { awaitingReceipt: 0, acknowledgedMessages: 0, lastAcknowledgedAt: null, queued: { atLeast: 3, exact: true } } });
  const events = (await Promise.all(both)).map(([raw]) => JSON.parse(String(raw)));
  assert.deepEqual(events[0], events[1]);
  assert.equal(events[0].sequence, 2);
  assert.equal(events[0].type, "queued");
});
