import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Hono } from "hono";

// Proof of instance for Hivemind.app (docs/macos.md#verifying-the-server). Hivemind Server.app starts
// `hivemind serve` with a fresh random secret in HIVEMIND_INSTANCE_SECRET and writes the same secret into its
// 0600 discovery file. Before Hivemind.app trusts whatever answers on the port with its native bridge, it sends a
// nonce here and checks the HMAC, so a process that squats the port while this server is down cannot pass for it.

/** The variable Hivemind Server.app passes the secret in. It is removed from process.env as soon as it is read. */
export const INSTANCE_SECRET_ENV = "HIVEMIND_INSTANCE_SECRET";
/** Versioned domain separation for the HMAC input; HivemindKit InstanceProof.context must match. */
export const INSTANCE_PROOF_CONTEXT = "hivemind-instance-v1";

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/**
 * Reads the instance secret once and deletes it from the environment, so nothing this server spawns (plugins,
 * agents, tmux via the CLI) inherits it. A value that is not 64 lowercase hex characters is dropped as if unset;
 * the value itself is never printed.
 */
export function takeInstanceSecret(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[INSTANCE_SECRET_ENV];
  delete env[INSTANCE_SECRET_ENV];
  if (raw === undefined) return null;
  if (!HEX_32_BYTES.test(raw)) {
    console.error(`Ignoring ${INSTANCE_SECRET_ENV}: it is not 64 lowercase hex characters`);
    return null;
  }
  return Buffer.from(raw, "hex");
}

/** A challenge nonce: exactly 32 bytes as 64 lowercase hex characters. */
export function isInstanceNonce(value: unknown): value is string {
  return typeof value === "string" && HEX_32_BYTES.test(value);
}

/** hex(HMAC-SHA256(secret, "hivemind-instance-v1\n" + nonce + "\n" + port)). */
export function instanceProof(secret: Buffer, nonce: string, port: number): string {
  return createHmac("sha256", secret).update(`${INSTANCE_PROOF_CONTEXT}\n${nonce}\n${port}`).digest("hex");
}

/** The port this request actually arrived on, from the Node socket (never a Host header a caller controls). */
function listeningPort(env: unknown): number | null {
  const port = (env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.localPort;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * GET /api/health/instance?nonce=<64 hex>. Session-independent like /api/health, so it sits behind the same
 * LocalHumanAuth Host/Origin/Fetch-Metadata gate and needs no Human session. 404 without a secret (a `hivemind
 * serve` started by hand), 400 for a missing or malformed nonce.
 */
export function installInstanceProof(app: Hono, secret: Buffer | null): void {
  app.get("/api/health/instance", c => {
    c.header("Cache-Control", "no-store");
    if (!secret) return c.json({ error: "No instance secret" }, 404);
    const nonces = c.req.queries("nonce") ?? [];
    const nonce = nonces[0];
    if (nonces.length !== 1 || !isInstanceNonce(nonce)) return c.json({ error: "nonce must be 64 lowercase hex characters" }, 400);
    const port = listeningPort(c.env);
    if (port === null) return c.json({ error: "Listening port unknown" }, 503);
    return c.json({ proof: instanceProof(secret, nonce, port) });
  });
}
