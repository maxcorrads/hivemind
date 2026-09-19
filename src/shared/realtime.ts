export const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
export const WS_HEARTBEAT_MS = 30_000;
export const LIVE_MESSAGE_WINDOW = 500;

/** Include the next UTF-8 payload before allowing ws.send to grow the buffer. */
export function websocketOverloaded(bufferedAmount: number, nextBytes = 0): boolean {
  return !Number.isFinite(bufferedAmount) || bufferedAmount < 0 ||
    !Number.isFinite(nextBytes) || nextBytes < 0 ||
    bufferedAmount + nextBytes > WS_MAX_BUFFERED_BYTES;
}

export function retainNewest<T>(items: T[], cap = LIVE_MESSAGE_WINDOW): { items: T[]; truncated: boolean } {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError("Invalid live message cap");
  if (items.length <= cap) return { items, truncated: false };
  return { items: items.slice(-cap), truncated: true };
}
