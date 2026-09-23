import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { heartbeatClients, sendRealtime } from "./websocket-policy.ts";
import { WS_HEARTBEAT_MS, WS_MAX_BUFFERED_BYTES, websocketOverloaded } from "../shared/realtime.ts";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

function fakeClient(bufferedAmount = 0) {
  const sent: string[] = [];
  const closed: number[] = [];
  let pings = 0, terminations = 0;
  return {
    readyState: 1, bufferedAmount, sent, closed,
    send(data: string, callback?: (error?: Error) => void) { sent.push(data); callback?.(); },
    close(code?: number) { closed.push(code!); this.readyState = 2; },
    ping() { pings++; }, terminate() { terminations++; this.readyState = 3; },
    get pings() { return pings; }, get terminations() { return terminations; },
  };
}

test("outbound budget includes next UTF-8 frame and fails closed on invalid accounting", () => {
  assert.equal(websocketOverloaded(WS_MAX_BUFFERED_BYTES), false);
  assert.equal(websocketOverloaded(WS_MAX_BUFFERED_BYTES, 1), true);
  for (const invalid of [NaN, Infinity, -1]) assert.equal(websocketOverloaded(invalid), true);
  const exact = fakeClient(WS_MAX_BUFFERED_BYTES - 4);
  sendRealtime(exact as unknown as WebSocket, "😀");
  assert.deepEqual(exact.sent, ["😀"]);
  sendRealtime(exact as unknown as WebSocket, "😀x");
  assert.deepEqual(exact.closed, [1013]);
  assert.equal(exact.sent.length, 1);
});

test("closing clients reject subsequent sends; failed sends do not interrupt a healthy client", () => {
  const bad = fakeClient();
  bad.send = () => { throw new Error("closed during send"); };
  const healthy = fakeClient();
  for (const client of [bad, healthy]) sendRealtime(client as unknown as WebSocket, "event");
  assert.equal(bad.terminations, 1);
  assert.deepEqual(healthy.sent, ["event"]);
  const asyncFailure = fakeClient();
  asyncFailure.send = (_data, callback) => callback?.(new Error("write failed"));
  sendRealtime(asyncFailure as unknown as WebSocket, "event");
  assert.equal(asyncFailure.terminations, 1);
  healthy.close(1013);
  sendRealtime(healthy as unknown as WebSocket, "not sent");
  assert.deepEqual(healthy.sent, ["event"]);
});

test("heartbeat reclaims a missing pong and an unfinished close handshake", () => {
  const a = fakeClient(), b = fakeClient(), c = fakeClient();
  const clients = [a, b, c] as unknown as WebSocket[];
  const responsive = new WeakSet(clients);
  heartbeatClients(clients, responsive);
  assert.equal(a.pings, 1);
  responsive.add(clients[0]!);
  c.close(1013);
  heartbeatClients(clients, responsive);
  assert.equal(a.pings, 2);
  assert.equal(b.terminations, 1);
  assert.equal(c.terminations, 1);
});

test("real authenticated sockets isolate backpressure and heartbeat, and shutdown clears the timer", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-ws-budget-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const serverClients: WebSocket[] = [], clients: WebSocket[] = [];
  const originalSend = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, "send", function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    if (typeof args[0] === "string" && args[0].includes('"type":"hello"')) serverClients.push(this);
    return originalSend.apply(this, args);
  });
  const originalInterval = globalThis.setInterval;
  let heartbeat!: () => void;
  let heartbeatTimer: ReturnType<typeof setInterval>;
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
    const timer = originalInterval(callback, delay);
    if (delay === WS_HEARTBEAT_MS) { heartbeat = callback; heartbeatTimer = timer; }
    return timer;
  });
  const cleared: unknown[] = [];
  const clear = globalThis.clearInterval;
  t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => { cleared.push(timer); clear(timer); });
  const service = startServer({ hive, port: 0, telegram: false });
  t.after(async () => {
    for (const client of clients) client.terminate();
    await service.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const port = await service.ready, origin = `http://127.0.0.1:${port}`;
  const bootstrap = await fetch(`${origin}/api/ui/session`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  await bootstrap.body?.cancel();
  async function connect(autoPong = true) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong, headers: { origin, cookie } });
    clients.push(client);
    await once(client, "message");
    return client;
  }
  const slow = await connect(), healthy = await connect(), unresponsive = await connect(false);
  Object.defineProperty(serverClients[0]!, "bufferedAmount", { configurable: true, get: () => WS_MAX_BUFFERED_BYTES });
  const slowClosed = once(slow, "close"), healthyEvent = once(healthy, "message");
  hive.bus.emit("queued", { agentId: "human", n: 1, inbox: { awaitingReceipt: 0, acknowledgedMessages: 0, lastAcknowledgedAt: null, queued: { atLeast: 1, exact: true } } });
  const [code] = await slowClosed;
  assert.equal(code, 1013);
  assert.equal(JSON.parse(String((await healthyEvent)[0])).type, "queued");
  assert.ok(heartbeat);
  const pong = once(serverClients[1]!, "pong"), ping = once(unresponsive, "ping");
  heartbeat(); await Promise.all([pong, ping]);
  const dead = once(unresponsive, "close");
  heartbeat(); await dead;
  assert.equal(healthy.readyState, WebSocket.OPEN);
  healthy.terminate();
  await service.shutdown();
  assert.ok(cleared.includes(heartbeatTimer!));
});
