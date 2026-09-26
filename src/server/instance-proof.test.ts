import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { LocalHumanAuth } from "./local-auth.ts";
import {
  INSTANCE_PROOF_CONTEXT, INSTANCE_SECRET_ENV, installInstanceProof, instanceProof, isInstanceNonce, takeInstanceSecret,
} from "./instance-proof.ts";

// Hivemind.app's proof-of-instance challenge (docs/macos.md#verifying-the-server). In-process only: Hono's
// app.request and a hand-made request for the LocalHumanAuth gate; no socket is opened.

const SECRET_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const SECRET = Buffer.from(SECRET_HEX, "hex");
const NONCE = "a".repeat(64);
/** The same vector HivemindKitTests InstanceProofTests checks, so both sides agree byte for byte. */
const KNOWN_PROOF = "6745245fe21c96869cf150eb4974181180e20990e4ca0bc5275c81324a55808a";

/** What @hono/node-server passes as c.env: the Node request, whose socket names the port it arrived on. */
const nodeEnv = (localPort: number) => ({ incoming: { socket: { localPort } } });

function challenge(app: Hono, query: string, localPort = 7420) {
  return app.request(`http://127.0.0.1:${localPort}/api/health/instance${query}`, {}, nodeEnv(localPort));
}

test("the proof is HMAC-SHA256 over the versioned context, the nonce and the port", () => {
  assert.equal(INSTANCE_PROOF_CONTEXT, "hivemind-instance-v1");
  assert.equal(instanceProof(SECRET, NONCE, 7420), KNOWN_PROOF);
  assert.notEqual(instanceProof(SECRET, NONCE, 7421), KNOWN_PROOF);
  assert.notEqual(instanceProof(SECRET, "b".repeat(64), 7420), KNOWN_PROOF);
  assert.notEqual(instanceProof(Buffer.alloc(32), NONCE, 7420), KNOWN_PROOF);
});

test("nonces are exactly 64 lowercase hex characters", () => {
  assert.equal(isInstanceNonce(NONCE), true);
  assert.equal(isInstanceNonce("0123456789abcdef".repeat(4)), true);
  for (const bad of [undefined, null, 42, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ` ${"a".repeat(63)}`]) {
    assert.equal(isInstanceNonce(bad), false, String(bad));
  }
});

test("the secret is read once and removed from the environment, valid or not", t => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.join(" ")); });
  const env: NodeJS.ProcessEnv = { [INSTANCE_SECRET_ENV]: SECRET_HEX, PATH: "/usr/bin" };
  assert.deepEqual(takeInstanceSecret(env), SECRET);
  assert.equal(INSTANCE_SECRET_ENV in env, false);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(takeInstanceSecret(env), null);

  const malformed: NodeJS.ProcessEnv = { [INSTANCE_SECRET_ENV]: "not-a-secret" };
  assert.equal(takeInstanceSecret(malformed), null);
  assert.equal(INSTANCE_SECRET_ENV in malformed, false);
  assert.equal(errors.length, 1);
  // The value itself is never printed.
  assert.doesNotMatch(String(errors[0]), /not-a-secret/);
  assert.equal(takeInstanceSecret({}), null);
});

test("the challenge answers the proof for the port the request arrived on, never cached", async () => {
  const app = new Hono();
  installInstanceProof(app, SECRET);
  const ok = await challenge(app, `?nonce=${NONCE}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ok.json(), { proof: KNOWN_PROOF });
  // The port is the listener's, not the URL's or a Host header's.
  const other = await app.request(`http://127.0.0.1:7420/api/health/instance?nonce=${NONCE}`,
    { headers: { host: "127.0.0.1:7420" } }, nodeEnv(7421));
  assert.deepEqual(await other.json(), { proof: instanceProof(SECRET, NONCE, 7421) });
});

test("the challenge refuses a missing, malformed or repeated nonce", async () => {
  const app = new Hono();
  installInstanceProof(app, SECRET);
  for (const query of ["", "?nonce=", `?nonce=${NONCE.toUpperCase()}`, `?nonce=${NONCE}0`, `?nonce=${NONCE}&nonce=${NONCE}`, "?other=1"]) {
    const response = await challenge(app, query);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal("proof" in (await response.json() as object), false);
  }
});

test("without a secret the challenge is 404; without a known port it is 503", async () => {
  const none = new Hono();
  installInstanceProof(none, null);
  const missing = await challenge(none, `?nonce=${NONCE}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  const app = new Hono();
  installInstanceProof(app, SECRET);
  assert.equal((await app.request(`/api/health/instance?nonce=${NONCE}`)).status, 503);
});

function appFixture(t: TestContext, instanceSecret?: Buffer | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-instance-proof-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive, instanceSecret === undefined ? {} : { instanceSecret });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}

test("createApp serves the challenge next to /api/health without a Human session", async t => {
  const app = appFixture(t, SECRET);
  const health = await app.request("/api/health");
  assert.deepEqual(await health.json(), { ok: true, name: "hivemind" });
  const proof = await app.request(`/api/health/instance?nonce=${NONCE}`, {}, nodeEnv(7420));
  assert.equal(proof.status, 200);
  assert.deepEqual(await proof.json(), { proof: KNOWN_PROOF });
  // A server started without Hivemind Server.app (`hivemind serve`) has no secret.
  assert.equal((await appFixture(t).request(`/api/health/instance?nonce=${NONCE}`, {}, nodeEnv(7420))).status, 404);
  assert.equal((await appFixture(t, null).request(`/api/health/instance?nonce=${NONCE}`, {}, nodeEnv(7420))).status, 404);
});

/** A request as LocalHumanAuth.handleHttp sees it, and what it answered, without any socket. */
function gate(headers: IncomingHttpHeaders, url = `/api/health/instance?nonce=${NONCE}`) {
  const auth = new LocalHumanAuth();
  let status: number | null = null;
  const req = { headers, url, method: "GET", socket: { localPort: 7420 }, resume() {} } as unknown as IncomingMessage;
  const res = {
    setHeader() { return this; },
    writeHead(code: number) { status = code; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  const passed = auth.handleHttp(req, res);
  return { passed, status };
}

test("the challenge goes through the same Host, Origin and Fetch Metadata gate as /api/health, sessionless", () => {
  // Hivemind.app's URLSession: loopback Host, no Origin, no cookie.
  assert.deepEqual(gate({ host: "127.0.0.1:7420" }), { passed: true, status: null });
  assert.deepEqual(gate({ host: "127.0.0.1:7420" }, "/api/health"), { passed: true, status: null });
  assert.deepEqual(gate({ host: "127.0.0.1:7420", origin: "http://127.0.0.1:7420", "sec-fetch-site": "same-origin" }),
    { passed: true, status: null });
  // Rebinding, other sites and cross-site fetches are refused before the handler, exactly like /api/health.
  for (const headers of [
    { host: "evil.example:7420" },
    { host: "127.0.0.1:7420", origin: "https://evil.example" },
    { host: "127.0.0.1:7420", origin: "null" },
    { host: "127.0.0.1:7420", "sec-fetch-site": "cross-site" },
  ] as IncomingHttpHeaders[]) {
    for (const url of [`/api/health/instance?nonce=${NONCE}`, "/api/health"]) {
      assert.deepEqual(gate(headers, url), { passed: false, status: 403 }, `${url} ${JSON.stringify(headers)}`);
    }
  }
});
