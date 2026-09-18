import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build, createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket } from "ws";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

test("Vite builds on the test runtime and serves React with real API and WS proxies", { timeout: 45_000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-vite-"));
  const previousUrl = process.env.HIVEMIND_URL;
  const connections = new Set<Socket>();
  const track = (connection: Socket) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  };
  let hive: Hive | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let vite: ViteDevServer | undefined;
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.terminate();
    try {
      let backendClosed: Promise<unknown> = Promise.resolve();
      if (server) {
        backendClosed = once(server.server, "close").then(() => t.diagnostic("backend closed"));
        server.shutdown();
        server.server.closeAllConnections();
      }
      // Start Vite's teardown before destroying sockets so its close listeners
      // are installed. Force destruction remains failure-path cleanup, not a
      // substitute for the successful WebSocket close handshake asserted below.
      const viteClosed = vite?.close().then(() => t.diagnostic("Vite closed"));
      for (const connection of connections) connection.destroy();
      await Promise.all([viteClosed, backendClosed]);
      assert.equal(connections.size, 0, "server sockets survived teardown");
    } finally {
      hive?.db.close();
      if (previousUrl === undefined) delete process.env.HIVEMIND_URL;
      else process.env.HIVEMIND_URL = previousUrl;
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 10_000 });
  hive = new Hive(path.join(dir, "hive.db"));
  server = startServer({ hive, port: 0, telegram: false });
  server.server.on("connection", track);
  const backendPort = await server.ready;
  process.env.HIVEMIND_URL = `http://127.0.0.1:${backendPort}`;
  const configFile = path.join(root, "vite.config.ts");
  const output = path.join(dir, "built-web");
  // Runs in both existing Node lanes, not just the Node 24 quality job.
  await build({ configFile, logLevel: "silent", build: { outDir: output, emptyOutDir: true } });
  assert.match(readFileSync(path.join(output, "index.html"), "utf8"), /\/assets\/[^"']+\.js/);

  vite = await createViteServer({
    configFile, logLevel: "silent", cacheDir: path.join(dir, "vite-cache"),
    server: { port: 0, strictPort: false },
  });
  assert.deepEqual(vite.config.build.target, ["chrome107", "edge107", "firefox104", "safari16"]);
  vite.httpServer!.on("connection", track);
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base, { signal: t.signal });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/@vite\/client/);
  const module = await fetch(`${base}/main.tsx`, { signal: t.signal });
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type") ?? "", /javascript/);
  assert.match(await module.text(), /createRoot/);
  const health = await fetch(`${base}/api/health`, { signal: t.signal });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, name: "hivemind" });

  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const [hello] = await once(socket, "message", { signal: t.signal });
  assert.equal(JSON.parse(String(hello)).type, "hello");
  const notification = once(socket, "message", { signal: t.signal });
  const joined = await fetch(`${base}/api/agent/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "brain" }), signal: t.signal,
  });
  assert.equal(joined.status, 200);
  const payload: unknown = await joined.json();
  assert.ok(payload !== null && typeof payload === "object" && "created" in payload);
  assert.equal(payload.created, true);
  const [event] = await notification;
  assert.ok(["message", "agent"].includes(JSON.parse(String(event)).type));

  // Exercise the close frame through both proxy endpoints instead of tearing
  // down three TCP endpoints in the same event-loop turn.
  const closed = once(socket, "close", { signal: t.signal });
  socket.close(1000);
  const [code] = await closed;
  assert.equal(code, 1000, "the proxy did not preserve a normal WebSocket close");
});
