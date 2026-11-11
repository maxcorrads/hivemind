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
  assert.deepEqual(usageForecast(window({ usedPercent: 40 }), T, T), { kind: "runsOut", at: T + 1.5 * HOUR });
  // 1 h in at 20%: the remaining 80% would take 4 h, exactly the reset, so the window lasts.
  assert.deepEqual(usageForecast(window({ usedPercent: 20 }), T, T), { kind: "lasts" });
  assert.deepEqual(usageForecast(window({ usedPercent: 10 }), T, T), { kind: "lasts" });
  // A day into a week at 25%: 25% a day leaves 3 days, before the reset in 6 days.
  assert.deepEqual(usageForecast(window({ key: "seven_day", label: "Week", usedPercent: 25, resetsAt: T + 6 * DAY, windowMs: 7 * DAY }), T, T),
    { kind: "runsOut", at: T + 3 * DAY });
  assert.deepEqual(usageForecast(window({ usedPercent: 100 }), T, T), { kind: "usedUp" });
  assert.deepEqual(usageForecast(window({ usedPercent: 0 }), T, T), { kind: "lasts" });
});

test("no forecast too early in a window, without a reset or a length, or from a read older than the window", () => {
  assert.equal(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 5 * MINUTE }), T, T), null, "5 minutes in");
  assert.equal(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 14 * MINUTE }), T, T), null, "under 5% of 5 h");
  assert.notEqual(usageForecast(window({ usedPercent: 5, resetsAt: T + 5 * HOUR - 16 * MINUTE }), T, T), null, "past 5% of 5 h");
  assert.equal(usageForecast(window({ usedPercent: 40, resetsAt: null }), T, T), null);
  assert.equal(usageForecast(window({ key: "codex.primary", label: "30 min", usedPercent: 40, windowMs: null }), T, T), null);
  assert.equal(usageForecast(window({ usedPercent: 40, resetsAt: T - 6 * HOUR }), T, T), null, "the window it describes is over");
});

test("a snapshot from before windowMs still gets a forecast from its key or label", () => {
  const before = { usedPercent: 40, windowMs: undefined };
  assert.deepEqual(usageForecast(window({ ...before }), T, T), { kind: "runsOut", at: T + 1.5 * HOUR }, "Claude's five_hour key");
  assert.deepEqual(usageForecast(window({ ...before, key: "codex.primary", label: "5 h" }), T, T), { kind: "runsOut", at: T + 1.5 * HOUR });
  assert.deepEqual(usageForecast(window({ ...before, key: "codex.secondary", label: "Week", usedPercent: 25, resetsAt: T + 6 * DAY }), T, T),
    { kind: "runsOut", at: T + 3 * DAY });
  assert.deepEqual(usageForecast(window({ ...before, key: "seven_day_opus", label: "Opus (week)", usedPercent: 25, resetsAt: T + 6 * DAY }), T, T),
    { kind: "runsOut", at: T + 3 * DAY });
});

test("an old read whose pace led to a time at or behind now is probably used up, never a time in the past", () => {
  // Read at T, 1 h into a 5 h window at 40%: the pace leads to T + 1.5 h, and the reset is at T + 4 h.
  const quota = window({ usedPercent: 40 });
  const at = T + 1.5 * HOUR;
  assert.deepEqual(usageForecast(quota, T, T + HOUR), { kind: "runsOut", at }, "still ahead an hour after the read");
  assert.deepEqual(usageForecast(quota, T, at - 1), { kind: "runsOut", at }, "still ahead by a millisecond");
  assert.deepEqual(usageForecast(quota, T, at), { kind: "probablyUsedUp", at }, "exactly now");
  assert.deepEqual(usageForecast(quota, T, T + 2 * HOUR), { kind: "probablyUsedUp", at }, "half an hour behind");
  // A read a day old, a day into a week at 97%: the rest went within the hour after the read.
  const week = window({ key: "seven_day", label: "Week", usedPercent: 97, resetsAt: T + 6 * DAY, windowMs: 7 * DAY });
  const forecast = usageForecast(week, T, T + 22 * HOUR);
  assert.ok(forecast !== null && forecast.kind === "probablyUsedUp", "probably used up 22 h after the read");
  assert.ok(forecast.at > T && forecast.at < T + HOUR, "the pace led to a time within the hour after the read");
});

test("an old read keeps what does not depend on now, and says nothing once the reset is behind now", () => {
  // The reset is at T + 4 h.
  assert.deepEqual(usageForecast(window({ usedPercent: 10 }), T, T + 3 * HOUR), { kind: "lasts" });
  assert.deepEqual(usageForecast(window({ usedPercent: 100 }), T, T + 3 * HOUR), { kind: "usedUp" });
  assert.deepEqual(usageForecast(window({ usedPercent: 40 }), T, T + 4 * HOUR - 1), { kind: "probablyUsedUp", at: T + 1.5 * HOUR });
  for (const usedPercent of [10, 40, 100]) {
    assert.equal(usageForecast(window({ usedPercent }), T, T + 4 * HOUR), null, `${usedPercent}% at the reset`);
    assert.equal(usageForecast(window({ usedPercent }), T, T + 5 * HOUR), null, `${usedPercent}% after the reset`);
  }
});
