import type { UsageWindow } from "./accounts.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** The length of a window that came without `windowMs`, from what its key or label says: Claude's keys, Codex's labels. */
function inferredLength(window: UsageWindow): number | null {
  if (window.key === "five_hour" || /^5 h\b/.test(window.label) || window.label.endsWith(" 5 h")) return 5 * HOUR;
  if (window.key === "seven_day" || window.key.startsWith("seven_day_") || /\bWeek\b|\(week\)/.test(window.label)) return 7 * DAY;
  if (/\bDay\b/.test(window.label)) return DAY;
  return null;
}

/** What one window is heading for at the pace it has been used so far (docs/accounts.md, "Usage"). */
export type UsageForecast =
  | { kind: "runsOut"; at: number }
  | { kind: "lasts" }
  | { kind: "usedUp" };

/** The share of a window that must have passed before a pace means anything, and never under 10 minutes. */
const MIN_ELAPSED_SHARE = 0.05;
const MIN_ELAPSED_MS = 10 * 60_000;

/**
 * When `window` runs out if it keeps being used at its average pace so far: from the window's start (its reset minus its
 * length) to `capturedAt`, the time its numbers were read. A straight line, so it knows nothing of bursts or quiet
 * hours. Null when the length or the reset is unknown, when the read is too early in the window to tell, or when the
 * read is older than the window itself.
 */
export function usageForecast(window: UsageWindow, capturedAt: number): UsageForecast | null {
  const length = window.windowMs ?? inferredLength(window);
  if (window.resetsAt === null || !length) return null;
  if (window.usedPercent >= 100) return { kind: "usedUp" };
  const elapsed = capturedAt - (window.resetsAt - length);
  if (elapsed > length || elapsed < Math.max(length * MIN_ELAPSED_SHARE, MIN_ELAPSED_MS)) return null;
  if (window.usedPercent <= 0) return { kind: "lasts" };
  const at = capturedAt + (100 - window.usedPercent) * (elapsed / window.usedPercent);
  return at >= window.resetsAt ? { kind: "lasts" } : { kind: "runsOut", at: Math.round(at) };
}
