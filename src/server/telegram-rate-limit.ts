export class TelegramRateLimitError extends Error {
  readonly retryAt: number;
  constructor(readonly retryAfterMs: number) {
    super(`Telegram rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "TelegramRateLimitError";
    this.retryAt = Date.now() + retryAfterMs;
  }
}

export function telegramRetryAfterMs(
  status: number, data: { error_code?: number; parameters?: { retry_after?: unknown } },
  fallbackMs = 2000, retryAfterHeader?: string | null,
): number | null {
  if (status !== 429 && data?.error_code !== 429) return null;
  const raw = data?.parameters?.retry_after;
  const seconds = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  let delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : NaN;
  if (retryAfterHeader?.trim()) {
    const headerSeconds = Number(retryAfterHeader);
    const headerDelay = Number.isFinite(headerSeconds) && headerSeconds >= 0 ? headerSeconds * 1000 : Date.parse(retryAfterHeader) - Date.now();
    if (Number.isFinite(headerDelay) && headerDelay >= 0) delay = Math.max(Number.isFinite(delay) ? delay : 0, headerDelay);
  }
  return Number.isFinite(delay) && delay < Number.MAX_SAFE_INTEGER - Date.now()
    ? Math.max(1000, delay) : Math.max(1000, Number.isFinite(fallbackMs) ? fallbackMs : 2000);
}

export function selectTelegramPendingJob<T extends { seq: number; kind: "message" | "reaction" }>(
  jobs: T[], chatForSeq: (seq: number) => number | undefined,
  cooldownUntil: (chatId: number) => number, now: number, lastChat?: number,
): { job?: T; wakeAt?: number } {
  let wakeAt: number | undefined;
  const chats = [...new Set(jobs.map(job => chatForSeq(job.seq)))];
  const last = chats.indexOf(lastChat);
  const order = lastChat !== undefined && last >= 0 ? [...chats.slice(last + 1), ...chats.slice(0, last + 1)] : chats;
  // Preserve FIFO within each chat while giving every eligible chat a turn.
  for (const candidate of order) {
    const job = jobs.find(job => chatForSeq(job.seq) === candidate)!;
    const chat = chatForSeq(job.seq);
    if (chat === undefined) return { job };
    const until = cooldownUntil(chat);
    if (until <= now) return { job };
    wakeAt = wakeAt === undefined ? until : Math.min(wakeAt, until);
  }
  return { wakeAt };
}
