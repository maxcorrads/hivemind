import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { insertRow } from "./test-fixtures.ts";
import { HiveError } from "../shared/types.ts";
import { ACCOUNT_LIMITS, type AccountPolicy, type AccountSpec } from "../shared/accounts.ts";

// Agent accounts (phase 1, #321): Human-only catalog with revision checks. In-process only: no server or socket is started.

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({
  driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "", ...patch,
});

const refused = (status: number, message?: RegExp) => (error: unknown) =>
  error instanceof HiveError && error.status === status && (message === undefined || message.test(error.message));

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-accounts-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.close(); rmSync(dir, { recursive: true, force: true }); });
  const events: string[] = [];
  hive.bus.on("accounts", () => events.push("accounts"));
  return { hive, human: hive.identity.getAgent("human"), events };
}

test("create appends to the driver's list, and the list is sorted by driver, then position", t => {
  const { hive, human } = fixture(t);
  const first = hive.accounts.create(human, spec());
  const second = hive.accounts.create(human, spec({ label: "Codex personal", homePath: "", shadowPath: "~/.codex_personal" }));
  const claude = hive.accounts.create(human, spec({ driver: "claude", label: "Claude work", homePath: "~/.claude-work" }));
  assert.equal(first.order, 0);
  assert.equal(second.order, 1);
  assert.equal(first.command, "codex");
  assert.equal(first.revision, 1);
  assert.equal(first.lastSelectedAt, null);
  assert.deepEqual(hive.accounts.get(first.id), first);
  const listed = hive.accounts.list();
  assert.deepEqual(listed.accounts.map(account => account.id), [claude.id, first.id, second.id]);
  assert.deepEqual(listed.policies, { codex: "sequential", claude: "sequential" });
});

test("an edit names the revision it started from; a stale one is refused with 409", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  const edited = hive.accounts.update(human, account.id, { expectedRevision: 1, label: "Codex team" });
  assert.equal(edited.revision, 2);
  assert.equal(edited.label, "Codex team");
  assert.throws(() => hive.accounts.update(human, account.id, { expectedRevision: 1, label: "Stale" }), refused(409, /reload/));
  assert.throws(() => hive.accounts.delete(human, account.id, 1), refused(409, /reload/));
  hive.accounts.delete(human, account.id, 2);
  assert.deepEqual(hive.accounts.list().accounts, []);
});

test("the driver cannot change, and a bad path is refused with its field and reason", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  assert.throws(() => hive.accounts.update(human, account.id, { expectedRevision: 1, driver: "claude" }), refused(400, /driver/));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Relative", homePath: "codex" })), refused(400, /homePath: a path starts with/));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Trailing", homePath: "~/.codex/" })), refused(400, /homePath: a path cannot end with/));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Same", homePath: "", shadowPath: "~/.codex" })), refused(400, /shadowPath: a shadow is its own directory/));
  assert.throws(() => hive.accounts.update(human, account.id, { expectedRevision: 1, shadowPath: "~/.codex-work" }), refused(400, /shadowPath/));
  assert.equal(hive.accounts.get(account.id).revision, 1, "refused edits change nothing");
});

test("reorder takes exactly the driver's ids, sets positions 0 to n-1 and bumps each moved revision", t => {
  const { hive, human, events } = fixture(t);
  const a = hive.accounts.create(human, spec({ label: "A", homePath: "~/.codex-a" }));
  const b = hive.accounts.create(human, spec({ label: "B", homePath: "~/.codex-b" }));
  const c = hive.accounts.create(human, spec({ driver: "claude", label: "C", homePath: "~/.claude-c" }));
  assert.throws(() => hive.accounts.reorder(human, "codex", [a.id]), refused(400));
  assert.throws(() => hive.accounts.reorder(human, "codex", [a.id, a.id]), refused(400));
  assert.throws(() => hive.accounts.reorder(human, "codex", [a.id, b.id, c.id]), refused(400));
  const reordered = hive.accounts.reorder(human, "codex", [b.id, a.id]);
  assert.deepEqual(reordered.accounts.filter(account => account.driver === "codex").map(account => [account.label, account.order, account.revision]),
    [["B", 0, 2], ["A", 1, 2]]);
  assert.equal(hive.accounts.get(c.id).revision, 1, "the other driver is untouched");
  assert.equal(events.length, 4, "three creates and one reorder; refused reorders publish nothing");
});

test("a driver without a policy row is sequential, and setPolicy changes only that driver", t => {
  const { hive, human, events } = fixture(t);
  assert.deepEqual(hive.accounts.list().policies, { codex: "sequential", claude: "sequential" });
  assert.deepEqual(hive.accounts.setPolicy(human, "codex", "balanced").policies, { codex: "balanced", claude: "sequential" });
  assert.deepEqual(hive.accounts.setPolicy(human, "codex", "sequential").policies, { codex: "sequential", claude: "sequential" });
  const bogus: string = "random";
  assert.throws(() => hive.accounts.setPolicy(human, "codex", bogus as AccountPolicy), refused(400));
  assert.equal(events.length, 2);
});

