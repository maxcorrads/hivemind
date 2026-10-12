import { useEffect, useState } from "react";
import { USAGE_STALE_MS, type AccountDriver, type AccountUsage as Usage, type UsageWindow } from "../src/shared/accounts.ts";
import { usageForecast } from "../src/shared/usage-forecast.ts";
import { relativeTime } from "./RelativeTime.tsx";

/** How often the ages and countdowns are drawn again, so the Accounts sheet stays current without a reload. */
const REDRAW_MS = 30_000;

/** The current time, read again every 30 s. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REDRAW_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * "in 2 h 14 min", "in 3 d 4 h", "in 9 min" or "in under a minute"; "reset passed" once the reset time is behind `now`.
 * A week-long window counts in days, so it stays readable.
 */
function countdown(resetsAt: number, now: number): string {
  if (resetsAt <= now) return "reset passed";
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  if (days > 0) return hours > 0 ? `in ${days} d ${hours} h` : `in ${days} d`;
  if (hours > 0) return rest > 0 ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  return `in ${rest} min`;
}

/** A local date and time such as "Oct 12, 4:00 PM", in the viewer's locale. */
function localTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** What older Server.app builds sent when a Claude account had reported nothing yet: not a failure, so not shown as one. */
const LEGACY_NO_CLAUDE_DATA = "No recent Claude usage data";

/** Why a row has no numbers yet, and how they come. */
function noUsageYet(driver: AccountDriver): string {
  return driver === "claude"
    ? "No usage yet. Claude reports it from sessions Hivemind launches with this account, after their first reply."
    : "No usage yet: Hivemind Server.app reads it every 5 minutes.";
}

/**
 * An account's quota usage (docs/accounts.md, "Usage"): each window as a bar of what is left, its reset time with a
 * countdown, and where the current pace leads, plus what is known about the latest read. `now` comes from the caller,
 * so every row shares one clock.
 */
export function AccountUsage({ usage, now, driver }: { usage: Usage | undefined; now: number; driver: AccountDriver }) {
  const snapshot = usage?.snapshot ?? null;
  const stale = snapshot !== null && now - snapshot.capturedAt > USAGE_STALE_MS;
  const limitErrorAt = usage?.limitErrorAt ?? null;
  const lastError = usage?.lastError === LEGACY_NO_CLAUDE_DATA ? null : usage?.lastError ?? null;
  return (
    <div className="account-usage">
      <p className="help-p">
        {snapshot ? `Usage as of ${relativeTime(snapshot.capturedAt, now)}${stale ? " · stale" : ""}` : noUsageYet(driver)}
        {limitErrorAt !== null && <> · Limit error at <time dateTime={new Date(limitErrorAt).toISOString()}>{localTime(limitErrorAt)}</time></>}
      </p>
      {lastError && <p className="err">Last read failed: {lastError}</p>}
      {snapshot && (snapshot.plan === "api-key" ? <p className="help-p">API key: no plan window</p>
        : snapshot.windows.length === 0 ? <p className="help-p">No quota window reported</p>
        : snapshot.windows.map(quota => <UsageWindowRow key={quota.key} quota={quota} now={now} capturedAt={snapshot.capturedAt} />))}
    </div>
  );
}

function UsageWindowRow({ quota, now, capturedAt }: { quota: UsageWindow; now: number; capturedAt: number }) {
  const { label, usedPercent, resetsAt } = quota;
  const left = Math.max(0, 100 - usedPercent);
  const forecast = resetsAt !== null && resetsAt > now ? usageForecast(quota, capturedAt) : null;
  return (
    <div className="account-usage-window">
      <span>{label}</span>
      {/* Full when nothing is used, empty when the window is used up. */}
      <progress max={100} value={left} aria-label={`${label} left`} />
      <span>{Math.round(left)}% left</span>
      <span>
        {resetsAt === null ? "No reset time" : <>Resets <time dateTime={new Date(resetsAt).toISOString()}>{localTime(resetsAt)}</time> · {countdown(resetsAt, now)}</>}
      </span>
      {forecast && (
        <span className="account-usage-forecast">
          {forecast.kind === "usedUp" ? "Used up until the reset"
            : forecast.kind === "lasts" ? "At this pace it lasts until the reset"
            // An old read can lead to a time already behind us: at that pace the window is gone by now.
            : forecast.at <= now ? "At this pace it is probably used up already"
            : <>At this pace it runs out <time dateTime={new Date(forecast.at).toISOString()}>{localTime(forecast.at)}</time> · {countdown(forecast.at, now)}</>}
        </span>
      )}
    </div>
  );
}
