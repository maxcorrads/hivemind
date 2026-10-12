import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import type { AccountSpec } from "../src/shared/accounts.ts";
import { AccountsSheet } from "./AccountsSheet.tsx";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({ driver: "codex", label: "Codex work", homePath: "", shadowPath: "", ...patch });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "accounts-sheet-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  // Every change the sheet sends, as method, path and body; reads are left out.
  const changes: unknown[][] = [];
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    const method = init?.method ?? "GET";
    if (method === "GET") reads++;
    else changes.push([method, url, ...(init?.body ? [JSON.parse(String(init.body))] : [])]);
    return app.request(url, init);
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const render = async (tick = 0) => {
    await act(async () => root.render(<AccountsSheet tick={tick} onClose={() => undefined} />));
    await settle();
  };
  // Inside an open confirmation, only its buttons: the row behind it has a "Remove" button too.
  const button = (label: string, scope: ParentNode) => Array.from((document.querySelector('[role="alertdialog"]') ?? scope).querySelectorAll("button"))
    .find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  const click = async (label: string, scope: ParentNode = host) => {
    const b = button(label, scope);
    assert.ok(b, label);
    await act(async () => b.click());
    await settle();
  };
  const field = (label: string) => {
    const found = Array.from(host.querySelectorAll("label")).find(l => l.firstChild?.textContent?.trim() === label);
    const control = found?.querySelector("input, textarea");
    assert.ok(control, label);
    return control as unknown as HTMLInputElement;
  };
  const type = async (label: string, value: string) => {
    const control = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  const submit = async () => {
    const form = host.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    await settle();
  };
  const section = (name: string) => host.querySelector<HTMLElement>(`[aria-label="${name} accounts"]`)!;
  const labels = (driver: AccountSpec["driver"]) => hive.accounts.list().accounts.filter(item => item.driver === driver).map(item => item.label);
  return { hive, human, host, render, settle, click, type, submit, section, labels, changes, reads: () => reads };
}

test("Human lists, adds, edits, reorders, changes the policy and removes accounts through the API", async t => {
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec());
  const home = f.hive.accounts.create(f.human, spec({ label: "Codex home", homePath: "~/.codex-home" }));
  f.hive.accounts.update(f.human, home.id, { expectedRevision: 1, label: "Codex house" });
  f.hive.accounts.update(f.human, home.id, { expectedRevision: 2, label: "Codex home" });
  await f.render();
  assert.match(f.section("Codex").textContent!, /Codex work[\s\S]*Codex home/);
  assert.match(f.section("Claude").textContent!, /0 of 8/);

  await f.click("Add account", f.section("Codex"));
  await f.type("Label", "Codex personal");
  await f.type("Shadow path", "~/.codex_personal");
  await f.submit();
  assert.deepEqual(f.changes.splice(0), [["POST", "/api/ui/accounts", { driver: "codex", label: "Codex personal", homePath: "", shadowPath: "~/.codex_personal" }]]);
  assert.deepEqual(f.labels("codex"), ["Codex work", "Codex home", "Codex personal"]);
  assert.match(f.section("Codex").textContent!, /Codex personal/);
  const personal = f.hive.accounts.list().accounts.find(item => item.label === "Codex personal")!;

  await f.click("Edit Codex home");
  await f.type("Label", "Codex team");
  await f.submit();
  assert.deepEqual(f.changes.splice(0), [["PUT", `/api/ui/accounts/${home.id}`, { expectedRevision: 3, label: "Codex team", homePath: "~/.codex-home", shadowPath: "" }]]);
  assert.equal(f.hive.accounts.get(home.id).revision, 4);
  assert.match(f.section("Codex").textContent!, /Codex team/);

  await f.click("Move Codex work down");
  assert.deepEqual(f.changes.splice(0), [["PUT", "/api/ui/accounts/order", { driver: "codex", ids: [home.id, work.id, personal.id] }]]);
  assert.deepEqual(f.labels("codex"), ["Codex team", "Codex work", "Codex personal"]);

  const balanced = f.section("Codex").querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
  await act(async () => balanced.click());
  await f.settle();
  assert.deepEqual(f.changes.splice(0), [["PUT", "/api/ui/accounts/policy", { driver: "codex", policy: "balanced" }]]);
  assert.deepEqual(f.hive.accounts.list().policies, { codex: "balanced", claude: "sequential" });
  assert.equal(balanced.checked, true);

  await f.click("Remove Codex work");
  await f.click("Cancel");
  assert.deepEqual(f.changes, []);
  await f.click("Remove Codex work");
  await f.click("Remove");
  // The reorder moved this account and bumped its revision from 1 to 2.
  assert.deepEqual(f.changes.splice(0), [["DELETE", `/api/ui/accounts/${work.id}?revision=2`]]);
  assert.deepEqual(f.labels("codex"), ["Codex team", "Codex personal"]);
  assert.doesNotMatch(f.section("Codex").textContent!, /Codex work/);
});

