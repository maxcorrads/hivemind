import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { insertRow } from "./test-fixtures.ts";
import { ACCOUNT_LIMITS, type AccountSpec, type AccountUsage, type AgentAccount, type UsageSnapshot, type UsageWindow }
  from "../shared/accounts.ts";
import { accountExhausted } from "../shared/account-selection.ts";

// Agent accounts (phase 1, #321): Human-only catalog over HTTP. In-process only: no server or socket is started.

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({
  driver: "codex", label: "Codex work", homePath: "~/.codex-work", shadowPath: "", ...patch,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-accounts-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(url, { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  const events: string[] = [];
  hive.bus.on("accounts", () => events.push("accounts"));
  return { hive, call, events };
}

test("Human lists, adds, edits, reorders, sets the policy and removes accounts over HTTP", async t => {
  const { call, events } = fixture(t);
  const empty = await call("GET", "/api/ui/accounts");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { accounts: [], policies: { codex: "sequential", claude: "sequential" }, usage: [] });

  const work = await call("POST", "/api/ui/accounts", spec());
  assert.equal(work.status, 201);
  assert.equal(work.json.order, 0);
  assert.equal(work.json.command, "codex");
  const personal = await call("POST", "/api/ui/accounts", spec({ label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" }));
  assert.equal(personal.status, 201);
  const claude = await call("POST", "/api/ui/accounts", spec({ driver: "claude", label: "Claude work", homePath: "~/.claude-work" }));
  assert.equal(claude.json.command, "claude");
  // Sorted by driver, then position: "claude" sorts before "codex".
  assert.deepEqual((await call("GET", "/api/ui/accounts")).json.accounts.map((account: AgentAccount) => account.label),
    ["Claude work", "Codex work", "Codex personal"]);

  const edited = await call("PUT", `/api/ui/accounts/${work.json.id}`, { expectedRevision: 1, label: "Codex main" });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.label, "Codex main");
  assert.equal(edited.json.revision, 2);

  const reordered = await call("PUT", "/api/ui/accounts/order", { driver: "codex", ids: [personal.json.id, work.json.id] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.json.accounts.map((account: AgentAccount) => account.label), ["Claude work", "Codex personal", "Codex main"]);

  const policy = await call("PUT", "/api/ui/accounts/policy", { driver: "claude", policy: "balanced" });
  assert.equal(policy.status, 200);
  assert.deepEqual(policy.json.policies, { codex: "sequential", claude: "balanced" });

  const removed = await call("DELETE", `/api/ui/accounts/${claude.json.id}?revision=1`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true });
  const final = await call("GET", "/api/ui/accounts");
  assert.deepEqual(final.json.accounts.map((account: AgentAccount) => account.label), ["Codex personal", "Codex main"]);
  assert.deepEqual(final.json.policies, { codex: "sequential", claude: "balanced" });
  assert.equal(events.length, 7, "one event per committed change: three adds, an edit, a reorder, a policy and a removal");
});

test("409, 400 and the pinned refusal come through with the field or code, never the value", async t => {
  const { hive, call, events } = fixture(t);
  const url = "/api/ui/accounts";
  const work = await call("POST", url, spec());
  assert.equal(work.status, 201);

  const dupLabel = await call("POST", url, spec({ homePath: "~/.codex-other" }));
  assert.equal(dupLabel.status, 409);
  assert.match(dupLabel.json.error, /label/);
  const secondPrimary = await call("POST", url, spec({ label: "Codex again" }));
  assert.equal(secondPrimary.status, 409);
  assert.match(secondPrimary.json.error, /primary/);

  const shadow = await call("POST", url, spec({ label: "Shadow one", homePath: "", shadowPath: "~/.codex-shadow" }));
  assert.equal(shadow.status, 201);
  const dupShadow = await call("POST", url, spec({ label: "Shadow two", homePath: "", shadowPath: "~/.codex-shadow" }));
  assert.equal(dupShadow.status, 409);
  assert.match(dupShadow.json.error, /shadowPath/);
  const sameTree = await call("POST", url, spec({ label: "Same tree", shadowPath: "~/.codex-work" }));
  assert.equal(sameTree.status, 400);
  assert.match(sameTree.json.error, /shadowPath: a shadow is its own directory/);
  const relative = await call("POST", url, spec({ label: "Relative", homePath: "relative-secret-path" }));
  assert.equal(relative.status, 400);
  assert.match(relative.json.error, /homePath: a path starts with/);
  assert.doesNotMatch(relative.json.error, /relative-secret-path/);
  const leaked = await call("POST", url, { ...spec({ label: "Extra" }), token: "never-echo-this-token" });
  assert.equal(leaked.status, 400);
  assert.doesNotMatch(leaked.json.error, /never-echo-this-token/);

  const edited = await call("PUT", `/api/ui/accounts/${work.json.id}`, { expectedRevision: 1, label: "Codex main" });
  assert.equal(edited.status, 200);
  const stale = await call("PUT", `/api/ui/accounts/${work.json.id}`, { expectedRevision: 1, label: "Codex stale" });
  assert.equal(stale.status, 409);
  const driverChange = await call("PUT", `/api/ui/accounts/${work.json.id}`, { expectedRevision: 2, driver: "claude" });
  assert.equal(driverChange.status, 400);
  assert.match(driverChange.json.error, /driver cannot change/);

  const partial = await call("PUT", "/api/ui/accounts/order", { driver: "codex", ids: [work.json.id] });
  assert.equal(partial.status, 400);
  assert.match(partial.json.error, /Reorder must name every codex account/);
  const badPolicy = await call("PUT", "/api/ui/accounts/policy", { driver: "codex", policy: "random" });
  assert.equal(badPolicy.status, 400);
  assert.match(badPolicy.json.error, /policy/);

  assert.equal((await call("DELETE", `/api/ui/accounts/${work.json.id}`)).status, 400, "a revision is required");
  assert.equal((await call("DELETE", `/api/ui/accounts/${work.json.id}?revision=1`)).status, 409);
  const project = hive.projects.createProject(hive.identity.getAgent("human"), { name: "Alpha", slug: "alpha" });
  // A raw row: the template spec gains accountId only in phase 2.
  insertRow(hive, "worker_templates", { id: crypto.randomUUID(), project_id: project.id, slug: "codex-senior", revision: 1,
    spec: JSON.stringify({ label: "Codex senior", accountId: work.json.id }), created_at: 1, updated_at: 1 });
  const pinned = await call("DELETE", `/api/ui/accounts/${work.json.id}?revision=2`);
  assert.equal(pinned.status, 409);
  assert.match(pinned.json.error, /^account_pinned: .*Codex senior/);

  assert.equal(events.length, 3, "only the three committed changes publish an event");
});

test("the ninth account in one driver is refused with 429", async t => {
  const { call } = fixture(t);
  for (let i = 0; i < ACCOUNT_LIMITS.perDriver; i++) {
    assert.equal((await call("POST", "/api/ui/accounts", spec({ label: `Codex ${i}`, homePath: "", shadowPath: `~/.codex-${i}` }))).status, 201);
  }
  const overflow = await call("POST", "/api/ui/accounts", spec({ label: "Ninth", homePath: "", shadowPath: "~/.codex-ninth" }));
  assert.equal(overflow.status, 429);
  assert.match(overflow.json.error, /at most 8/);
});

test("an agent or bot Authorization header is refused on the account routes, as on the other Human routes", async t => {
  const { hive, call, events } = fixture(t);
  const bearer = { authorization: "Bearer not-a-human-token" };
  const project = hive.projects.createProject(hive.identity.getAgent("human"), { name: "Alpha", slug: "alpha" });
  const control = await call("GET", `/api/ui/projects/${project.id}/worker-templates`, undefined, bearer);
  const list = await call("GET", "/api/ui/accounts", undefined, bearer);
  assert.equal(list.status, 403);
  assert.equal(list.status, control.status);
  assert.equal((await call("POST", "/api/ui/accounts", spec(), bearer)).status, 403);
  assert.equal((await call("PUT", "/api/ui/accounts/order", { driver: "codex", ids: [] }, bearer)).status, 403);
  assert.equal((await call("DELETE", "/api/ui/accounts/missing?revision=1", undefined, bearer)).status, 403);
  assert.deepEqual(events, [], "a refused request changes nothing");
  assert.deepEqual(hive.accounts.list().accounts, []);
});

const limited = (accountId: string, limitResetAt: number): AccountUsage => ({ accountId, snapshot: null, lastAttemptAt: null,
  lastError: null, limitResetAt, limitErrorAt: null });

test("resolve answers the account a launch uses: policy, pin, exhaustion and record, and publishes nothing", async t => {
  const { hive, call, events } = fixture(t);
  const resolve = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call("POST", "/api/ui/accounts/resolve", body, headers);
  assert.deepEqual((await resolve({ driver: "codex" })).json, { selection: { kind: "none" } });

  const work = await call("POST", "/api/ui/accounts", spec());
  const personal = await call("POST", "/api/ui/accounts", spec({ label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" }));
  const sequential = await resolve({ driver: "codex" });
  assert.equal(sequential.status, 200);
  assert.deepEqual(sequential.json, { selection: { kind: "account", account: work.json, reason: "sequential", stale: true, warning: null } });
  assert.equal(hive.accounts.get(work.json.id).lastSelectedAt, null, "a probe without record changes nothing");

  await resolve({ driver: "codex", record: true });
  assert.notEqual(hive.accounts.get(work.json.id).lastSelectedAt, null, "a recorded pick is what balanced round-robin reads");
  assert.equal(hive.accounts.get(personal.json.id).lastSelectedAt, null);

  const pinned = await resolve({ driver: "codex", accountId: personal.json.id });
  assert.deepEqual([pinned.json.selection.kind, pinned.json.selection.reason, pinned.json.selection.account.id],
    ["account", "pin", personal.json.id]);
  assert.deepEqual((await resolve({ driver: "codex", accountId: "missing" })).json, { selection: { kind: "unknown-pin", pin: "missing" } });

  // No snapshot carries `limitResetAt`, so here limit resets stand in for stored usage through the store's usage provider.
  const soon = Date.now() + 3_600_000, later = soon + 3_600_000;
  const usage = new Map([[work.json.id, limited(work.json.id, soon)], [personal.json.id, limited(personal.json.id, later)]]);
  (hive.accounts as unknown as { usage: () => ReadonlyMap<string, AccountUsage> }).usage = () => usage;
  assert.deepEqual((await resolve({ driver: "codex" })).json, { selection: { kind: "exhausted", earliestReset: soon } });
  const usedUp = await resolve({ driver: "codex", accountId: personal.json.id });
  assert.equal(usedUp.json.selection.kind, "account");
  assert.equal(usedUp.json.selection.warning, `Codex personal is used up until ${new Date(later).toISOString()}`);
  usage.set(work.json.id, limited(work.json.id, Date.now() - 1));
  assert.equal((await resolve({ driver: "codex" })).json.selection.account.id, work.json.id, "a past reset is not exhausted");

  assert.equal((await resolve({ driver: "random" })).status, 400);
  assert.equal((await resolve({ driver: "codex" }, { authorization: "Bearer not-a-human-token" })).status, 403);
  assert.equal(events.length, 2, "only the two creates publish an event");
});

const HOUR = 3_600_000;

const usageWindow = (usedPercent: number, resetsAt: number | null): UsageWindow =>
  ({ key: "codex.primary", label: "5 h", usedPercent, resetsAt });

const stored = (accountId: string, capturedAt: number, windows: UsageWindow[]): UsageSnapshot => ({ accountId, capturedAt, source: "codex",
  plan: "subscription", windows, error: null, limitErrorAt: null });

test("the policy and the exhausted set agree on stored snapshots: used up is skipped, all used up refused, none yet usable", async t => {
  const { hive, call } = fixture(t);
  const resolve = async (body: Record<string, unknown> = {}) =>
    (await call("POST", "/api/ui/accounts/resolve", { driver: "codex", ...body })).json.selection;
  // The exhausted set of the same stored usage, by the rule the policy uses (shared/account-selection.ts).
  const exhausted = () => hive.accounts.list().accounts
    .filter(account => accountExhausted(hive.accountUsage.map().get(account.id), Date.now()).exhausted).map(account => account.label);
  const work = (await call("POST", "/api/ui/accounts", spec())).json as AgentAccount;
  const personal = (await call("POST", "/api/ui/accounts",
    spec({ label: "Codex personal", homePath: "", shadowPath: "~/.codex-personal" }))).json as AgentAccount;
  const now = Date.now();

  // No snapshot yet: nothing is used up, sequential takes the first account, and the pick is stale ("usage unknown").
  assert.deepEqual(exhausted(), []);
  assert.deepEqual(await resolve(), { kind: "account", account: work, reason: "sequential", stale: true, warning: null });

  // A window at 100% with a reset ahead uses the account up: the policy takes the next one, and a pin keeps the warning.
  hive.accountUsage.record(stored(work.id, now, [usageWindow(100, now + HOUR)]));
  assert.deepEqual(exhausted(), ["Codex work"]);
  assert.equal((await resolve()).account.id, personal.id);
  const pinned = await resolve({ accountId: work.id });
  assert.deepEqual([pinned.reason, pinned.stale, pinned.warning],
    ["pin", false, `Codex work is used up until ${new Date(now + HOUR).toISOString()}`]);

  // Every account used up: the launch is refused and the answer names the earliest reset.
  hive.accountUsage.record(stored(personal.id, now, [usageWindow(100, now + 2 * HOUR)]));
  assert.deepEqual(exhausted(), ["Codex work", "Codex personal"]);
  assert.deepEqual(await resolve(), { kind: "exhausted", earliestReset: now + HOUR });

  // A failed read keeps the last good windows, so neither the set nor the answer changes; only the error is recorded.
  hive.accountUsage.record({ ...stored(work.id, now + 1_000, []), error: "Usage read failed" });
  assert.equal(hive.accountUsage.map().get(work.id)?.lastError, "Usage read failed");
  assert.deepEqual(exhausted(), ["Codex work", "Codex personal"]);
  assert.deepEqual(await resolve(), { kind: "exhausted", earliestReset: now + HOUR });

  // A window whose reset has passed no longer uses the account up: sequential returns to it, and it is fresh again.
  hive.accountUsage.record(stored(work.id, Date.now(), [usageWindow(100, now - 1)]));
  assert.deepEqual(exhausted(), ["Codex personal"]);
  const back = await resolve();
  assert.deepEqual([back.account.id, back.stale, back.warning], [work.id, false, null]);
});
