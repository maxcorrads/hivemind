import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageWindow } from "./accounts.ts";
import { usageForecast } from "./usage-forecast.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR, MINUTE = 60_000;
const T = Date.parse("2026-10-13T09:00:00Z");
const window = (patch: Partial<UsageWindow>): UsageWindow => ({ key: "five_hour", label: "Session (5 h)", usedPercent: 0,
  resetsAt: T + 4 * HOUR, windowMs: 5 * HOUR, ...patch });

test("a window runs out where its average pace since the window started leads, or lasts until the reset", () => {
  // 1 h into a 5 h window at 40%: 40% an hour, so the other 60% go in 1.5 h, before the reset in 4 h.
  assert.deepEqual(usageForecast(window({ usedPercent: 40 }), T), { kind: "runsOut", at: T + 1.5 * HOUR });
  // 1 h in at 20%: the remaining 80% would take 4 h, exactly the reset, so the window lasts.
  assert.deepEqual(usageForecast(window({ usedPercent: 20 }), T), { kind: "lasts" });
  assert.deepEqual(usageForecast(window({ usedPercent: 10 }), T), { kind: "lasts" });
  // A day into a week at 25%: 25% a day leaves 3 days, before the reset in 6 days.
  assert.deepEqual(usageForecast(window({ key: "seven_day", label: "Week", usedPercent: 25, resetsAt: T + 6 * DAY, windowMs: 7 * DAY }), T),
    { kind: "runsOut", at: T + 3 * DAY });
  assert.deepEqual(usageForecast(window({ usedPercent: 100 }), T), { kind: "usedUp" });
  assert.deepEqual(usageForecast(window({ usedPercent: 0 }), T), { kind: "lasts" });
});

test("no forecast too early in a window, without a reset or a length, or from a read older than the window", () => {
  assert.equal(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 5 * MINUTE }), T), null, "5 minutes in");
  assert.equal(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 14 * MINUTE }), T), null, "under 5% of 5 h");
  assert.notEqual(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 16 * MINUTE }), T), null, "past 5% of 5 h");
  assert.equal(usageForecast(window({ usedPercent: 40, resetsAt: null }), T), null);
  assert.equal(usageForecast(window({ key: "codex.primary", label: "30 min", usedPercent: 40, windowMs: null }), T), null);
  assert.equal(usageForecast(window({ usedPercent: 40, resetsAt: T - 6 * HOUR }), T), null, "the window it describes is over");
});

test("a snapshot from before windowMs still gets a forecast from its key or label", () => {
  const before = { usedPercent: 40, windowMs: undefined };
  assert.deepEqual(usageForecast(window({ ...before }), T), { kind: "runsOut", at: T + 1.5 * HOUR }, "Claude's five_hour key");
  assert.deepEqual(usageForecast(window({ ...before, key: "codex.primary", label: "5 h" }), T), { kind: "runsOut", at: T + 1.5 * HOUR });
  assert.deepEqual(usageForecast(window({ ...before, key: "codex.secondary", label: "Week", usedPercent: 25, resetsAt: T + 6 * DAY }), T),
    { kind: "runsOut", at: T + 3 * DAY });
  assert.deepEqual(usageForecast(window({ ...before, key: "seven_day_opus", label: "Opus (week)", usedPercent: 25, resetsAt: T + 6 * DAY }), T),
    { kind: "runsOut", at: T + 3 * DAY });
});
