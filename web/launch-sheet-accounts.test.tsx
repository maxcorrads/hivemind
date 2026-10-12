import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import type { Agent } from "../src/shared/types.ts";
import type { AccountSpec } from "../src/shared/accounts.ts";
import type { AccountSelection } from "../src/shared/account-selection.ts";
import type { NativeMessage } from "./native-bridge.ts";

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT } = await import("./native-bridge.ts");
const { resetTerminalHub } = await import("./use-terminal.ts");
const { LaunchSheet } = await import("./LaunchSheet.tsx");
after(() => window.happyDOM.close());

const spec = (patch: Partial<AccountSpec> = {}): AccountSpec => ({ driver: "codex", label: "Work", homePath: "", shadowPath: "", ...patch });
/** A second Codex account: only one primary may use the default home. */
const personal = spec({ label: "Personal", homePath: "~/.codex-personal" });

type Options = {
  accounts?: AccountSpec[];
  /** What the resolve endpoint answers instead of the server's own choice (the server has no usage yet). */
  resolution?: AccountSelection;
  /** Stored launch settings, as the sheet keeps them in this browser. */
  saved?: Record<string, unknown>;
  /** Employees beyond the project's own, built from Human's record. */
  extraAgents?: (human: Agent) => Agent[];
};

async function fixture(t: TestContext, native: boolean, options: Options = {}) {
  window.localStorage.clear();
  if (options.saved) window.localStorage.setItem("hivemind-launch", JSON.stringify(options.saved));
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-sheet-accounts-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  const project = { ...hive.projects.listProjects()[0]!, worktree: "/Users/me/acme" };
  const accounts = (options.accounts ?? [spec()]).map(account => hive.accounts.create(human, account));
  // Every resolve request the sheet sends, as its body.
  const resolves: unknown[] = [];
  let copied = "";
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    if (url === "/api/ui/accounts/resolve") {
      resolves.push(JSON.parse(String(init?.body)));
      if (options.resolution) return Response.json({ selection: options.resolution });
    }
    return app.request(url, init);
  });
  const posted: NativeMessage[] = [];
  const win = window as unknown as { webkit?: unknown };
  if (native) win.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => { posted.push(structuredClone(message)); } } } };
  else delete win.webkit;
  resetTerminalHub();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount()); host.remove(); resetTerminalHub(); delete win.webkit;
    await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  const agents = [...hive.identity.listAgents(), ...(options.extraAgents?.(human) ?? [])];
  await act(async () => root.render(<LaunchSheet projects={[project]} agents={agents} defaultProject={project.slug} onClose={() => undefined} />));
  await settle();
  if (native) {
    await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available", broker: "connected", platform: "macos" } })); });
    await settle();
  }
  const labelled = (label: string) => Array.from(host.querySelectorAll("label")).find(item => item.firstChild?.textContent?.trim() === label);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
  const setInput = async (label: string, value: string) => {
    const control = labelled(label)?.querySelector("input, textarea");
    assert.ok(control, label);
    await act(async () => {
      const prototype = control instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await settle();
  };
  const choose = async (label: string, value: string) => {
    const select = labelled(label)?.querySelector("select");
    assert.ok(select, label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    await settle();
  };
  const click = async (label: string) => {
    const target = button(label);
    assert.ok(target, label);
    await act(async () => target.click());
    await settle();
  };
  /** The one terminal-launch message the page posted, if any. */
  const launched = () => posted.find(message => message.type === "terminal-launch");
  /** The app's answer to a launch: one name per launch, and which of them it created. */
  const answer = async (id: string, names: string[], created: string[]) => {
    await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-launched", id, names,
      created, errors: [] } })); });
    await settle();
  };
  return { hive, host, accounts, labelled, button, setInput, choose, click, launched, answer, settle, resolves: () => resolves,
    copied: () => copied, posted };
}

test("in a browser the sheet says accounts apply to the apps and copies the command as before", async t => {
  const f = await fixture(t, false, { accounts: [spec(), personal] });
  assert.match(f.host.textContent!, /Accounts apply to launches from the apps\./);
  assert.equal(f.labelled("Account"), undefined);
  await f.click("Copy command");
  assert.match(f.copied(), /codex/);
  assert.deepEqual(f.resolves(), []);
});

