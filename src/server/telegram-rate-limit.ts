export class TelegramRateLimitError extends Error {
  readonly retryAt: number;
  constructor(readonly retryAfterMs: number) {
    super(`Telegram rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "TelegramRateLimitError";
    this.retryAt = Date.now() + retryAfterMs;
  }
}

export function telegramRetryAfterMs(status: number, data: { error_code?: number; parameters?: { retry_after?: number } }, fallbackMs = 2000): number | null {
  if (status !== 429 && data.error_code !== 429) return null;
  const seconds = Number(data.parameters?.retry_after);
  return Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 < Number.MAX_SAFE_INTEGER - Date.now()
    ? Math.max(1, seconds * 1000) : fallbackMs;
}

export function selectTelegramPendingJob<T extends { seq: number; kind: "message" | "reaction" }>(
  jobs: T[], chatForSeq: (seq: number) => number | undefined,
  cooldownUntil: (chatId: number) => number, now: number,
): { job?: T; wakeAt?: number } {
  let wakeAt: number | undefined;
  for (const job of jobs) {
    const chat = chatForSeq(job.seq);
    if (chat === undefined) return { job };
    const until = cooldownUntil(chat);
    if (until <= now) return { job };
    wakeAt = wakeAt === undefined ? until : Math.min(wakeAt, until);
  }
  return { wakeAt };
}