test("delete closes the gap in positions, and a new account goes to the end", t => {
  const { hive, human } = fixture(t);
  const a = hive.accounts.create(human, spec({ label: "A", homePath: "~/.codex-a" }));
  const b = hive.accounts.create(human, spec({ label: "B", homePath: "~/.codex-b" }));
  const c = hive.accounts.create(human, spec({ label: "C", homePath: "~/.codex-c" }));
  hive.accounts.delete(human, b.id, 1);
  assert.deepEqual(hive.accounts.list().accounts.map(account => [account.id, account.order]), [[a.id, 0], [c.id, 1]]);
  assert.equal(hive.accounts.get(c.id).revision, 2, "a moved account bumps its revision");
  assert.equal(hive.accounts.get(a.id).revision, 1);
  assert.equal(hive.accounts.create(human, spec({ label: "D", homePath: "~/.codex-d" })).order, 2);
});

test("delete refuses an account a worker template pins, and names the template", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  const project = hive.projects.createProject(human, { name: "Alpha", slug: "alpha" });
  // A raw row: the template spec gains accountId only in phase 2.
  insertRow(hive, "worker_templates", { id: crypto.randomUUID(), project_id: project.id, slug: "codex-senior", revision: 1,
    spec: JSON.stringify({ label: "Codex senior", accountId: account.id }), created_at: 1, updated_at: 1 });
  assert.throws(() => hive.accounts.delete(human, account.id, 1), refused(409, /^account_pinned: .*Codex senior/));
  assert.equal(hive.accounts.list().accounts.length, 1);
});

test("a driver holds at most 8 accounts; the ninth is refused with 429", t => {
  const { hive, human } = fixture(t);
  for (let i = 0; i < ACCOUNT_LIMITS.perDriver; i++) hive.accounts.create(human, spec({ label: `Codex ${i}`, homePath: `~/.codex-${i}` }));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Codex overflow", homePath: "~/.codex-overflow" })), refused(429));
  assert.equal(hive.accounts.list().accounts.length, ACCOUNT_LIMITS.perDriver);
  hive.accounts.create(human, spec({ driver: "claude", label: "Claude 0", homePath: "~/.claude-0" }));
});

test("label is unique per driver and shadowPath across the catalog, on create and on edit", t => {
  const { hive, human } = fixture(t);
  const work = hive.accounts.create(human, spec({ label: "Codex work", homePath: "~/.codex-work" }));
  const personal = hive.accounts.create(human, spec({ label: "Codex personal", homePath: "~/.codex-personal", shadowPath: "~/.codex_personal" }));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Codex work", homePath: "~/.codex-other" })), refused(409, /label/));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Codex shadow", homePath: "~/.codex-shadow", shadowPath: "~/.codex_personal" })), refused(409, /shadowPath/));
  assert.throws(() => hive.accounts.update(human, work.id, { expectedRevision: 1, label: "Codex personal" }), refused(409, /label/));
  hive.accounts.create(human, spec({ driver: "claude", label: "Codex work", homePath: "~/.claude-work" }));
  assert.equal(hive.accounts.list().accounts.length, 3, "the same label under the other driver is fine");
  assert.equal(hive.accounts.update(human, personal.id, { expectedRevision: 1, label: "Codex personal" }).revision, 2, "keeping its own label is not a duplicate");
});

test("one primary account per driver and homePath", t => {
  const { hive, human } = fixture(t);
  const primary = hive.accounts.create(human, spec({ label: "Codex default", homePath: "" }));
  assert.throws(() => hive.accounts.create(human, spec({ label: "Codex again", homePath: "" })), refused(409, /primary/));
  hive.accounts.create(human, spec({ label: "Codex work", homePath: "~/.codex-work" }));
  const shadow = hive.accounts.create(human, spec({ label: "Codex shadow", homePath: "", shadowPath: "~/.codex_shadow" }));
  assert.throws(() => hive.accounts.update(human, shadow.id, { expectedRevision: 1, shadowPath: "" }), refused(409, /primary/));
  assert.equal(primary.order, 0);
});

test("each committed change publishes one accounts event after commit; refused and internal changes publish none", t => {
  const { hive, human, events } = fixture(t);
  const account = hive.accounts.create(human, spec());
  assert.equal(events.length, 1);
  assert.throws(() => hive.accounts.create(human, spec({ label: "Codex work", homePath: "~/.codex-other" })), refused(409));
  assert.equal(events.length, 1);
  hive.accounts.markSelected(account.id, 1234);
  assert.equal(hive.accounts.get(account.id).lastSelectedAt, 1234);
  assert.equal(events.length, 1, "a launch's selection is not a change Human made");
  hive.accounts.update(human, account.id, { expectedRevision: 1, label: "Codex team" });
  assert.equal(events.length, 2);
});

test("only Human manages accounts", t => {
  const { hive, human } = fixture(t);
  const account = hive.accounts.create(human, spec());
  hive.projects.createProject(human, { name: "Alpha", slug: "alpha" });
  const brain = hive.identity.join({ role: "brain", project: "alpha" }).agent;
  const forbidden = refused(403, /Only Human/);
  assert.throws(() => hive.accounts.create(brain, spec({ label: "Brain", homePath: "~/.codex-brain" })), forbidden);
  assert.throws(() => hive.accounts.update(brain, account.id, { expectedRevision: 1, label: "Brain" }), forbidden);
  assert.throws(() => hive.accounts.delete(brain, account.id, 1), forbidden);
  assert.throws(() => hive.accounts.reorder(brain, "codex", [account.id]), forbidden);
  assert.throws(() => hive.accounts.setPolicy(brain, "codex", "balanced"), forbidden);
  assert.equal(hive.accounts.get(account.id).revision, 1);
});
