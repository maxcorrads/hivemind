import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { insertRow } from "./test-fixtures.ts";
import { ACCOUNT_LIMITS, type AccountSpec, type AgentAccount } from "../shared/accounts.ts";

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
  assert.deepEqual(empty.json, { accounts: [], policies: { codex: "sequential", claude: "sequential" } });

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
