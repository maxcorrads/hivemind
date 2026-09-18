/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectHumanWs, createHumanSession } from "./human-session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ok = () => new Response('{"ok":true}');
const expired = () => new Response('{"error":"Human session required"}', {
  status: 401, headers: { "x-hivemind-session-required": "1" },
});

test("concurrent callers share one bootstrap and reuse it after success", async () => {
  const gate = deferred<Response>();
  const started = deferred<void>();
  let bootstraps = 0;
  let requests = 0;
  const session = createHumanSession(async (path, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-hivemind-ui"), "1");
    if (path === "/api/ui/session") {
      bootstraps++;
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      started.resolve();
      return gate.promise;
    }
    requests++;
    return ok();
  });
  const pending = Array.from({ length: 8 }, () => session.request("/api/ui/snapshot"));
  await started.promise;
  assert.equal(bootstraps, 1);
  assert.equal(requests, 0);
  gate.resolve(ok());
  await Promise.all(pending);
  await session.request("/api/ui/snapshot");
  assert.equal(bootstraps, 1);
  assert.equal(requests, 9);
});

test("failed network and HTTP bootstraps do not poison later callers", async () => {
  let bootstraps = 0;
  let requests = 0;
  const session = createHumanSession(async (path) => {
    if (path !== "/api/ui/session") { requests++; return ok(); }
    bootstraps++;
    if (bootstraps === 1) throw new Error("offline");
    if (bootstraps === 2) return new Response("denied", { status: 403 });
    return ok();
  });
  await assert.rejects(session.request("/api/ui/snapshot"), /offline/);
  await assert.rejects(session.request("/api/ui/snapshot"), /HTTP 403/);
  assert.equal((await session.request("/api/ui/snapshot")).status, 200);
  assert.equal(bootstraps, 3);
  assert.equal(requests, 1);
});

test("concurrent and late old 401 responses cause only one refresh after restart", async () => {
  const first = deferred<Response>();
  const late = deferred<Response>();
  const bothSent = deferred<void>();
  const refreshing = deferred<void>();
  const refresh = deferred<Response>();
  let bootstraps = 0;
  let requests = 0;
  const session = createHumanSession(async (path) => {
    if (path === "/api/ui/session") {
      bootstraps++;
      if (bootstraps === 2) { refreshing.resolve(); return refresh.promise; }
      return ok();
    }
    requests++;
    if (requests === 2) return first.promise;
    if (requests === 3) { bothSent.resolve(); return late.promise; }
    return ok();
  });
  await session.request("/api/ui/snapshot");
  const a = session.request("/api/ui/projects", { method: "POST", body: "{}" });
  const b = session.request("/api/ui/projects", { method: "POST", body: "{}" });
  await bothSent.promise;
  first.resolve(expired());
  await refreshing.promise;
  refresh.resolve(ok());
  assert.equal((await a).status, 200);
  late.resolve(expired()); // Belongs to the already replaced generation.
  assert.equal((await b).status, 200);
  assert.equal(bootstraps, 2);
  assert.equal(requests, 5);
});

test("401 callers arriving during a refresh share its in-flight bootstrap", async () => {
  const bootstrap = deferred<Response>();
  const inFlight = deferred<void>();
  const requestsStarted = deferred<void>();
  let bootstraps = 0;
  let requests = 0;
  const session = createHumanSession(async (path) => {
    if (path === "/api/ui/session") {
      if (++bootstraps === 2) { inFlight.resolve(); return bootstrap.promise; }
      return ok();
    }
    requests++;
    if (requests <= 2) { if (requests === 2) requestsStarted.resolve(); return expired(); }
    return ok();
  });
  const a = session.request("/api/ui/snapshot");
  const b = session.request("/api/ui/snapshot");
  await requestsStarted.promise;
  await inFlight.promise;
  bootstrap.resolve(ok());
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  assert.equal(bootstraps, 2);
});

test("no mutation retry after network errors, generic 401s, or other HTTP errors", async () => {
  for (const kind of ["network", "401", "500"]) {
    let requests = 0;
    let bootstraps = 0;
    const session = createHumanSession(async (path) => {
      if (path === "/api/ui/session") { bootstraps++; return ok(); }
      requests++;
      if (kind === "network") throw new Error("ambiguous write failure");
      return new Response("error", { status: Number(kind) });
    });
    const pending = session.request("/api/ui/projects", { method: "POST", body: "{}" });
    if (kind === "network") await assert.rejects(pending, /ambiguous/);
    else assert.equal((await pending).status, Number(kind));
    assert.equal(requests, 1);
    assert.equal(bootstraps, 1);
  }
});

test("a definitive auth rejection permits only one replay, preserving JSON and File bodies", async () => {
  for (const body of ['{"name":"once"}', new File(["binary"], "image.png", { type: "image/png" })]) {
    let requests = 0;
    let bootstraps = 0;
    const session = createHumanSession(async (path, init) => {
      if (path === "/api/ui/session") { bootstraps++; return ok(); }
      requests++;
      assert.equal(init?.body, body);
      return expired();
    });
    const result = await session.request("/api/ui/files", { method: "POST", body });
    assert.equal(result.status, 401);
    assert.equal(requests, 2);
    assert.equal(bootstraps, 2);
  }
});

