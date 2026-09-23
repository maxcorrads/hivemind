import { REQUEST_BODY_MS, REQUEST_HEADER_MS, integerArgument } from "../shared/api-contract.ts";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { getRequestListener } from "@hono/node-server";
import { DEFAULT_PORT } from "../shared/types.ts";
import { createRealtimeStream } from "../shared/realtime-client.ts";
import { Hive } from "./hive.ts";
import type { HiveEvents } from "./hive-events.ts";
import { createApp } from "./app.ts";
import { startTelegram } from "./telegram.ts";
import { LocalHumanAuth } from "./local-auth.ts";
import { createStaticWeb } from "./static-web.ts";
import { WS_HEARTBEAT_MS } from "../shared/realtime.ts";
import { heartbeatClients, sendRealtime } from "./websocket-policy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");

/** Hive events forwarded verbatim to every web UI socket; Telegram wake signals stay server-side. */
const FORWARDED_EVENTS = [
  "message", "agent", "channel", "thread", "reaction", "queued", "project", "telegram-health",
  "task", "room", "decision", "adaptive-routing", "jev-call",
] as const satisfies ReadonlyArray<keyof HiveEvents>;
type ForwardedEvent = (typeof FORWARDED_EVENTS)[number];

export function startServer(opts: { port?: number; hive?: Hive; telegram?: boolean; shutdownGraceMs?: number } = {}) {
  const port = integerArgument(String(opts.port ?? process.env.HIVEMIND_PORT ?? DEFAULT_PORT), 0, 65535);
  const hive = opts.hive ?? new Hive();
  const telegram = startTelegram(hive, opts.telegram !== false);
  const app = createApp(hive, {
    telegramRunning: () => telegram.running(),
    reloadTelegram: () => telegram.reload(),
    configureTelegram: input => telegram.configure(input),
  });

  const humanAuth = new LocalHumanAuth();
  const serveWeb = createStaticWeb(path.join(packageRoot, "dist/web"));
  let closing = false;
  const sockets = new Set<Socket>();
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    if (closing) {
      res.writeHead(503, { "Connection": "close", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server is shutting down" }));
      return;
    }
    if (!humanAuth.handleHttp(req, res)) return;
    const url = req.url ?? "/";
    if (url.startsWith("/api") || url.startsWith("/ws")) { listener(req, res); return; }
    if (serveWeb(res, url)) return;
    listener(req, res);
  });

  server.on("connection", socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({
    server, path: "/ws",
    verifyClient: ({ req }, done) => {
      if (closing) { done(false, 503, "Server is shutting down"); return; }
      const allowed = humanAuth.allowsWebSocket(req);
      done(allowed, allowed ? undefined : 403, allowed ? undefined : "Forbidden");
    },
  });
  const clients = new Set<WebSocket>();
  const responsive = new WeakSet<WebSocket>();
  const stream = createRealtimeStream(randomUUID());
  wss.on("connection", ws => {
    if (closing) { ws.terminate(); return; }
    clients.add(ws);
    responsive.add(ws);
    ws.on("pong", () => responsive.add(ws));
    ws.on("error", () => ws.terminate());
    sendRealtime(ws, JSON.stringify({ ...stream.hello(), at: Date.now() }));
    ws.on("close", () => clients.delete(ws));
  });

  const emit = (type: ForwardedEvent, payload: unknown) => {
    const data = JSON.stringify(stream.event(type, payload));
    const bytes = Buffer.byteLength(data);
    for (const ws of clients) sendRealtime(ws, data, bytes);
  };
  const forwarders = FORWARDED_EVENTS.map(type => [type, (payload: unknown) => emit(type, payload)] as const);
  for (const [type, forward] of forwarders) hive.bus.on(type, forward);

  server.requestTimeout = REQUEST_BODY_MS;
  server.headersTimeout = REQUEST_HEADER_MS;
  server.maxHeadersCount = 100;
  server.timeout = 0;
  const sweep = setInterval(() => hive.sweepPresence(), 15_000);
  sweep.unref();
  const heartbeat = setInterval(() => heartbeatClients(clients, responsive), WS_HEARTBEAT_MS);
  heartbeat.unref();
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.error(`hivemind on http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });

  let shutdownTask: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownTask) return shutdownTask;
    closing = true;
    const closeHttp = () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
    const httpClosed = server.listening ? closeHttp() : ready.then(closeHttp, () => undefined);
    clearInterval(sweep);
    clearInterval(heartbeat);
    for (const [type, forward] of forwarders) hive.bus.off(type, forward);
    hive.cancelWaits();
    for (const ws of clients) ws.close(1001, "server shutdown");
    const wsClosed = new Promise<void>(resolve => wss.close(() => resolve()));
    const bridgeStopped = telegram.stop();
    // An injected Hive belongs to its caller and may be reused by another server.
    // An owned Hive must cancel and drain classifier/capacity work before closing SQLite.
    const routingStopped = opts.hive ? Promise.resolve() : hive.adaptiveTopology.stop();
    const grace = Math.min(30_000, Math.max(50, opts.shutdownGraceMs ?? 5_000));
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        for (const ws of clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
        reject(new Error("Shutdown drain deadline exceeded; connections terminated"));
      }, grace);
    });
    const drained = Promise.allSettled([bridgeStopped, routingStopped, httpClosed, wsClosed]).then(results => {
      if (!opts.hive) hive.db.close();
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    shutdownTask = Promise.race([drained, deadline]).finally(() => clearTimeout(timer));
    return shutdownTask;
  };
  return { server, hive, port, shutdown, ready };
}

