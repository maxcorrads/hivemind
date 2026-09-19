import { HiveError } from "../shared/types.ts";

export const BOT_JSON_BYTES = 64 * 1024;
export const PLUGIN_REQUEST_BYTES = 128 * 1024;
export const CREDENTIAL_JSON_BYTES = 4 * 1024;

/** Bound actual streamed bytes, not just a caller-supplied Content-Length. */
export async function readLimitedJson(request: Request, maxBytes: number, timeoutMs = 10_000, allowEmpty = false): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void request.body?.cancel().catch(() => {});
    throw new HiveError(/^\d+$/.test(declared) ? 413 : 400, "Invalid or oversized JSON body");
  }
  if (!request.body) { if (allowEmpty) return {}; throw new HiveError(400, "Expected JSON"); }
  const reader = request.body.getReader();
  let rejectStopped!: (error: HiveError) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: HiveError) => {
    rejectStopped(error);
    // Cancellation must not wait for an uncooperative producer.
    void reader.cancel().catch(() => {});
  };
  const abort = () => stop(new HiveError(400, "Request aborted"));
  const timer = setTimeout(() => stop(new HiveError(408, "JSON body deadline exceeded")), timeoutMs);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new HiveError(413, "JSON body is too large");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return allowEmpty && text.length === 0 ? {} : JSON.parse(text) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof HiveError) throw error;
    // JSON and UTF-8 decoder diagnostics can contain a fragment of a secret.
    throw new HiveError(400, "Expected valid UTF-8 JSON");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

type Bucket = { tokens: number; updated: number; active: number };
/** Timer-free, bounded admission state. Only authenticated bot IDs are keys. */
export class BotIngressBudget {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  acquire(id: string): (() => void) | undefined {
    const now = this.clock();
    if (this.active >= 32) return undefined;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      if (this.buckets.size >= 1024) {
        for (const [key, value] of this.buckets) {
          if (!value.active && now - value.updated >= 6000) this.buckets.delete(key);
        }
        if (this.buckets.size >= 1024) return undefined;
      }
      bucket = { tokens: 60, updated: now, active: 0 };
      this.buckets.set(id, bucket);
    }
    // A test clock or system clock rollback cannot refill an exhausted bucket.
    const monotonic = Math.max(now, bucket.updated);
    bucket.tokens = Math.min(60, bucket.tokens + (monotonic - bucket.updated) / 100);
    bucket.updated = monotonic;
    if (bucket.active >= 4 || bucket.tokens < 1) return undefined;
    bucket.tokens -= 1;
    bucket.active += 1;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.active -= 1;
      this.active -= 1;
    };
  }
}

/** Browser defense in depth, NOT authentication of other programs on this OS account. */
export function assertLocalHumanRequest(request: Request): void {
  if (request.headers.has("authorization")) throw new HiveError(403, "Credentials for agents or bots do not authorize Human operations");
  const target = new URL(request.url);
  const local = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  if (!local(target)) throw new HiveError(403, "Human operations require the local Hivemind UI");
  const host = request.headers.get("host");
  if (host && host.toLowerCase() !== target.host.toLowerCase()) throw new HiveError(403, "Unexpected request host");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new HiveError(403, "Cross-site Human request denied");
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let source: URL;
    try { source = new URL(origin); } catch { throw new HiveError(403, "Unexpected browser origin"); }
    // Vite's existing development proxy is the only cross-port exception.
    const development = target.port === "7421" && source.origin === "http://127.0.0.1:7420";
    if (!local(source) || (source.origin !== target.origin && !development)) throw new HiveError(403, "Unexpected browser origin");
  }
}
