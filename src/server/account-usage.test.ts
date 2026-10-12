import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { HiveError } from "../shared/types.ts";
import type { AccountSpec, UsageSnapshot } from "../shared/accounts.ts";

// Account usage (phase 5, #325): the latest good snapshot per account, kept across failed reads. In-process only.

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({
  driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "", ...patch,
});

const refused = (status: number, message?: RegExp) => (error: unknown) =>
  error instanceof HiveError && error.status === status && (message === undefined || message.test(error.message));

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-account-usage-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.close(); rmSync(dir, { recursive: true, force: true }); });
  const events: string[] = [];
  hive.bus.on("accounts", () => events.push("accounts"));
  return { hive, human: hive.identity.getAgent("human"), events };
}

const snapshot = (accountId: string, patch: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  accountId, capturedAt: 1_000, source: "codex", plan: "subscription", error: null, limitErrorAt: null,
  windows: [{ key: "codex.primary", label: "5 h", usedPercent: 40, resetsAt: 2_000 },
    { key: "codex.secondary", label: "Week", usedPercent: 12.5, resetsAt: null }],
  ...patch,
});

/** A failed read carries no windows; the store keeps the previous ones. */
const failed = (accountId: string, capturedAt: number, error = "Usage read failed"): UsageSnapshot =>
  snapshot(accountId, { capturedAt, error, windows: [] });

test("a good snapshot is listed and mapped with its windows, plan and capture time", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  assert.deepEqual(hive.accountUsage.list(), [], "no usage until the first read");
  hive.accountUsage.record(snapshot(account.id));
  const usage = { accountId: account.id, snapshot: snapshot(account.id), lastAttemptAt: 1_000, lastError: null,
    limitResetAt: null, limitErrorAt: null };
  assert.deepEqual(hive.accountUsage.list(), [usage]);
  assert.deepEqual(hive.accountUsage.map(), new Map([[account.id, usage]]));
});

test("an error keeps the previous windows, capture time and plan, and records only the attempt and its error", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.accountUsage.record(snapshot(account.id));
  hive.accountUsage.record(failed(account.id, 5_000));
  const [afterError] = hive.accountUsage.list();
  assert.deepEqual(afterError!.snapshot, snapshot(account.id), "the last good snapshot is untouched");
  assert.equal(afterError!.lastAttemptAt, 5_000);
  assert.equal(afterError!.lastError, "Usage read failed");

  const good = snapshot(account.id, { capturedAt: 6_000, plan: "api-key", windows: [{ key: "codex.primary", label: "5 h", usedPercent: 75, resetsAt: null }] });
  hive.accountUsage.record(good);
  const [afterGood] = hive.accountUsage.list();
  assert.deepEqual(afterGood!.snapshot, good, "a good read replaces the windows, plan and capture time");
  assert.equal(afterGood!.lastAttemptAt, 6_000);
  assert.equal(afterGood!.lastError, null, "a good read clears the error");
});

test("an account whose first read failed has no snapshot yet, only the error", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.accountUsage.record(failed(account.id, 3_000, "Not logged in"));
  assert.deepEqual(hive.accountUsage.list(), [{ accountId: account.id, snapshot: null, lastAttemptAt: 3_000, lastError: "Not logged in",
    limitResetAt: null, limitErrorAt: null }]);
});

test("limitErrorAt is stored as given, and a read without one keeps the last", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.accountUsage.record({ ...snapshot(account.id), limitErrorAt: 7_000 });
  const [stored] = hive.accountUsage.list();
  assert.equal(stored!.limitErrorAt, 7_000);
  assert.equal(stored!.snapshot!.limitErrorAt, 7_000);

  hive.accountUsage.record(failed(account.id, 8_000));
  assert.equal(hive.accountUsage.map().get(account.id)!.limitErrorAt, 7_000, "a read without a limit error keeps the earlier one");
  hive.accountUsage.record({ ...failed(account.id, 9_000), limitErrorAt: 9_500 });
  assert.equal(hive.accountUsage.map().get(account.id)!.limitErrorAt, 9_500);
});

test("a snapshot that does not validate is refused with its field paths only, and changes nothing", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.accountUsage.record(snapshot(account.id));
  const before = hive.accountUsage.list();
  const window = { key: "codex.primary", label: "5 h", usedPercent: 40, resetsAt: null };
  assert.throws(() => hive.accountUsage.record({ ...snapshot(account.id), windows: [{ ...window, usedPercent: 101 }] }),
    refused(400, /^Invalid usage snapshot: windows\.0\.usedPercent/));
  assert.throws(() => hive.accountUsage.record({ ...snapshot(account.id), windows: [window, window] }), refused(400, /^Invalid usage snapshot: windows$/));
  // The message names the path only: an unknown key's name, which may hold a secret, is never echoed.
  assert.throws(() => hive.accountUsage.record({ ...snapshot(account.id), "sk-ant-FAKE": "x" }), refused(400, /^Invalid usage snapshot: body$/));
  assert.throws(() => hive.accountUsage.record(snapshot("missing")), refused(404, /Account not found/));
  assert.deepEqual(hive.accountUsage.list(), before);
});

test("each recorded read emits accounts once, after the outermost commit", t => {
  const { hive, human, events } = fixture(t);
  const account = hive.accounts.create(human, spec());
  const before = events.length;
  hive.storage.transaction(() => {
    hive.accountUsage.record(snapshot(account.id));
    assert.equal(events.length, before, "nothing is announced before the commit");
  });
  assert.equal(events.length, before + 1);
  hive.accountUsage.record(failed(account.id, 2_000));
  assert.equal(events.length, before + 2);
  assert.throws(() => hive.accountUsage.record(snapshot("missing")), refused(404));
  assert.equal(events.length, before + 2, "a refused read publishes nothing");
});

test("deleting an account deletes its usage", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.accountUsage.record(snapshot(account.id));
  hive.accounts.delete(human, account.id, 1);
  assert.deepEqual(hive.accountUsage.list(), []);
});
