import type { WaitResult } from "../shared/types.ts";
import { ROUTINE_BATCH_MS } from '../shared/notifications.ts';

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
    maxRetryDelayMs?: number;
    random?: () => number;
    maxServerErrors?: number;
    maxTransientErrors?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WaitResult> {
  const delay = opts.delay ?? ((ms) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(opts.signal?.reason); };
    const timer = setTimeout(() => { opts.signal?.removeEventListener('abort', abort); resolve(); }, ms);
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  }));
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
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
      if (result.retryAfterMs) await delay(Math.max(1, Math.min(ROUTINE_BATCH_MS, result.retryAfterMs)));
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
      const ceiling = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(transientErrors - 1, 20));
      // Equal jitter avoids zero-delay loops while spreading simultaneous reconnects.
      await delay(Math.round(ceiling / 2 + ceiling / 2 * Math.max(0, Math.min(1, random()))));
    }
  }
}
