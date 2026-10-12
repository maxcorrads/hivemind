import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE_STALE_MS, type AccountUsage, type AgentAccount, type UsageSnapshot } from "./accounts.ts";
import { accountExhausted, selectAccount, type AccountSelection, type AccountSelectionInput } from "./account-selection.ts";

const NOW = 1_791_900_000_000;
const HOUR = 3_600_000;

const account = (order: number, overrides: Partial<AgentAccount> = {}): AgentAccount => ({
  id: `acc-${order + 1}`, driver: "codex", command: "codex", label: `Codex ${order + 1}`, homePath: "", shadowPath: "",
  order, revision: 1, lastSelectedAt: null, createdAt: 1, updatedAt: 1, ...overrides,
});

/** One account's usage read; each window is [usedPercent, resetsAt]. */
function usageOf(accountId: string, windows: Array<[number, number | null]>, extra: Partial<AccountUsage> = {},
  capturedAt = NOW): AccountUsage {
  const snapshot: UsageSnapshot = {
    accountId, capturedAt, source: "codex", plan: "subscription", error: null, limitErrorAt: null,
    windows: windows.map(([usedPercent, resetsAt], index) => ({ key: `w${index}`, label: `W${index}`, usedPercent, resetsAt })),
  };
  return { accountId, snapshot, lastAttemptAt: capturedAt, lastError: null, limitResetAt: null, limitErrorAt: null, ...extra };
}

const select = (accounts: AgentAccount[], policy: AccountSelectionInput["policy"], usage: AccountUsage[] = [],
  overrides: Partial<AccountSelectionInput> = {}): AccountSelection =>
  selectAccount({ accounts, policy, usage: new Map(usage.map(item => [item.accountId, item] as const)), now: NOW, ...overrides });

/** The chosen account's id, reason, stale flag and warning; fails the test when no account was chosen. */
function chosen(selection: AccountSelection) {
  assert.equal(selection.kind, "account", JSON.stringify(selection));
  const picked = selection as Extract<AccountSelection, { kind: "account" }>;
  return { id: picked.account.id, reason: picked.reason, stale: picked.stale, warning: picked.warning };
}

test("sequential uses the first account until it is used up, then the next, and returns after its reset", () => {
  const accounts = [account(0), account(1)];
  assert.deepEqual(chosen(select(accounts, "sequential")), { id: "acc-1", reason: "sequential", stale: true, warning: null });
  const first = usageOf("acc-1", [[100, NOW + HOUR]]);
  assert.equal(chosen(select(accounts, "sequential", [first])).id, "acc-2");
  assert.equal(chosen(select(accounts, "sequential", [first], { now: NOW + HOUR })).id, "acc-1", "the reset has come");
});

test("balanced picks the account with the most quota left in the window that resets first", () => {
  const accounts = [account(0), account(1)];
  const usage = [usageOf("acc-1", [[60, NOW + HOUR]]), usageOf("acc-2", [[20, NOW + HOUR]])];
  assert.deepEqual(chosen(select(accounts, "balanced", usage)), { id: "acc-2", reason: "balanced", stale: false, warning: null });
});

test("balanced scores the window that resets first, not the fullest one", () => {
  const accounts = [account(0), account(1)];
  // acc-1: 10% used in a far window, 90% used in the window that resets first: score 10.
  const soonFull = usageOf("acc-1", [[10, NOW + 5 * HOUR], [90, NOW + HOUR]]);
  // acc-2: 50% used in its only window: score 50.
  const halfUsed = usageOf("acc-2", [[50, NOW + 2 * HOUR]]);
  assert.equal(chosen(select(accounts, "balanced", [soonFull, halfUsed])).id, "acc-2");
  // With no future reset, the score is 100 minus the fullest window: acc-1 scores 10, acc-2 scores 50.
  const noFutureFull = usageOf("acc-1", [[10, null], [90, NOW - 1]]);
  const noFutureHalf = usageOf("acc-2", [[50, NOW - 1]]);
  assert.equal(chosen(select(accounts, "balanced", [noFutureFull, noFutureHalf])).id, "acc-2");
});

test("balanced ties go by order, whatever the order of the list", () => {
  const usage = [usageOf("acc-1", [[40, NOW + HOUR]]), usageOf("acc-2", [[40, NOW + HOUR]])];
  assert.equal(chosen(select([account(0), account(1)], "balanced", usage)).id, "acc-1");
  assert.equal(chosen(select([account(1), account(0)], "balanced", usage)).id, "acc-1");
});

test("with no snapshots, balanced round-robins by last selection and the choice is stale", () => {
  const accounts = [account(0, { lastSelectedAt: NOW - 100 }), account(1, { lastSelectedAt: null })];
  assert.deepEqual(chosen(select(accounts, "balanced")), { id: "acc-2", reason: "round-robin", stale: true, warning: null }, "never picked goes first");
  const both = [account(0, { lastSelectedAt: NOW - 100 }), account(1, { lastSelectedAt: NOW - 200 })];
  assert.equal(chosen(select(both, "balanced")).id, "acc-2", "the oldest pick goes first");
  const tied = [account(0), account(1)];
  assert.equal(chosen(select(tied, "balanced")).id, "acc-1", "ties go by order");
});

test("balanced prefers an account with a snapshot over one without", () => {
  const accounts = [account(0), account(1)];
  // acc-1 has no snapshot at all and was never picked, so round-robin would choose it.
  const measured = usageOf("acc-2", [[90, NOW + HOUR]]);
  assert.deepEqual(chosen(select(accounts, "balanced", [measured])), { id: "acc-2", reason: "balanced", stale: false, warning: null });
});

