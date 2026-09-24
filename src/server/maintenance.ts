import type { Hive } from "./hive.ts";

/** Default retention window of the operational logs, in days (`HIVEMIND_RETENTION_DAYS`). */
export const DEFAULT_RETENTION_DAYS = 30;
/** How often `serve` runs maintenance; the first run is shortly after startup. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000;
export const MAINTENANCE_FIRST_RUN_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_RETENTION_DAYS = 36_500;

/**
 * Parses the retention window: a whole number of days, 0 disables retention pruning.
 * Unset or empty means the default (30 days); anything else is a startup error.
 */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HIVEMIND_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_RETENTION_DAYS)
    throw new Error(`HIVEMIND_RETENTION_DAYS must be a whole number of days between 0 (disabled) and ${MAX_RETENTION_DAYS}, got "${raw}"`);
  return Number(raw);
}

export type MaintenanceResult = {
  /** The cutoff used for retention, or null when retention is disabled. */
  cutoff: number | null;
  inboxDeliveries: number;
  jevCalls: number;
  uploads: { attachments: number; blobs: number };
};

/**
 * One maintenance pass. Retention prunes only append-only operational logs older than the window:
 * acknowledged or superseded inbox deliveries (per-message receipts and totals are kept) and Jev call logs.
 * Messages, tasks, decisions and room contracts are never deleted. Unsent uploads older than a day and
 * unreferenced blobs are collected (as `hivemind gc` does), then SQLite refreshes its planner statistics.
 */
export function runMaintenance(hive: Hive, options: { retentionDays: number; now?: number }): MaintenanceResult {
  const now = options.now ?? Date.now();
  const cutoff = options.retentionDays > 0 ? now - options.retentionDays * DAY_MS : null;
  const inboxDeliveries = cutoff === null ? 0 : hive.inbox.prune(cutoff);
  const jevCalls = cutoff === null ? 0 : hive.adaptiveTopology.observations.jevCalls.prune(cutoff);
  const uploads = hive.files.gcFiles();
  hive.storage.optimize();
  return { cutoff, inboxDeliveries, jevCalls, uploads };
}

/** Schedules maintenance inside `serve`; the returned function stops it (call it before closing the hive). */
export function startMaintenance(hive: Hive, options: {
  retentionDays: number; firstRunMs?: number; intervalMs?: number; onResult?: (result: MaintenanceResult) => void;
}): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    try {
      const result = runMaintenance(hive, { retentionDays: options.retentionDays });
      options.onResult?.(result);
    } catch (error) {
      // A failed pass (e.g. a busy database) is retried on the next interval; it never stops the server.
      console.error(`hivemind maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, options.intervalMs ?? MAINTENANCE_INTERVAL_MS);
    interval.unref();
  }, options.firstRunMs ?? MAINTENANCE_FIRST_RUN_MS);
  first.unref();
  return () => { clearTimeout(first); if (interval) clearInterval(interval); };
}