test("the Account select lists the driver's accounts in order, and Launch starts under the chosen one", async t => {
  const f = await fixture(t, true, { accounts: [spec(), personal] });
  const select = f.labelled("Account")?.querySelector("select");
  assert.deepEqual(Array.from(select!.options).map(option => option.textContent), ["Auto (Sequential)", "Work", "Personal"]);
  await f.choose("Account", f.accounts[1]!.id);
  await f.click("Start in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  assert.deepEqual(launch.launches[0]!.account, { id: f.accounts[1]!.id, driver: "codex", label: "Personal", homePath: "~/.codex-personal", shadowPath: "" });
  assert.deepEqual(f.resolves(), [{ driver: "codex", accountId: f.accounts[1]!.id, record: true }]);
  assert.match(f.host.textContent!, /Account: Personal · usage unknown/, "no usage yet, so the account reads as unknown");
  assert.equal(JSON.parse(window.localStorage.getItem("hivemind-launch")!).accountPins.codex, f.accounts[1]!.id);
  await f.answer(launch.id!, ["hm-acme-codex-1"], ["hm-acme-codex-1"]);
  assert.match(f.host.textContent!, /Started/);
});

test("an exhausted account launches nothing and says when the first one resets", async t => {
  const f = await fixture(t, true, {
    accounts: [spec(), personal],
    resolution: { kind: "exhausted", earliestReset: Date.now() + 2 * 3_600_000 + 60_000 },
  });
  await f.click("Start in background");
  assert.equal(f.launched(), undefined);
  assert.match(f.host.textContent!, /Every Codex account is used up\. The first resets at .+ \(in 2h\)\./);
});

test("a saved pin on a removed account is shown as removed and refuses the launch", async t => {
  const f = await fixture(t, true, { saved: { accountPins: { codex: "gone" } } });
  const options = Array.from(f.labelled("Account")!.querySelectorAll("option")).map(option => option.textContent);
  assert.ok(options.includes("Removed account"));
  await f.click("Start in background");
  assert.deepEqual(f.resolves(), [{ driver: "codex", accountId: "gone", record: true }]);
  assert.equal(f.launched(), undefined);
  assert.match(f.host.textContent!, /That account was removed; pick another\./);
});

test("a variable the account controls disables Launch and names the account", async t => {
  const f = await fixture(t, true);
  await f.setInput("Environment variables", "CODEX_HOME=/tmp/elsewhere");
  assert.match(f.host.textContent!, /CODEX_HOME is managed by the account Work; remove it\./);
  assert.equal(f.button("Start in background")!.disabled, true);
  assert.equal(f.button("Copy command")!.disabled, false, "copying is not a launch");
});

test("software without accounts launches as before, with no account attached", async t => {
  const f = await fixture(t, true);
  await f.setInput("Software", "claude");
  assert.equal(f.labelled("Account"), undefined);
  await f.click("Start in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  assert.deepEqual(f.resolves(), [], "a driver with no accounts asks nothing");
  assert.equal("account" in launch.launches[0]!, false);
});

test("an employee whose session still runs keeps its account, and nothing is resolved", async t => {
  const f = await fixture(t, true, { extraAgents: human => [{ ...human, id: "atlas", name: "Atlas", role: "worker", seniority: "mid",
    focus: "frontend", project: "acme", terminalSession: "hm-acme-atlas" }] });
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "sessions", items: [{
    name: "hm-acme-atlas", project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1 }] } })); });
  await act(async () => { Array.from(f.host.querySelectorAll("label")).find(item => item.textContent?.trim() === "Resume same employees")!
    .querySelector("input")!.click(); });
  await f.settle();
  assert.match(f.host.textContent!, /This session keeps the account it started with\. Terminate it and launch again to switch\./);
  await f.click("Start in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  assert.equal(launch.launches[0]!.session, "hm-acme-atlas");
  assert.equal("account" in launch.launches[0]!, false);
  assert.deepEqual(f.resolves(), []);
});

test("with one employee running, only the new sessions take the chosen account", async t => {
  const f = await fixture(t, true, { accounts: [spec(), personal], extraAgents: human => [
    { ...human, id: "atlas", name: "Atlas", role: "worker", seniority: "mid", focus: "frontend", project: "acme", terminalSession: "hm-acme-atlas" },
    { ...human, id: "bea", name: "Bea", role: "worker", seniority: "mid", focus: "frontend", project: "acme" }] });
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "sessions", items: [{
    name: "hm-acme-atlas", project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1 }] } })); });
  await act(async () => { Array.from(f.host.querySelectorAll("label")).find(item => item.textContent?.trim() === "Resume same employees")!
    .querySelector("input")!.click(); });
  await f.settle();
  await f.choose("Account", f.accounts[1]!.id);
  await f.click("Start 2 in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  const [atlas, bea] = launch.launches;
  assert.equal("account" in atlas!, false, "Atlas keeps the account it started with");
  assert.equal(bea!.account?.label, "Personal");
  assert.deepEqual(f.resolves(), [{ driver: "codex", accountId: f.accounts[1]!.id, record: true }]);
});