test("non-replayable streams are not resent even after definite auth rejection", async () => {
  let requests = 0;
  const session = createHumanSession(async (path) => {
    if (path === "/api/ui/session") return ok();
    requests++;
    return expired();
  });
  const stream = new ReadableStream({ start(controller) { controller.close(); } });
  const response = await session.request("/api/ui/files", { method: "POST", body: stream });
  assert.equal(response.status, 401);
  assert.equal(requests, 1);
  await response.body?.cancel();
});

test("a failed refresh releases the rejected response and allows later recovery", async () => {
  let bootstraps = 0;
  let requests = 0;
  const rejection = expired();
  const session = createHumanSession(async (path) => {
    if (path === "/api/ui/session") {
      bootstraps++;
      return bootstraps === 2 ? new Response("unavailable", { status: 503 }) : ok();
    }
    return ++requests === 1 ? rejection : ok();
  });
  await assert.rejects(session.request("/api/ui/projects", { method: "POST", body: "{}" }), /503/);
  assert.equal(rejection.bodyUsed, true);
  assert.equal((await session.request("/api/ui/projects", { method: "POST", body: "{}" })).status, 200);
  assert.equal(bootstraps, 3);
});

test("one cancelled caller cannot cancel the shared bootstrap or send its mutation", async () => {
  const gate = deferred<Response>();
  const started = deferred<void>();
  const abort = new AbortController();
  let requests = 0;
  const session = createHumanSession(async (path) => {
    if (path === "/api/ui/session") { started.resolve(); return gate.promise; }
    requests++;
    return ok();
  });
  const cancelled = session.request("/api/ui/projects", { method: "POST", signal: abort.signal });
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  const healthy = session.request("/api/ui/snapshot");
  await started.promise;
  abort.abort();
  gate.resolve(ok());
  await rejected;
  assert.equal((await healthy).status, 200);
  await assert.rejects(session.request("/api/ui/projects", { signal: abort.signal }), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("bootstrap deadline is recoverable and cleared after success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let successfulSignal: AbortSignal | undefined;
  const session = createHumanSession(async (path, init) => {
    if (path !== "/api/ui/session") return ok();
    calls++;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    successfulSignal = init?.signal ?? undefined;
    return ok();
  });
  const rejected = assert.rejects(session.request("/api/ui/snapshot"), { name: "AbortError" });
  t.mock.timers.tick(10_000);
  await rejected;
  await session.request("/api/ui/snapshot");
  t.mock.timers.tick(20_000);
  assert.equal(successfulSignal?.aborted, false);
});

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closes = 0;
  close() { this.closes++; }
  browserSocket() { return this as unknown as WebSocket; }
}

test("WebSocket refreshes before every handshake and ignores stale socket events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const created = [deferred<FakeSocket>(), deferred<FakeSocket>()];
  const sockets: FakeSocket[] = [];
  const events: unknown[] = [];
  const live: boolean[] = [];
  const stop = connectHumanWs({ refresh: async () => ++refreshes }, (event) => events.push(event), (value) => live.push(value), () => {
    const socket = new FakeSocket();
    created[sockets.length].resolve(socket);
    sockets.push(socket);
    return socket.browserSocket();
  });
  t.after(stop);
  const first = await created[0].promise;
  first.onopen?.();
  first.onmessage?.({ data: '{"type":"message","payload":1}' });
  first.onmessage?.({ data: "not JSON" });
  const staleOpen = first.onopen;
  const staleMessage = first.onmessage;
  first.onclose?.();
  t.mock.timers.tick(1500);
  const second = await created[1].promise;
  assert.equal(refreshes, 2);
  staleOpen?.();
  staleMessage?.({ data: '{"type":"message","payload":2}' });
  second.onopen?.();
  assert.deepEqual(live, [true, false, true]);
  assert.equal(events.length, 1);
  stop();
  assert.equal(second.closes, 1);
  assert.equal(second.onmessage, null);
});

test("disposing during bootstrap or a reconnect timer never opens another socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred<number>();
  let sockets = 0;
  const stop = connectHumanWs({ refresh: () => gate.promise }, () => {}, undefined, () => {
    sockets++;
    return new FakeSocket().browserSocket();
  });
  stop();
  gate.resolve(1);
  await gate.promise;
  assert.equal(sockets, 0);
  const created = deferred<FakeSocket>();
  const dispose = connectHumanWs({ refresh: async () => 1 }, () => {}, undefined, () => {
    sockets++;
    const socket = new FakeSocket();
    created.resolve(socket);
    return socket.browserSocket();
  });
  const socket = await created.promise;
  socket.onclose?.();
  dispose();
  t.mock.timers.tick(50_000);
  assert.equal(sockets, 1);
});

test("failed refresh and failed socket construction each recover through the reconnect scheduler", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failed = [deferred<void>(), deferred<void>()];
  const connected = deferred<void>();
  let failures = 0;
  let refreshes = 0;
  let sockets = 0;
  const stop = connectHumanWs({ refresh: async () => {
    if (++refreshes === 1) throw new Error("offline");
    return refreshes;
  } }, () => {}, (live) => { if (!live) failed[failures++].resolve(); }, () => {
    if (++sockets === 1) throw new Error("constructor failed");
    connected.resolve();
    return new FakeSocket().browserSocket();
  });
  t.after(stop);
  await failed[0].promise;
  t.mock.timers.tick(1500);
  await failed[1].promise;
  t.mock.timers.tick(1500);
  await connected.promise;
  assert.equal(refreshes, 3);
  assert.equal(sockets, 2);
  assert.equal(failures, 2);
});
