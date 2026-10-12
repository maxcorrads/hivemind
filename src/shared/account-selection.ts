import { USAGE_STALE_MS, type AccountPolicy, type AccountUsage, type AgentAccount, type UsageSnapshot, type UsageWindow } from "./accounts.ts";

/**
 * Which account a launch of `codex` or `claude` uses (docs/accounts.md): a pin, else the driver's policy. Pure: the
 * caller passes the accounts, their usage and the clock, so the same rules run in the server and in the tests.
 */
export type AccountSelectionInput = { accounts: readonly AgentAccount[] /* one driver */; policy: AccountPolicy;
  usage: ReadonlyMap<string, AccountUsage>; now: number /* unix ms */; pin?: string | null };
export type AccountSelection =
  | { kind: "none" }                                         // the driver has no accounts: launch as today
  | { kind: "account"; account: AgentAccount; reason: "pin" | "sequential" | "balanced" | "round-robin";
      stale: boolean; warning: string | null }
  | { kind: "exhausted"; earliestReset: number | null }
  | { kind: "unknown-pin"; pin: string };

/**
 * The snapshot that counts: one that reports at least one window. A failed first read or an API key has none, so
 * nothing about its usage is known.
 */
function snapshotWithWindows(usage: AccountUsage | undefined): UsageSnapshot | null {
  const snapshot = usage?.snapshot ?? null;
  return snapshot && snapshot.windows.length > 0 ? snapshot : null;
}

function isStale(usage: AccountUsage | undefined, now: number): boolean {
  const snapshot = snapshotWithWindows(usage);
  return snapshot === null || now - snapshot.capturedAt > USAGE_STALE_MS;
}

/**
 * Exhausted while a window is at 100% and has no reset or a reset in the future, or while `limitResetAt` is in the
 * future. `resetsAt` is the latest known reset among those reasons, or null.
 */
export function accountExhausted(usage: AccountUsage | undefined, now: number): { exhausted: boolean; resetsAt: number | null } {
  const resets: Array<number | null> = [];
  for (const window of usage?.snapshot?.windows ?? []) {
    if (window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > now)) resets.push(window.resetsAt);
  }
  const limitResetAt = usage?.limitResetAt ?? null;
  if (limitResetAt !== null && limitResetAt > now) resets.push(limitResetAt);
  if (resets.length === 0) return { exhausted: false, resetsAt: null };
  const known = resets.filter((resetsAt): resetsAt is number => resetsAt !== null);
  return { exhausted: true, resetsAt: known.length > 0 ? Math.max(...known) : null };
}

/** Balanced score: the quota left in the window that resets first; with no future reset, in the fullest window. */
function balancedScore(snapshot: UsageSnapshot, now: number): number {
  const future = snapshot.windows.filter((window): window is UsageWindow & { resetsAt: number } =>
    window.resetsAt !== null && window.resetsAt > now);
  if (future.length === 0) return 100 - Math.max(...snapshot.windows.map(window => window.usedPercent));
  const soonest = future.reduce((best, window) => (window.resetsAt < best.resetsAt ? window : best));
  return 100 - soonest.usedPercent;
}

/** The item with the largest score; ties keep the earlier item, so the caller's order breaks them. */
function bestOf<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const value = score(item);
    if (best === undefined || value > best.score) best = { item, score: value };
  }
  return best?.item;
}

function pinWarning(label: string, resetsAt: number | null): string {
  return resetsAt === null ? `${label} is used up` : `${label} is used up until ${new Date(resetsAt).toISOString()}`;
}

function pinned(accounts: readonly AgentAccount[], pin: string, usage: ReadonlyMap<string, AccountUsage>, now: number): AccountSelection {
  const account = accounts.find(candidate => candidate.id === pin);
  if (!account) return { kind: "unknown-pin", pin };
  const { exhausted, resetsAt } = accountExhausted(usage.get(account.id), now);
  return { kind: "account", account, reason: "pin", stale: isStale(usage.get(account.id), now),
    warning: exhausted ? pinWarning(account.label, resetsAt) : null };
}

/** The account a policy takes from the accounts that are not exhausted (`accounts` in order), or undefined. */
function chooseByPolicy(usable: readonly AgentAccount[], policy: AccountPolicy, usage: ReadonlyMap<string, AccountUsage>,
  now: number): { account: AgentAccount; reason: "sequential" | "balanced" | "round-robin" } | undefined {
  if (policy === "sequential") {
    const [first] = usable;
    return first ? { account: first, reason: "sequential" } : undefined;
  }
  const measured = usable.flatMap(account => {
    const snapshot = snapshotWithWindows(usage.get(account.id));
    return snapshot ? [{ account, snapshot }] : [];
  });
  const best = bestOf(measured, ({ snapshot }) => balancedScore(snapshot, now));
  if (best) return { account: best.account, reason: "balanced" };
  // No snapshot to score: round-robin, the account picked longest ago first (never picked goes first).
  const oldest = bestOf(usable, account => -(account.lastSelectedAt ?? -Infinity));
  return oldest ? { account: oldest, reason: "round-robin" } : undefined;
}

/** The first reset among the accounts, from each account's latest known reset. */
function earliestReset(accounts: readonly AgentAccount[], usage: ReadonlyMap<string, AccountUsage>, now: number): number | null {
  const resets = accounts.flatMap(account => {
    const { resetsAt } = accountExhausted(usage.get(account.id), now);
    return resetsAt === null ? [] : [resetsAt];
  });
  return resets.length > 0 ? Math.min(...resets) : null;
}

/**
 * The account one launch uses. A pin wins over the policy, even when exhausted (then `warning` says so). Otherwise
 * `sequential` takes the first account in `order` that is not exhausted; `balanced` takes the most quota left, and
 * round-robins when no account has usage yet. When every account is exhausted, the caller gets the earliest reset.
 */
export function selectAccount(input: AccountSelectionInput): AccountSelection {
  const { accounts, policy, usage, now, pin } = input;
  if (pin !== undefined && pin !== null) return pinned(accounts, pin, usage, now);
  if (accounts.length === 0) return { kind: "none" };
  const ordered = [...accounts].sort((a, b) => a.order - b.order);
  const usable = ordered.filter(account => !accountExhausted(usage.get(account.id), now).exhausted);
  const choice = chooseByPolicy(usable, policy, usage, now);
  if (!choice) return { kind: "exhausted", earliestReset: earliestReset(ordered, usage, now) };
  return { kind: "account", account: choice.account, reason: choice.reason, stale: isStale(usage.get(choice.account.id), now),
    warning: null };
}
