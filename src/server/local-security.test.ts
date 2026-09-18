import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocket, type RawData } from "ws";
import { createServer as createViteServer } from "vite";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

type Event = { type: string; payload?: unknown };

async function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hive-local-security-"));
  const db = path.join(home, "hive.db");
  let hive = new Hive(db);
  let started = startServer({ port: 0, hive, telegram: false });
  t.after(async () => {
    await started.shutdown();
    hive.db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const port = await started.ready;
  return {
    port, base: `http://127.0.0.1:${port}`,
    get hive() { return hive; },
    get started() { return started; },
    async restart() {
      await started.shutdown();
      hive.db.close();
      hive = new Hive(db);
      started = startServer({ port, hive, telegram: false });
      assert.equal(await started.ready, port);
    },
  };
}

async function bootstrap(base: string) {
  const res = await fetch(`${base}/api/ui/session`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function json(base: string, target: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${target}`, init);
  return { status: res.status, headers: res.headers, data: await res.json() as Record<string, any> };
}

function handshake(t: TestContext, base: string, headers: Record<string, string>, target = "/ws") {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}${target}`, { headers, handshakeTimeout: 5000 });
  const events: Event[] = [];
  t.after(() => ws.terminate());
  return new Promise<{ status: number; ws: WebSocket; events: Event[] }>((resolve, reject) => {
    let settled = false;
    ws.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
    ws.on("message", (data: RawData) => {
      const event = JSON.parse(String(data)) as Event;
      events.push(event);
      if (!settled) {
        settled = true;
        if (event.type !== "hello") { reject(new Error("Expected authenticated hello")); return; }
        resolve({ status: 101, ws, events });
      }
    });
    ws.once("unexpected-response", (req, res) => {
      settled = true;
      res.resume();
      req.destroy();
      resolve({ status: res.statusCode!, ws, events });
    });
  });
}

function nextEvent(ws: WebSocket, type: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { cleanup(); reject(new Error(`No ${type} event`)); }, 5000);
    const cleanup = () => { clearTimeout(deadline); ws.off("message", message); ws.off("error", error); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const message = (data: RawData) => {
      const event = JSON.parse(String(data)) as Event;
      if (event.type === type) { cleanup(); resolve(event); }
    };
    ws.on("message", message);
    ws.on("error", error);
  });
}

test("real WebSocket handshakes reject unauthorized combinations before any subscription", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const cookie = await bootstrap(f.base);
  const rejected: Record<string, string>[] = [
    {}, { cookie }, { origin: f.base }, { cookie, origin: "null" },
    { cookie, origin: "http://evil.example" }, { cookie, origin: `${f.base}/path` },
    { cookie: "invalid=value", origin: f.base },
    { cookie: `hivemind_human_${f.port}=%ZZ`, origin: f.base },
    { cookie, origin: f.base, host: "evil.example", "x-forwarded-host": new URL(f.base).host },
    { cookie, origin: f.base, "sec-fetch-site": "same-site" },
  ];
  for (const headers of rejected) {
    const result = await handshake(t, f.base, headers);
    assert.equal(result.status, 403);
    assert.equal(result.events.length, 0);
  }
  assert.equal((await handshake(t, f.base, { cookie, origin: f.base }, "/ws?session=ignored")).status, 403);
  const live = await handshake(t, f.base, { cookie, origin: f.base });
  assert.equal(live.status, 101);
  const event = nextEvent(live.ws, "project");
  const created = await json(f.base, "/api/ui/projects", {
    method: "POST", headers: { cookie, origin: f.base, "content-type": "application/json" },
    body: JSON.stringify({ name: "Security test", slug: "security-test" }),
  });
  assert.equal(created.status, 200);
  assert.equal((await event).type, "project");
  assert.ok(f.hive.listProjects().some((p) => p.slug === "security-test"));

  const brain = f.hive.join({ role: "brain", project: "chapter" }).agent;
  const dm = f.hive.openDm(f.hive.getAgent("human"), brain.name);
  const dmEvent = nextEvent(live.ws, "message");
  f.hive.postMessage(f.hive.getAgent("human"), { channel: dm.id, body: "private Human message" });
  assert.equal(((await dmEvent).payload as { body: string }).body, "private Human message");
});

