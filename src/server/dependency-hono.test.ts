import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

test("Hono dependency preserves live HTTP routes, JSON errors and WebSocket events", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-hono-"));
  let hive: Hive | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.terminate();
    try {
      if (server) {
        const closed = once(server.server, "close");
        server.shutdown();
        server.server.closeAllConnections();
        await closed;
      }
    } finally {
      hive?.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  hive = new Hive(path.join(dir, "hive.db"));
  server = startServer({ hive, port: 0, telegram: false });
  const port = await server.ready;
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`, { signal: t.signal });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, name: "hivemind" });

  const unauthorized = await fetch(`${base}/api/agent/me`, { signal: t.signal });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("content-type") ?? "", /application\/json/);
  assert.match((await unauthorized.json()).error, /token/i);

  const invalid = await fetch(`${base}/api/agent/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "human" }), signal: t.signal,
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /role/);

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const [hello] = await once(socket, "message", { signal: t.signal });
  assert.equal(JSON.parse(String(hello)).type, "hello");
  const event = once(socket, "message", { signal: t.signal });
  const joined = await fetch(`${base}/api/agent/join`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ role: "brain", focus: "JSON café 🧪" }), signal: t.signal,
  });
  assert.equal(joined.status, 200);
  const result = await joined.json();
  assert.equal(result.agent.focus, "JSON café 🧪");
  assert.equal(result.created, true);
  const [message] = await event;
  assert.ok(["message", "agent"].includes(JSON.parse(String(message)).type));

  const me = await fetch(`${base}/api/agent/me`, {
    headers: { authorization: `Bearer ${result.token}` }, signal: t.signal,
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).you.name, result.agent.name);
});
