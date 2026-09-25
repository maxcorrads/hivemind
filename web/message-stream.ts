import type { Message } from "../src/shared/types.ts";

/** Consecutive messages of one author within this window share a single header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type StreamRow =
  | { type: "date"; key: string; label: string }
  | { type: "new"; key: string }
  | { type: "message"; key: string; message: Message; grouped: boolean };

/** Slack-style clock time: "1:26 PM", never a zero-padded "01:26 PM". */
export function formatTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

function dayStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "Today", "Yesterday", or a weekday date (with the year only when it is not the current one). */
export function dayLabel(at: number, now = Date.now(), locale?: string): string {
  const today = dayStart(now);
  const day = dayStart(at);
  if (day === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Only plain chat can join a group: cards, system rows and control messages always stand alone. */
function groupable(message: Message): boolean {
  return message.kind === "chat" && !message.taskEvent;
}

/**
 * Lays out a pane: a date divider at each new day, a "New messages" divider before the first unread
 * message, and same-author messages within five minutes grouped under one header.
 */
export function streamRows(messages: Message[], { firstUnreadSeq = null, now = Date.now() }:
  { firstUnreadSeq?: number | null; now?: number } = {}): StreamRow[] {
  const rows: StreamRow[] = [];
  let previous: Message | null = null;
  let newPlaced = false;
  for (const message of messages) {
    let broken = false;
    if (!previous || dayStart(previous.createdAt) !== dayStart(message.createdAt)) {
      rows.push({ type: "date", key: `date-${dayStart(message.createdAt)}`, label: dayLabel(message.createdAt, now) });
      broken = true;
    }
    if (!newPlaced && firstUnreadSeq != null && message.seq >= firstUnreadSeq) {
      rows.push({ type: "new", key: "new-messages" });
      newPlaced = true;
      broken = true;
    }
    const grouped = !broken && previous !== null && groupable(previous) && groupable(message) &&
      previous.authorId === message.authorId && message.createdAt - previous.createdAt < GROUP_WINDOW_MS;
    rows.push({ type: "message", key: message.id, message, grouped });
    previous = message;
  }
  return rows;
}
