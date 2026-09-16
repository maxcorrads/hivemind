import type { WaitResult } from "../shared/types.ts";

const FATAL = /join first|no token|HTTP 401|HTTP 403|HTTP 404|HTTP 409|superseded/i;
const SERVER = /HTTP 5\d\d/;

export function waitHasMail(result: WaitResult): boolean {
  if (result.idle === true) return false;
  const n =
    (result.mail?.length ?? 0) +
    (result.messages?.length ?? 0) +
    (result.mentions?.length ?? 0) +
    (result.control?.length ?? 0);
  return n > 0;
}

export function isTransientWaitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (FATAL.test(msg)) return false;
  return true;
}

export async function waitUntilMail(
  callWait: () => Promise<WaitResult>,
  opts: {
    delay?: (ms: number) => Promise<void>;
    retryDelayMs?: number;
    maxServerErrors?: number;
    maxTransientErrors?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WaitResult> {
  const delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const maxServerErrors = opts.maxServerErrors ?? Number.POSITIVE_INFINITY;
  const maxTransientErrors = opts.maxTransientErrors ?? Number.POSITIVE_INFINITY;
  let serverErrors = 0;
  let transientErrors = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const result = await callWait();
      opts.signal?.throwIfAborted();
      serverErrors = 0;
      transientErrors = 0;
      if (waitHasMail(result)) return result;
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (!isTransientWaitError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      transientErrors += 1;
      if (SERVER.test(msg)) {
        serverErrors += 1;
        if (serverErrors >= maxServerErrors) throw err;
      }
      if (transientErrors >= maxTransientErrors) throw err;
      await delay(retryDelayMs);
    }
  }
}
