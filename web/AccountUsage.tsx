import { useEffect, useState } from "react";
import { USAGE_STALE_MS, type AccountUsage as Usage, type UsageWindow } from "../src/shared/accounts.ts";
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

/**
 * An account's quota usage (docs/accounts.md, "Usage"): each window as a bar and a number, with its reset time and a
 * countdown to it, and what is known about the latest read. `now` comes from the caller, so every row shares one clock.
 */
export function AccountUsage({ usage, now }: { usage: Usage | undefined; now: number }) {
  const snapshot = usage?.snapshot ?? null;
  const stale = snapshot !== null && now - snapshot.capturedAt > USAGE_STALE_MS;
  const limitErrorAt = usage?.limitErrorAt ?? null;
  return (
    <div className="account-usage">
      <p className="help-p">
        {snapshot ? `Usage as of ${relativeTime(snapshot.capturedAt, now)}${stale ? " · stale" : ""}` : "Usage unknown"}
        {limitErrorAt !== null && <> · Limit error at <time dateTime={new Date(limitErrorAt).toISOString()}>{localTime(limitErrorAt)}</time></>}
      </p>
      {usage?.lastError && <p className="err">Last read failed: {usage.lastError}</p>}
      {snapshot && (snapshot.plan === "api-key" ? <p className="help-p">API key: no plan window</p>
        : snapshot.windows.length === 0 ? <p className="help-p">No quota window reported</p>
        : snapshot.windows.map(quota => <UsageWindowRow key={quota.key} quota={quota} now={now} />))}
    </div>
  );
}

function UsageWindowRow({ quota, now }: { quota: UsageWindow; now: number }) {
  const { label, usedPercent, resetsAt } = quota;
  return (
    <div className="account-usage-window">
      <span>{label}</span>
      <progress max={100} value={usedPercent} aria-label={`${label} used`} />
      <span>{Math.round(usedPercent)}% used</span>
      <span>
        {resetsAt === null ? "No reset time" : <>Resets <time dateTime={new Date(resetsAt).toISOString()}>{localTime(resetsAt)}</time> · {countdown(resetsAt, now)}</>}
      </span>
    </div>
  );
}
