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
import { TERMINAL_EVENT, type NativeMessage } from "./native-bridge.ts";
import { resetTerminalHub } from "./use-terminal.ts";

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

test("in a browser the sheet says Prepare needs the Mac app and offers no Prepare", async t => {
  const f = await fixture(t);
  f.hive.accounts.create(f.human, spec({ shadowPath: "~/.codex_work" }));
  await f.render();
  assert.match(f.host.textContent!, /Prepare needs the Mac app/);
  assert.equal(Array.from(f.host.querySelectorAll("button")).find(b => b.textContent?.includes("Prepare")), undefined);
});

test("in the app Prepare asks Hivemind Server for the row's account, shows its status, and the login command once it worked", async t => {
  const posted: NativeMessage[] = [];
  const bridged = window as unknown as { webkit?: unknown };
  bridged.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => { posted.push(structuredClone(message)); } } } };
  t.after(() => { resetTerminalHub(); delete bridged.webkit; });
  const copied: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const f = await fixture(t);
  const work = f.hive.accounts.create(f.human, spec({ shadowPath: "~/.codex_work" }));
  const primary = f.hive.accounts.create(f.human, spec({ label: "Codex", homePath: "~/.codex-main" }));
  await f.render();
  assert.doesNotMatch(f.host.textContent!, /Prepare needs the Mac app/);
  const row = (label: string) => Array.from(f.host.querySelectorAll<HTMLElement>(".accounts-list li"))
    .find(li => li.querySelector("strong")?.textContent === label)!;
  const status = (label: string) => row(label).querySelector('[role="status"]')?.textContent ?? null;
  const prepares = () => posted.filter((m): m is Extract<NativeMessage, { type: "account-prepare" }> => m.type === "account-prepare");
  const answer = (detail: object) => act(async () => {
    window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const login = "mkdir -p ~/.codex_work && CODEX_HOME=~/.codex_work CODEX_SQLITE_HOME=~/.codex codex -c cli_auth_credentials_store=file login";

  await f.click("Prepare Codex work");
  const [first] = prepares();
  assert.deepEqual(first, { type: "account-prepare", id: first!.id,
    account: { id: work.id, driver: "codex", label: "Codex work", homePath: "", shadowPath: "~/.codex_work" } });
  assert.equal(status("Codex work"), "Preparing…");
  assert.equal(row("Codex work").querySelector<HTMLButtonElement>('[aria-label="Prepare Codex work"]')!.disabled, true);
  assert.equal(row("Codex work").querySelector(".launch-pre"), null, "no command before the shadow is ready");
  await answer({ type: "account-prepared", id: first!.id, ok: true, loggedIn: false });
  assert.equal(status("Codex work"), "Not logged in");
  assert.equal(prepares().length, 1, "with no host, Prepare is this Mac's only, as before hosts");
  assert.equal(row("Codex work").querySelector(".account-hosts"), null);
  assert.equal(row("Codex work").querySelector(".launch-pre")!.textContent, login);
  await f.click("Copy", row("Codex work"));
  assert.deepEqual(copied, [login]);

  await f.click("Prepare Codex work");
  await answer({ type: "account-prepared", id: prepares()[1]!.id, ok: true, loggedIn: true });
  assert.equal(status("Codex work"), "Ready");

  // What went wrong shows as the row's status, with its fix, and no command; a refused request too.
  const error = "`/Users/me/.codex-main` must be an existing folder, not a symlink.";
  await f.click("Prepare Codex");
  assert.deepEqual(prepares()[2]!.account, { id: primary.id, driver: "codex", label: "Codex", homePath: "~/.codex-main", shadowPath: "" });
  await answer({ type: "account-prepared", id: prepares()[2]!.id, ok: false, loggedIn: false, error });
  assert.equal(status("Codex"), error);
  assert.equal(row("Codex").querySelector(".launch-pre"), null);
  assert.equal(status("Codex work"), "Ready", "each row keeps its own status");
  await f.click("Prepare Codex");
  await answer({ type: "terminal-error", id: prepares()[3]!.id, code: "unknown-type", message: "unknown message type \"account.prepare\"", stream: null });
  assert.equal(status("Codex"), "unknown message type \"account.prepare\"");

  // A status is about the paths it ran with: a new shadow path hides it.
  await f.click("Edit Codex work");
  await f.type("Shadow path", "~/.codex_other");
  await f.submit();
  assert.equal(status("Codex work"), null);
  assert.deepEqual(f.changes.map(change => change[0]), ["PUT"], "Prepare never goes to the server");
});