test("a refused change shows the server's reason as text and keeps the form open", async t => {
  const f = await fixture(t);
  f.hive.accounts.create(f.human, spec());
  await f.render();
  await f.click("Add account", f.section("Codex"));
  await f.type("Label", "Codex work");
  await f.submit();
  assert.equal(f.host.querySelector('[role="alert"]')!.textContent, "Another codex account already uses this label");
  assert.deepEqual(f.labels("codex"), ["Codex work"]);
  assert.equal(f.host.querySelectorAll(".accounts-list li").length, 1);
  assert.ok(f.host.querySelector("form"));
});

test("an edit keeps the revision it started from, so another session's change is refused", async t => {
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec());
  await f.render(0);
  await f.click("Edit Codex work");
  f.hive.accounts.update(f.human, work.id, { expectedRevision: 1, homePath: "~/.codex-elsewhere" });
  await f.render(1);
  await f.type("Label", "Codex main");
  await f.submit();
  assert.equal(f.host.querySelector('[role="alert"]')!.textContent, "The account changed; reload it before saving");
  assert.equal(f.hive.accounts.get(work.id).label, "Codex work");
});

test("the login command follows the paths typed, a bad path is refused inline, and Copy takes the command", async t => {
  const f = await fixture(t);
  const copied: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  await f.render();
  await f.click("Add account", f.section("Codex"));
  // The command needs no label.
  assert.equal(f.host.querySelector(".launch-pre")!.textContent, "codex login");
  await f.type("Shadow path", "~/.codex_personal");
  assert.equal(f.host.querySelector(".launch-pre")!.textContent,
    "mkdir -p ~/.codex_personal && CODEX_HOME=~/.codex_personal CODEX_SQLITE_HOME=~/.codex codex -c cli_auth_credentials_store=file login");
  await f.click("Cancel");

  await f.click("Add account", f.section("Claude"));
  await f.type("Label", "Claude work");
  await f.type("Home path", "work");
  assert.equal(f.host.querySelector(".launch-pre"), null);
  assert.match(f.host.textContent!, /Home path: a path starts with \/ or ~\//);
  assert.equal(f.host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled, true);

  await f.type("Home path", "~/.claude-work");
  assert.equal(f.host.querySelector(".launch-pre")!.textContent, "mkdir -p ~/.claude-work && CLAUDE_CONFIG_DIR=~/.claude-work claude auth login");
  assert.match(f.host.textContent!, /Log in once in a terminal; HiveMind never stores tokens\./);
  await f.click("Copy");
  assert.deepEqual(copied, ["mkdir -p ~/.claude-work && CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"]);

  await f.type("Home path", "");
  assert.equal(f.host.querySelector(".launch-pre")!.textContent, "claude auth login");
  assert.deepEqual(f.changes, []);
});

test("an accounts event refreshes the open list", async t => {
  const f = await fixture(t);
  f.hive.accounts.create(f.human, spec());
  await f.render(0);
  assert.equal(f.reads(), 1);
  f.hive.accounts.create(f.human, spec({ label: "Codex home", homePath: "~/.codex-home" }));
  await f.render(1);
  assert.equal(f.reads(), 2);
  assert.match(f.section("Codex").textContent!, /Codex work[\s\S]*Codex home/);
});