test("a snapshot with no windows is unknown usage, so it does not beat a measured account", () => {
  const accounts = [account(0), account(1)];
  const empty = usageOf("acc-1", []);
  const measured = usageOf("acc-2", [[90, NOW + HOUR]]);
  assert.equal(chosen(select(accounts, "balanced", [empty, measured])).id, "acc-2");
  assert.equal(chosen(select(accounts, "balanced", [empty])).stale, true);
});

test("all exhausted gives the earliest reset", () => {
  const accounts = [account(0), account(1)];
  const usage = [usageOf("acc-1", [[100, NOW + 3 * HOUR]]), usageOf("acc-2", [[100, NOW + HOUR]])];
  assert.deepEqual(select(accounts, "sequential", usage), { kind: "exhausted", earliestReset: NOW + HOUR });
  assert.deepEqual(select(accounts, "balanced", usage), { kind: "exhausted", earliestReset: NOW + HOUR });
  const unknownReset = [usageOf("acc-1", [[100, null]]), usageOf("acc-2", [[100, NOW + 2 * HOUR]])];
  assert.deepEqual(select(accounts, "sequential", unknownReset), { kind: "exhausted", earliestReset: NOW + 2 * HOUR }, "a null reset is not known");
  const noneKnown = [usageOf("acc-1", [[100, null]]), usageOf("acc-2", [[100, null]])];
  assert.deepEqual(select(accounts, "sequential", noneKnown), { kind: "exhausted", earliestReset: null });
});

test("a pin ignores the policy", () => {
  const accounts = [account(0), account(1)];
  const usage = [usageOf("acc-1", [[5, NOW + HOUR]]), usageOf("acc-2", [[90, NOW + HOUR]])];
  assert.deepEqual(chosen(select(accounts, "balanced", usage, { pin: "acc-2" })),
    { id: "acc-2", reason: "pin", stale: false, warning: null });
  assert.deepEqual(chosen(select(accounts, "sequential", usage, { pin: "acc-2" })),
    { id: "acc-2", reason: "pin", stale: false, warning: null });
  assert.equal(chosen(select(accounts, "sequential", usage, { pin: null })).id, "acc-1", "a null pin is no pin");
});

test("a pin on an exhausted account wins and warns with the reset time", () => {
  const accounts = [account(0), account(1)];
  const usage = [usageOf("acc-1", [[100, NOW + HOUR]])];
  const pinned = chosen(select(accounts, "sequential", usage, { pin: "acc-1" }));
  assert.equal(pinned.id, "acc-1");
  assert.equal(pinned.reason, "pin");
  assert.equal(pinned.warning, `Codex 1 is used up until ${new Date(NOW + HOUR).toISOString()}`);
  const noReset = chosen(select(accounts, "sequential", [usageOf("acc-1", [[100, null]])], { pin: "acc-1" }));
  assert.equal(noReset.warning, "Codex 1 is used up");
});

test("an unknown pin gives unknown-pin", () => {
  assert.deepEqual(select([account(0)], "sequential", [], { pin: "acc-9" }), { kind: "unknown-pin", pin: "acc-9" });
  assert.deepEqual(select([], "sequential", [], { pin: "acc-9" }), { kind: "unknown-pin", pin: "acc-9" }, "a pin never falls back to no account");
});

test("no accounts gives none", () => {
  assert.deepEqual(select([], "sequential"), { kind: "none" });
  assert.deepEqual(select([], "balanced"), { kind: "none" });
});

test("a past reset is not exhausted", () => {
  const past = usageOf("acc-1", [[100, NOW - 1]]);
  assert.deepEqual(accountExhausted(past, NOW), { exhausted: false, resetsAt: null });
  assert.equal(chosen(select([account(0), account(1)], "sequential", [past])).id, "acc-1");
  assert.deepEqual(accountExhausted(usageOf("acc-1", [[100, NOW]]), NOW), { exhausted: false, resetsAt: null }, "a reset at now has come");
  assert.deepEqual(accountExhausted(usageOf("acc-1", [[100, NOW + 1]]), NOW), { exhausted: true, resetsAt: NOW + 1 });
  assert.deepEqual(accountExhausted(usageOf("acc-1", [[99.9, NOW + HOUR]]), NOW), { exhausted: false, resetsAt: null });
  assert.deepEqual(accountExhausted(undefined, NOW), { exhausted: false, resetsAt: null });
});

test("limitResetAt exhausts an account until it is in the past", () => {
  const limited = usageOf("acc-1", [[10, NOW + HOUR]], { limitResetAt: NOW + 2 * HOUR });
  assert.deepEqual(accountExhausted(limited, NOW), { exhausted: true, resetsAt: NOW + 2 * HOUR });
  assert.equal(chosen(select([account(0), account(1)], "sequential", [limited])).id, "acc-2");
  const over = usageOf("acc-1", [[10, NOW + HOUR]], { limitResetAt: NOW - 1 });
  assert.deepEqual(accountExhausted(over, NOW), { exhausted: false, resetsAt: null });
  // The latest known reset among the reasons: the window's reset here, the later limit reset when both are in the future.
  const both = usageOf("acc-1", [[100, NOW + HOUR]], { limitResetAt: NOW + 3 * HOUR });
  assert.deepEqual(accountExhausted(both, NOW), { exhausted: true, resetsAt: NOW + 3 * HOUR });
});

test("a snapshot older than the stale limit is stale", () => {
  const accounts = [account(0)];
  const fresh = usageOf("acc-1", [[10, NOW + HOUR]], {}, NOW - USAGE_STALE_MS);
  assert.equal(chosen(select(accounts, "sequential", [fresh])).stale, false, "exactly the limit is not older");
  const old = usageOf("acc-1", [[10, NOW + HOUR]], {}, NOW - USAGE_STALE_MS - 1);
  assert.equal(chosen(select(accounts, "sequential", [old])).stale, true);
});
