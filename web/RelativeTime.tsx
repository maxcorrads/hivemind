const UNITS: Array<[ms: number, unit: string]> = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm']];

/** "just now", "5m ago", "in 2h": a compact distance from `now`, floored to the largest whole unit. */
export function relativeTime(at: number, now = Date.now()): string {
  const diff = at - now, distance = Math.abs(diff);
  if (distance < 60_000) return diff > 0 ? 'in under a minute' : 'just now';
  const [ms, unit] = UNITS.find(([size]) => distance >= size)!;
  const n = Math.floor(distance / ms);
  return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

/** A relative time with the exact local time on hover. */
export function RelativeTime({ at, now }: { at: number; now?: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>{relativeTime(at, now)}</time>;
}
