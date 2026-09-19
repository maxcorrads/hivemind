import { HttpError } from "../client/http.ts";
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
  if (err instanceof HttpError) {
    if ([401, 403, 404, 409].includes(err.status)) return false;
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (FATAL.test(msg)) return false;
  return true;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitUntilMail(
  callWait: () => Promise<WaitResult>,
  opts: {
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    random?: () => number;
    maxServerErrors?: number;
    maxTransientErrors?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WaitResult> {
  const delay = opts.delay ?? abortableDelay;
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
  // Bound failed attempts, never successful idle long polls.
  const maxServerErrors = opts.maxServerErrors ?? 8;
  const maxTransientErrors = opts.maxTransientErrors ?? 8;
  for (const [name, limit] of [["maxServerErrors", maxServerErrors], ["maxTransientErrors", maxTransientErrors]] as const) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name} must be a positive finite integer`);
  }
  for (const [name, ms] of [["retryDelayMs", retryDelayMs], ["maxRetryDelayMs", maxRetryDelayMs]] as const) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`${name} must be a nonnegative finite duration`);
  }
  let serverErrors = 0;
  let transientErrors = 0;

  for (;;) {
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    try {
      const result = await callWait();
      opts.signal?.throwIfAborted();
      serverErrors = 0;
      transientErrors = 0;
      if (waitHasMail(result)) return result;
    } catch (err) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      if (!isTransientWaitError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      transientErrors += 1;
      const isServerError = err instanceof HttpError ? err.status >= 500 && err.status <= 599 : SERVER.test(msg);
      if (isServerError) {
        serverErrors += 1;
        if (serverErrors >= maxServerErrors) throw err;
      }
      if (transientErrors >= maxTransientErrors) throw err;
      const ceiling = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(transientErrors - 1, 20));
      const sample = random();
      const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
      await delay(Math.round(ceiling / 2 + (ceiling / 2) * fraction), opts.signal);
    }
  }
}