test("browser join/resume cannot create identities or rotate tokens; native flows retain isolation", async (t) => {
  const f = await fixture(t);
  const native = await json(f.base, "/api/agent/join", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "worker", seniority: "mid", project: "chapter" }),
  });
  assert.equal(native.status, 200);
  const credentials = () => f.hive.db.prepare("SELECT id, token_hash FROM agents ORDER BY id").all();
  const before = credentials();
  for (const origin of ["http://evil.example", "null", `${f.base}/invalid`]) {
    for (const body of [{ role: "brain" }, { resume: native.data.agent.name, project: "chapter" }]) {
      for (const contentType of ["text/plain", "application/json"]) {
        const result = await json(f.base, "/api/agent/join", {
          method: "POST", headers: { origin, "content-type": contentType }, body: JSON.stringify(body),
        });
        assert.equal(result.status, 403);
        assert.deepEqual(credentials(), before);
      }
    }
  }
  const bearer = { authorization: `Bearer ${native.data.token}` };
  assert.equal((await json(f.base, "/api/agent/me", { headers: bearer })).status, 200);
  assert.equal((await json(f.base, "/api/agent/channels/brains/messages", { headers: bearer })).status, 403);
  assert.equal((await json(f.base, "/api/ui/snapshot", { headers: bearer })).status, 401);
  assert.equal((await json(f.base, "/api/health")).status, 200);
});

test("restart revokes HTTP/WS sessions, closes subscriptions and preserves data/native tokens", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const native = f.hive.join({ role: "brain" });
  const oldCookie = await bootstrap(f.base);
  const live = await handshake(t, f.base, { cookie: oldCookie, origin: f.base });
  const closed = once(live.ws, "close");
  const originalBus = f.hive.bus;
  await f.restart();
  await closed;
  assert.equal(originalBus.listenerCount("message"), 0);
  const before = f.hive.listProjects().length;
  for (const method of ["GET", "POST"]) {
    const denied = await json(f.base, method === "GET" ? "/api/ui/snapshot" : "/api/ui/projects", {
      method, headers: { cookie: oldCookie, origin: f.base, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ name: "Do not create", slug: "rejected" }) } : {}),
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-hivemind-session-required"), "1");
  }
  assert.equal(f.hive.listProjects().length, before);
  assert.equal((await handshake(t, f.base, { cookie: oldCookie, origin: f.base })).status, 403);
  const cookie = await bootstrap(f.base);
  assert.equal(cookie.split("=")[0], oldCookie.split("=")[0]);
  assert.notEqual(cookie, oldCookie);
  assert.equal((await json(f.base, "/api/ui/snapshot", { headers: { cookie, origin: f.base } })).status, 200);
  assert.equal((await handshake(t, f.base, { cookie, origin: f.base })).status, 101);
  assert.equal((await json(f.base, "/api/agent/me", { headers: { authorization: `Bearer ${native.token}` } })).status, 200);
});

test("simultaneous Hivemind instances and tabs keep distinct cookie namespaces", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const cookieA = await bootstrap(a.base);
  const cookieB = await bootstrap(b.base);
  const cookie = `${cookieA}; ${cookieB}`;
  assert.notEqual(cookieA.split("=")[0], cookieB.split("=")[0]);
  for (const f of [a, b]) {
    assert.equal((await json(f.base, "/api/ui/snapshot", { headers: { cookie, origin: f.base } })).status, 200);
    assert.equal((await handshake(t, f.base, { cookie, origin: f.base })).status, 101);
  }
  assert.equal(await bootstrap(a.base), cookieA);
  assert.equal(await bootstrap(b.base), cookieB);
});

test("actual Vite proxy preserves the trusted HTTP/WS origin and backend cookie namespace", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const previous = process.env.HIVEMIND_URL;
  process.env.HIVEMIND_URL = f.base;
  const vite = await (async () => {
    try {
      return await createViteServer({ server: { port: 0, strictPort: false }, logLevel: "silent" });
    } finally {
      if (previous === undefined) delete process.env.HIVEMIND_URL;
      else process.env.HIVEMIND_URL = previous;
    }
  })();
  t.after(() => vite.close());
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = await bootstrap(base);
  assert.equal(cookie, await bootstrap(f.base));
  assert.match(cookie, new RegExp(`^hivemind_human_${f.port}=`));
  assert.equal((await json(base, "/api/ui/snapshot", { headers: { cookie, origin: base } })).status, 200);
  assert.equal((await handshake(t, base, { cookie, origin: base })).status, 101);
  assert.equal((await handshake(t, base, { cookie, origin: f.base })).status, 403);
  const root = await fetch(base);
  await root.body?.cancel();
  assert.equal(root.headers.get("x-frame-options"), "DENY");
});
