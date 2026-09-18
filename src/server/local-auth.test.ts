import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { LocalHumanAuth, cookieValue, isLoopbackHost, isTrustedBrowserOrigin } from "./local-auth.ts";

function send(base: string, path: string, headers: IncomingHttpHeaders = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }), ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t: TestContext, hostname = "127.0.0.1") {
  const auth = new LocalHumanAuth();
  let calls = 0;
  const server = createServer((req, res) => {
    if (!auth.handleHttp(req, res)) return;
    calls++;
    req.resume();
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  server.listen(0, hostname);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const base = `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`;
  const bootstrap = async (host?: string) => {
    const res = await send(base, "/api/ui/session", {
      origin: host ? `http://${host}` : base,
      ...(host ? { host } : {}),
      "content-type": "application/json",
    }, "POST");
    assert.equal(res.status, 200);
    const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  };
  return { auth, base, port, bootstrap, calls: () => calls };
}

test("strict loopback authority parsing does not normalize hostile Host forms", () => {
  for (const host of ["localhost", "localhost:80", "127.0.0.1:7420", "[::1]", "[::1]:65535"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [undefined, null, "", "evil.example", "evil@localhost:7420", "localhost/evil", "localhost?x",
    "localhost#x", "localhost.", "localhost:0", "localhost:65536", "localhost:00080", "127.1", "2130706433",
    "0x7f000001", "127.0.0.1:7420, evil", "localhost:7420 ", "::1", "[::ffff:127.0.0.1]:7420"]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("Origin must be the exact HTTP origin including hostname and port", () => {
  for (const host of ["127.0.0.1:7420", "localhost:7420", "[::1]:7420", "127.0.0.1:7421"]) {
    assert.equal(isTrustedBrowserOrigin(`http://${host}`, host), true);
  }
  assert.equal(isTrustedBrowserOrigin("http://localhost", "localhost:80"), true);
  for (const origin of [undefined, null, "", "null", "https://127.0.0.1:7420", "http://localhost:7420",
    "http://127.0.0.1:7421", "http://evil.example:7420", "http://127.0.0.1:7420/", "http://127.0.0.1:7420/x",
    "http://x@127.0.0.1:7420", "http://127.0.0.1:7420?x", "http://127.0.0.1:7420#x",
    " http://127.0.0.1:7420", "http://127.0.0.1:7420 http://evil.example"]) {
    assert.equal(isTrustedBrowserOrigin(origin, "127.0.0.1:7420"), false, String(origin));
  }
});

test("capabilities are strong, process-local, port-namespaced, and fail closed on malformed/duplicate cookies", () => {
  const auth = new LocalHumanAuth();
  const cookie = auth.sessionCookie(7420);
  assert.match(cookie, /^hivemind_human_7420=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.doesNotMatch(cookie, /Domain=|Expires=|Max-Age=/);
  assert.equal(auth.hasSession({ cookie }, 7420), true);
  const value = cookieValue(cookie, auth.cookieName(7420));
  assert.ok(value);
  assert.equal(auth.hasSession({ "x-hivemind-human": value }, 7420), true);
  assert.equal(auth.hasSession({ authorization: `Bearer ${value}` }, 7420), false);
  assert.equal(auth.hasSession({ cookie }, 7421), false);
  assert.equal(auth.hasSession({ cookie }, undefined), false);
  assert.equal(auth.hasSession({ cookie }, 0), false);
  assert.equal(new LocalHumanAuth().hasSession({ cookie }, 7420), false);
  assert.throws(() => auth.cookieName(0), RangeError);
  for (const cookie of [undefined, "other=value", "hivemind_human_7420=%E0%A4%A", "hivemind_human_7420=",
    `hivemind_human_7420=${value}; hivemind_human_7420=wrong`, `hivemind_human_7420=wrong; hivemind_human_7420=${value}`]) {
    assert.equal(auth.hasSession({ cookie }, 7420), false);
  }
  assert.equal(cookieValue("ignored; other=x; target=a=b", "target"), "a=b");
  assert.equal(auth.hasSession({ "x-hivemind-human": [value, value] }, 7420), false);
});

test("bootstrap requires exact Origin, POST, and a JSON media type, never a suffix exemption", async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, "", "null", "https://evil.example", `${f.base}/path`, `${f.base}#fragment`]) {
    const res = await send(f.base, "/api/ui/session", { ...(origin === undefined ? {} : { origin }), "content-type": "application/json" }, "POST");
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  }
  assert.equal((await send(f.base, "/api/ui/session", { origin: f.base })).status, 405);
  for (const type of ["text/plain", "application/jsonp", "application/json-evil"]) {
    assert.equal((await send(f.base, "/api/ui/session", { origin: f.base, "content-type": type }, "POST")).status, 415);
  }
  const ok = await send(f.base, "/api/ui/session", { origin: f.base, "content-type": "Application/JSON; charset=utf-8" }, "POST");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(ok.body), { ok: true });
  assert.equal((await send(f.base, "/api/ui/projects/session", { origin: f.base }, "POST")).status, 401);
  assert.equal(f.calls(), 0);
});

test("missing, invalid, malformed and stale sessions reject reads and writes before the handler", async (t) => {
  const f = await fixture(t);
  const stale = new LocalHumanAuth().sessionCookie(f.port);
  for (const cookie of [undefined, "wrong=wrong", `hivemind_human_${f.port}=%ZZ`, stale]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = await send(f.base, "/api/ui/projects", { origin: f.base, ...(cookie ? { cookie } : {}), "content-type": "application/json" }, method, method === "GET" ? undefined : "{}");
      assert.equal(res.status, 401);
      assert.equal(res.headers["x-hivemind-session-required"], "1");
      assert.equal(res.headers["cache-control"], "no-store");
    }
  }
  assert.equal(f.calls(), 0);
});

test("authenticated Human reads, writes and binary uploads work without JSON-type loopholes", async (t) => {
  const f = await fixture(t);
  const cookie = await f.bootstrap();
  assert.equal((await send(f.base, "/api/ui/snapshot", { cookie, origin: f.base })).status, 200);
  for (const method of ["POST", "PUT", "PATCH"]) {
    assert.equal((await send(f.base, "/api/ui/projects/files", { cookie, origin: f.base, "content-type": "text/plain" }, method, "{}")).status, 415);
    assert.equal((await send(f.base, "/api/ui/projects", { cookie, origin: f.base, "content-type": "application/json; charset=UTF-8" }, method, "{}")).status, 200);
  }
  assert.equal((await send(f.base, "/api/ui/files", { cookie, origin: f.base, "content-type": "image/png" }, "POST", "binary")).status, 200);
  assert.equal((await send(f.base, "/api/ui/projects/x", { cookie, origin: f.base }, "DELETE")).status, 200);
  assert.equal((await send(f.base, "/api/ui/files", { origin: f.base, "content-type": "image/png" }, "POST", "binary")).status, 401);
});

test("missing Origin needs explicit browser context, and same-site is not same-origin", async (t) => {
  const f = await fixture(t);
  const cookie = await f.bootstrap();
  assert.equal((await send(f.base, "/api/ui/snapshot", { cookie })).status, 403);
  assert.equal((await send(f.base, "/api/ui/snapshot", { cookie, "x-hivemind-ui": "1" })).status, 200);
  for (const site of ["same-origin", "none"]) {
    assert.equal((await send(f.base, "/api/ui/files/id", { cookie, "sec-fetch-site": site })).status, 200);
  }
  for (const site of ["cross-site", "same-site", "invalid", ""]) {
    const res = await send(f.base, "/api/ui/snapshot", { cookie, "sec-fetch-site": site, "x-hivemind-ui": "1" });
    assert.equal(res.status, 403);
    assert.equal(res.headers["x-hivemind-session-required"], undefined);
  }
  assert.equal((await send(f.base, "/api/ui/projects", { cookie, "sec-fetch-site": "none", "content-type": "application/json" }, "POST", "{}")).status, 403);
  const value = cookie.split("=")[1];
  assert.equal((await send(f.base, "/api/ui/snapshot", { "x-hivemind-human": value })).status, 200);
});

test("spoofed proxy headers, invalid Hosts and hostile Origin never authorize a request", async (t) => {
  const f = await fixture(t);
  const cookie = await f.bootstrap();
  for (const headers of [
    { host: "evil.example", origin: f.base, "x-forwarded-host": new URL(f.base).host },
    { origin: "http://evil.example", "x-forwarded-origin": f.base },
    { origin: "null", forwarded: `host=${new URL(f.base).host};proto=http` },
    { host: "evil@localhost:7420", origin: "http://localhost:7420" },
  ]) {
    const res = await send(f.base, "/api/ui/projects", { ...headers, cookie, "content-type": "text/plain" }, "POST", "{}");
    assert.equal(res.status, 403);
    assert.equal(res.headers["x-hivemind-session-required"], undefined);
  }
  assert.equal(f.calls(), 0);
});

test("preflight is side-effect free and requires a trusted exact Origin", async (t) => {
  const f = await fixture(t);
  for (const path of ["/api/ui/projects", "/api/agent/join"]) {
    assert.equal((await send(f.base, path, { origin: f.base }, "OPTIONS")).status, 204);
    assert.equal((await send(f.base, path, { origin: "http://evil.example" }, "OPTIONS")).status, 403);
    assert.equal((await send(f.base, path, {}, "OPTIONS")).status, 403);
  }
  assert.equal(f.calls(), 0);
});

test("browser join/resume is guarded while native agents and health remain independent", async (t) => {
  const f = await fixture(t);
  for (const type of ["application/json", "text/plain"]) {
    for (const body of ['{"role":"brain"}', '{"resume":"existing"}']) {
      assert.equal((await send(f.base, "/api/agent/join", { origin: "http://evil.example", "content-type": type }, "POST", body)).status, 403);
    }
  }
  assert.equal(f.calls(), 0);
  assert.equal((await send(f.base, "/api/agent/join", { "content-type": "text/plain" }, "POST", '{"role":"brain"}')).status, 200);
  assert.equal((await send(f.base, "/api/agent/me", { authorization: "Bearer native-agent" })).status, 200);
  assert.equal((await send(f.base, "/api/agent/join", { origin: f.base, "content-type": "text/plain" }, "POST", "{}")).status, 415);
  assert.equal((await send(f.base, "/api/agent/join", { origin: f.base, "content-type": "application/json" }, "POST", "{}")).status, 200);
  assert.equal((await send(f.base, "/api/health")).status, 200);
  const root = await send(f.base, "/");
  assert.equal(root.status, 200);
  assert.equal(root.headers["x-frame-options"], "DENY");
  assert.equal((await send(f.base, "/", { host: "evil.example" })).status, 403);
});

test("two listeners share a host cookie jar without overwriting each other; Vite preserves Host", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const cookieA = await a.bootstrap();
  const cookieB = await b.bootstrap();
  assert.notEqual(cookieA.split("=")[0], cookieB.split("=")[0]);
  const cookie = `${cookieA}; ${cookieB}`;
  for (const f of [a, b]) {
    assert.equal((await send(f.base, "/api/ui/snapshot", { cookie, origin: f.base })).status, 200);
    assert.equal(await f.bootstrap(), f === a ? cookieA : cookieB); // Another tab is harmless.
  }
  // Vite proxies preserve the browser's original Host/Origin; the credential
  // namespace must STILL use the backend listener rather than the proxy port.
  const viteCookie = await a.bootstrap("127.0.0.1:7421");
  assert.equal(viteCookie, cookieA);
  assert.equal((await send(a.base, "/api/ui/snapshot", { host: "127.0.0.1:7421", origin: "http://127.0.0.1:7421", cookie })).status, 200);
  assert.equal((await send(a.base, "/api/ui/snapshot", { origin: "http://127.0.0.1:7421", cookie })).status, 403);
});

test("query capabilities and encoded/suffix paths cannot bypass the Human gate", async (t) => {
  const f = await fixture(t);
  const cookie = await f.bootstrap();
  const value = cookie.split("=")[1];
  for (const path of ["/api/ui/snapshot", "/%61pi/ui/snapshot", "/api%2fui/snapshot", "/api/ui/projects/session", `/api/ui/snapshot?session=${value}`]) {
    const res = await send(f.base, path, { origin: f.base });
    assert.equal(res.status, 401);
    assert.ok(!res.body.includes(value));
  }
  for (const path of ["/%ZZ", "/%2fapi/ui/snapshot", "/api%5cui/snapshot",
    "/api/ui/files/%2f..%2f..%2f..%2fagent/join", "/api/ui/channels/.%2fmessages"]) {
    assert.equal((await send(f.base, path)).status, 400);
  }
  assert.equal(f.calls(), 0);
});

test("WebSocket policy independently requires exact path, Origin and current session", () => {
  const auth = new LocalHumanAuth();
  const cookie = auth.sessionCookie(7420);
  const allowed = (headers: IncomingHttpHeaders, url = "/ws", port: number | undefined = 7420) =>
    auth.allowsWebSocket({ url, headers, socket: { localPort: port } } as IncomingMessage);
  const headers = { host: "127.0.0.1:7420", origin: "http://127.0.0.1:7420", cookie };
  assert.equal(allowed(headers), true);
  assert.equal(allowed({ ...headers, "sec-fetch-site": "same-origin" }), true);
  for (const origin of [undefined, "", "null", "http://evil.example", "http://localhost:7420", "http://127.0.0.1:7420/"]) {
    assert.equal(allowed({ ...headers, origin }), false);
  }
  for (const cookie of [undefined, "bad", "hivemind_human_7420=%ZZ", new LocalHumanAuth().sessionCookie(7420)]) {
    assert.equal(allowed({ ...headers, cookie }), false);
  }
  assert.equal(allowed({ ...headers, host: "evil.example" }), false);
  assert.equal(allowed({ ...headers, "sec-fetch-site": "same-site" }), false);
  assert.equal(allowed({ ...headers, "sec-fetch-site": ["same-origin", "cross-site"] } as unknown as IncomingHttpHeaders), false);
  assert.equal(allowed(headers, "/ws?session=ignored"), false);
  assert.equal(allowed(headers, "/ws", 7421), false);
});

// The production listener remains IPv4 loopback; exercise IPv6 authority and
// socket-port handling against a real IPv6 loopback transport independently.
test("IPv6 loopback HTTP applies the same bootstrap and origin boundary", async (t) => {
  const f = await fixture(t, "::1");
  const cookie = await f.bootstrap();
  assert.equal((await send(f.base, "/api/ui/snapshot", { origin: f.base, cookie })).status, 200);
  assert.equal((await send(f.base, "/api/ui/snapshot", { origin: `http://127.0.0.1:${f.port}`, cookie })).status, 403);
  assert.equal((await send(f.base, "/api/ui/snapshot", { origin: f.base })).status, 401);
});
