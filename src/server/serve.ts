import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { getRequestListener } from "@hono/node-server";
import { DEFAULT_PORT } from "../shared/types.ts";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { startTelegram } from "./telegram.ts";
import { LocalHumanAuth } from "./local-auth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");

export function startServer(opts: { port?: number; hive?: Hive; telegram?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.HIVEMIND_PORT ?? DEFAULT_PORT);
  const hive = opts.hive ?? new Hive();
  const telegram = startTelegram(hive, opts.telegram !== false);
  const app = createApp(hive, {
    telegramRunning: () => telegram.running(),
    reloadTelegram: () => telegram.reload(),
  });

  const humanAuth = new LocalHumanAuth();
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    if (!humanAuth.handleHttp(req, res)) return;
    const url = req.url ?? "/";
    if (url.startsWith("/api") || url.startsWith("/ws")) {
      listener(req, res);
      return;
    }
    if (serveWeb(res, url)) return;
    listener(req, res);
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ req }, done) => {
      const allowed = humanAuth.allowsWebSocket(req);
      done(allowed, allowed ? undefined : 403, allowed ? undefined : "Forbidden");
    },
  });
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "hello", at: Date.now() }));
    ws.on("close", () => clients.delete(ws));
  });

  const emit = (type: string, payload: unknown) => {
    const data = JSON.stringify({ type, payload });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  const onMessage = (payload: unknown) => emit("message", payload);
  const onAgent = (payload: unknown) => emit("agent", payload);
  const onChannel = (payload: unknown) => emit("channel", payload);
  const onThread = (payload: unknown) => emit("thread", payload);
  const onReaction = (payload: unknown) => emit("reaction", payload);
  const onQueued = (payload: unknown) => emit("queued", payload);
  const onProject = (payload: unknown) => emit("project", payload);
  hive.bus.on("message", onMessage);
  hive.bus.on("agent", onAgent);
  hive.bus.on("channel", onChannel);
  hive.bus.on("thread", onThread);
  hive.bus.on("reaction", onReaction);
  hive.bus.on("queued", onQueued);
  hive.bus.on("project", onProject);

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  const sweep = setInterval(() => hive.sweepPresence(), 15_000);
  sweep.unref();
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.error(`hivemind on http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });

  let stopped: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (stopped) return stopped;
    clearInterval(sweep);
    telegram.stop();
    hive.bus.off("message", onMessage);
    hive.bus.off("agent", onAgent);
    hive.bus.off("channel", onChannel);
    hive.bus.off("thread", onThread);
    hive.bus.off("reaction", onReaction);
    hive.bus.off("queued", onQueued);
    hive.bus.off("project", onProject);
    // Revoked sessions must not retain a live subscription during shutdown.
    for (const ws of clients) ws.terminate();
    clients.clear();
    stopped = Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
    ]).then(() => undefined);
    // Hive ownership is unchanged: the caller closes its database after any
    // non-HTTP integrations have drained. Do not close it under active work.
    return stopped;
  };
  return { server, hive, port, shutdown, ready };
}

function serveWeb(res: import("node:http").ServerResponse, url: string): boolean {
  const webRoot = path.join(packageRoot, "dist/web");
  if (!existsSync(webRoot)) return false;
  const clean = url.split("?")[0] ?? "/";
  const rel = clean === "/" ? "index.html" : clean.replace(/^\//, "");
  const file = path.normalize(path.join(webRoot, rel));
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return false;
  let target = file;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = path.join(webRoot, "index.html");
  }
  if (!existsSync(target)) return false;
  const ext = path.extname(target);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };
  res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
  res.end(readFileSync(target));
  return true;
}