test("with hosts, Prepare runs on this Mac and each online host, and lists the homes there that still need a login", async t => {
  // docs/remote-hosts.md#accounts. A host's line names it; one that needs its login shows the command to run there.
  const posted: NativeMessage[] = [];
  const bridged = window as unknown as { webkit?: unknown };
  bridged.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => { posted.push(structuredClone(message)); } } } };
  t.after(() => { resetTerminalHub(); delete bridged.webkit; });
  const f = await fixture(t);
  const buildMac = { id: "20000000-0000-4000-8000-000000000001", label: "Build Mac", online: true };
  const sleepy = { id: "20000000-0000-4000-8000-000000000002", label: "Sleepy Mac", online: false };
  f.hive.hosts.replace({ hosts: [buildMac, sleepy] });
  f.hive.accounts.create(f.human, spec({ homePath: "~/.codex2" }));
  await f.render();
  const row = () => Array.from(f.host.querySelectorAll<HTMLElement>(".accounts-list li")).find(li => li.querySelector("strong")?.textContent === "Codex work")!;
  const hostLines = () => Array.from(row().querySelectorAll(".account-hosts li")).map(li => li.querySelector("p")?.textContent);
  const prepareButton = () => row().querySelector<HTMLButtonElement>('[aria-label="Prepare Codex work"]')!;
  const prepares = () => posted.filter((m): m is Extract<NativeMessage, { type: "account-prepare" }> => m.type === "account-prepare");
  const answer = (detail: object) => act(async () => {
    window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  await f.click("Prepare Codex work");
  const [here, there] = prepares();
  assert.equal(prepares().length, 2, "the offline host is not asked");
  assert.equal("host" in here!, false, "this Mac's Prepare is as before hosts");
  assert.equal(there!.host, buildMac.id);
  assert.deepEqual(there!.account, here!.account);
  assert.deepEqual(hostLines(), ["Build Mac: Preparing…", "Sleepy Mac: offline. Prepare again once it is online."]);
  assert.equal(prepareButton().disabled, true);
  await answer({ type: "account-prepared", id: here!.id, ok: true, loggedIn: true });
  assert.equal(prepareButton().disabled, true, "until every host answered");
  await answer({ type: "account-prepared", id: there!.id, ok: true, loggedIn: false });
  assert.equal(prepareButton().disabled, false);
  assert.deepEqual(hostLines(), ["Build Mac: not logged in. Run this in a terminal on Build Mac:", "Sleepy Mac: offline. Prepare again once it is online."]);
  assert.equal(row().querySelector(".account-hosts .launch-pre")!.textContent, "CODEX_HOME=~/.codex2 codex login");

  await f.click("Prepare Codex work");
  const mismatch = "`~/.codex2` on Build Mac is logged in to another account than Codex work on this Mac.";
  await answer({ type: "account-prepared", id: prepares()[3]!.id, ok: false, loggedIn: true, error: mismatch });
  assert.equal(hostLines()[0], `Build Mac: ${mismatch}`);
  assert.equal(row().querySelector(".account-hosts .launch-pre"), null);
  await answer({ type: "account-prepared", id: prepares()[2]!.id, ok: true, loggedIn: true });
  await f.click("Prepare Codex work");
  await answer({ type: "account-prepared", id: prepares()[5]!.id, ok: true, loggedIn: true });
  assert.equal(hostLines()[0], "Build Mac: Ready");
});
