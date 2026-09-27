import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { HiveError } from "../shared/types.ts";
import { requestJson } from "./api-input.ts";
import type { Hive } from "./hive.ts";

export const LAUNCHER_CONTEXT = "hivemind-launcher-v1";
const HEX = /^[0-9a-f]{64}$/;
const MAX_BODY = 4096;
const SKEW_SECONDS = 60;

/** Swift's HivemindKit launcher signer uses this exact UTF-8 string. */
export function launcherSignature(secret: Buffer, method: string, pathAndQuery: string, timestamp: string,
  nonce: string, body: Uint8Array): string {
  const hash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret)
    .update(`${LAUNCHER_CONTEXT}\n${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${hash}`)
    .digest("hex");
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
    throw new HiveError(413, "Launcher body is too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let rejectDeadline!: (error: HiveError) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    rejectDeadline(new HiveError(408, "Launcher body deadline exceeded"));
    void reader.cancel().catch(() => {});
  }, 10_000);
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) {
        void reader.cancel().catch(() => {});
        throw new HiveError(413, "Launcher body is too large");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

/** Process-lifetime replay cache: requests are accepted once, inside a ±60 second clock window. */
export class LauncherVerifier {
  private readonly nonces = new Map<string, number>();
  constructor(private readonly secret: Buffer | null, private readonly now: () => number = Date.now) {}

  async verify(request: Request): Promise<void> {
    if (!this.secret) throw new HiveError(404, "Launcher unavailable");
    const timestamp = request.headers.get("x-hivemind-timestamp") ?? "";
    const nonce = request.headers.get("x-hivemind-nonce") ?? "";
    const signature = request.headers.get("x-hivemind-signature") ?? "";
    if (!/^(0|[1-9]\d{0,11})$/.test(timestamp) || !HEX.test(nonce) || !HEX.test(signature))
      throw new HiveError(401, "Invalid launcher proof");
    const at = Number(timestamp), now = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(at) || Math.abs(now - at) > SKEW_SECONDS) throw new HiveError(401, "Invalid launcher proof");
    const body = await boundedBody(request.clone());
    if (request.method === "GET" && body.byteLength !== 0) throw new HiveError(400, "GET launcher request has a body");
    const url = new URL(request.url), pathAndQuery = url.pathname + url.search;
    const expected = launcherSignature(this.secret, request.method, pathAndQuery, timestamp, nonce, body);
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")))
      throw new HiveError(401, "Invalid launcher proof");
    for (const [key, signedAt] of this.nonces) if (now > signedAt + SKEW_SECONDS) this.nonces.delete(key);
    if (this.nonces.has(nonce) || this.nonces.size >= 2048) throw new HiveError(401, "Invalid launcher proof");
    this.nonces.set(nonce, at);
  }
}

/** Signed Server.app channel. It never shares Human cookies or agent bearer authentication. */
export function installLauncherChannel(app: Hono, hive: Hive, secret: Buffer | null): void {
  const verifier = new LauncherVerifier(secret);
  app.use("/api/launcher/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await verifier.verify(c.req.raw);
    await next();
  });
  app.get("/api/launcher/next", async c => {
    const raw = c.req.query("timeoutMs");
    if (c.req.queries("timeoutMs")?.length && c.req.queries("timeoutMs")!.length !== 1)
      throw new HiveError(400, "Repeated timeoutMs");
    if (raw !== undefined && (!/^(0|[1-9]\d{0,4})$/.test(raw) || Number(raw) > 30_000))
      throw new HiveError(400, "timeoutMs must be 0..30000");
    const timeoutMs = raw === undefined ? 25_000 : Number(raw);
    const serverUrl = new URL(c.req.url).origin;
    const first = hive.launcherQueue.next(serverUrl);
    if (first || timeoutMs === 0) return c.json({ command: first });
    const command = await new Promise<ReturnType<typeof hive.launcherQueue.next>>((resolve, reject) => {
      let done = false;
      const cleanup = () => { clearTimeout(timer); hive.bus.off("launcher-queue", settle);
        hive.bus.off("launch-requests", wakeApproval); c.req.raw.signal.removeEventListener("abort", abort); };
      const abort = () => { if (done) return; done = true; cleanup(); resolve(null); };
      const settle = () => {
        if (done) return;
        try {
          const next = hive.launcherQueue.next(serverUrl);
          if (!next) return;
          done = true; cleanup(); resolve(next);
        } catch (error) { done = true; cleanup(); reject(error); }
      };
      const wakeApproval = () => { if (done) return; done = true; cleanup(); resolve(null); };
      const timer = setTimeout(() => {
        done = true; cleanup(); resolve(null);
      }, timeoutMs);
      hive.bus.on("launcher-queue", settle);
      hive.bus.on("launch-requests", wakeApproval);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      if (c.req.raw.signal.aborted) { abort(); return; }
      settle();
    });
    return c.json({ command });
  });
  app.get("/api/launcher/approvals", c => c.json({ requests: hive.launcherQueue.listPending() }));
  app.post("/api/launcher/:id/result", async c => {
    hive.launcherQueue.result(c.req.param("id"), await requestJson(c.req.raw) as { status: "launched" | "failed" | "killed"; session?: string; error?: string });
    return c.json({ ok: true });
  });
  app.post("/api/launcher/requests/:id/approve", async c => {
    const body = await requestJson(c.req.raw);
    return c.json({ request: hive.launcherQueue.approve(hive.identity.getAgent("human"), c.req.param("id"), body.templateId) });
  });
  app.post("/api/launcher/requests/:id/reject", async c => {
    await requestJson(c.req.raw);
    return c.json({ request: hive.launcherQueue.reject(hive.identity.getAgent("human"), c.req.param("id")) });
  });
}
