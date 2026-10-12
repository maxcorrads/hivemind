import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import type { NativeMessage } from "./native-bridge.ts";
import type { WorkerTemplateSpec } from "../src/shared/worker-templates.ts";
import type { AccountSpec } from "../src/shared/accounts.ts";
import type { AccountSelection } from "../src/shared/account-selection.ts";

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT } = await import("./native-bridge.ts");
const { resetTerminalHub } = await import("./use-terminal.ts");
const { TemplateLaunchSheet, accountOutcome } = await import("./TemplateLaunch.tsx");
after(() => window.happyDOM.close());

const spec = (patch: Partial<WorkerTemplateSpec> = {}): WorkerTemplateSpec => ({
  label: "OpenCode worker", description: "Frontend tasks.", software: "opencode-hm", model: "", effort: "", extraFlags: "--auto",
  environment: { OPENCODE_DISABLE_FFF: "1" }, secretNames: ["OPENCODE_API_KEY"], seniority: "mid", focus: "frontend",
  maxConcurrent: 2, enabled: true, ...patch,
});

const account = (patch: Partial<AccountSpec> = {}): AccountSpec => ({ driver: "codex", label: "Work", homePath: "", shadowPath: "", ...patch });

type Options = {
  patch?: Partial<WorkerTemplateSpec>;
  /** Accounts Human has; `pin` makes the template pin the first of them. */
  accounts?: AccountSpec[];
  pin?: boolean;
  /** What the resolve endpoint answers instead of the server's own choice (the server has no usage yet). */
  resolution?: AccountSelection;
};

async function fixture(t: TestContext, native: boolean, options: Options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "template-launch-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  const project = { ...hive.projects.listProjects()[0]!, worktree: "/Users/me/acme" };
  const accounts = (options.accounts ?? []).map(item => hive.accounts.create(human, item));
  const template = hive.workerTemplates.create(human, project.id, { slug: "opencode",
    spec: spec({ ...options.patch, ...(options.pin ? { accountId: accounts[0]!.id } : {}) }) });
  let copied = "";
  // Every resolve request the sheet sends, as its body.
  const resolves: unknown[] = [];
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
  await act(async () => root.render(<TemplateLaunchSheet projects={[project]} agents={hive.identity.listAgents()} defaultProject={project.slug}
    onBack={() => {}} onClose={() => {}} />));
  await settle();
  const type = async (label: string, value: string) => {
    const control = Array.from(host.querySelectorAll("label")).find(l => l.firstChild?.textContent?.trim() === label)!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
    assert.ok(button, label);
    await act(async () => button.click());
    await settle();
  };
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
  return { hive, host, template, accounts, type, click, button, settle, posted, copied: () => copied, resolves: () => resolves };
}

test("in a browser, Reserve and copy reserves a worker named after the task and copies its ticketed command", async t => {
  const f = await fixture(t, false);
  assert.match(f.host.querySelector(".launch-pre")!.textContent!, /claim=hmc_0{48}/, "the preview stands in for the ticket");
  await f.type("Task", "Settings page");
  await f.click("Reserve and copy");
  const [worker] = f.hive.identity.listAgents().filter(agent => agent.templateId === f.template.id);
  assert.ok(worker?.pending);
  assert.match(worker.name, /-settings-page$/);
  assert.match(f.copied(), /^cd -- '\/Users\/me\/acme' && OPENCODE_DISABLE_FFF='1' HIVEMIND_ROLE='worker' opencode-hm --auto --prompt '/);
  assert.match(f.copied(), new RegExp(`the Hivemind worker ${worker.name}, reserved for one task`));
  assert.match(f.copied(), /claim=hmc_[0-9a-f]{48}/);
  assert.doesNotMatch(f.copied(), /claim=hmc_0{48}/);
  assert.match(f.host.textContent!, /Its secrets are passed only when it is started from Hivemind\.app or the iPhone app/);
});

test("in the apps, Start launches the reserved worker in tmux with its template, so the broker adds the secrets", async t => {
  const f = await fixture(t, true);
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available", broker: "connected" } })); });
  await f.type("Task", "api");
  await f.click("Start in background");
  const launch = f.posted.find(message => message.type === "terminal-launch");
  assert.ok(launch && "launches" in launch);
  const [worker] = f.hive.identity.listAgents().filter(agent => agent.templateId === f.template.id);
  const item = launch.launches[0]!;
  assert.equal(item.agent, worker!.name);
  assert.equal(item.template, f.template.id);
  assert.deepEqual(item.environment, { OPENCODE_DISABLE_FFF: "1" });
  assert.equal(item.cwd, "/Users/me/acme");
  assert.match(item.command, /claim=hmc_[0-9a-f]{48}/);
  assert.equal(launch.openInTerminal, false);
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-launched", id: launch.id,
    names: [`hm-acme-${worker!.name.toLowerCase()}`], created: [`hm-acme-${worker!.name.toLowerCase()}`], errors: [] } })); });
  await f.settle();
  assert.match(f.host.textContent!, new RegExp(`Started ${worker!.name}\\.`));
});

test("in the apps, Start under the template's pinned account attaches it, and the notice says which", async t => {
  const f = await fixture(t, true, { accounts: [account()], pin: true, patch: { software: "codex", environment: {}, secretNames: [] } });
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available", broker: "connected" } })); });
  await f.type("Task", "api");
  await f.click("Start in background");
  const launch = f.posted.find(message => message.type === "terminal-launch");
  assert.ok(launch && "launches" in launch);
  assert.deepEqual(launch.launches[0]!.account, { id: f.accounts[0]!.id, driver: "codex", label: "Work", homePath: "", shadowPath: "" });
  assert.deepEqual(f.resolves(), [{ driver: "codex", accountId: f.accounts[0]!.id, record: true }]);
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-launched", id: launch.id,
    names: ["hm-acme-api"], created: ["hm-acme-api"], errors: [] } })); });
  await f.settle();
  assert.match(f.host.textContent!, /Account: Work · usage unknown/);
});

test("an exhausted account reserves no worker and says when the first one resets", async t => {
  const f = await fixture(t, true, { accounts: [account()], pin: true, patch: { software: "codex", environment: {}, secretNames: [] },
    resolution: { kind: "exhausted", earliestReset: Date.now() + 2 * 3_600_000 + 60_000 } });
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available", broker: "connected" } })); });
  await f.type("Task", "api");
  await f.click("Start in background");
  assert.deepEqual(f.hive.identity.listAgents().filter(agent => agent.templateId === f.template.id), []);
  assert.equal(f.posted.some(message => message.type === "terminal-launch"), false);
  assert.match(f.host.textContent!, /Every Codex account is used up\. The first resets at .+ \(in 2h\)\./);
  assert.doesNotMatch(f.host.textContent!, /gives up after 30 minutes/, "nothing was reserved, so nothing gives up");
});

test("in the apps, a variable the account controls disables Start, and Reserve and copy stays open", async t => {
  const f = await fixture(t, true, { accounts: [account()], patch: { software: "codex", environment: { CODEX_HOME: "/tmp/elsewhere" }, secretNames: [] } });
  await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available", broker: "connected" } })); });
  assert.match(f.host.textContent!, /CODEX_HOME is managed by the account Work; remove it\./);
  assert.equal(f.button("Start in background")!.disabled, true);
  assert.equal(f.button("Reserve and copy")!.disabled, false);
});

test("each resolved account reads as the launch's line or as the reason it cannot start", () => {
  const now = Date.UTC(2026, 0, 1, 9);
  const work = { id: "acct_1", driver: "codex" as const, label: "Work", homePath: "", shadowPath: "", command: "codex" as const,
    order: 0, revision: 1, lastSelectedAt: null, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(accountOutcome({ kind: "none" }, "codex", now), { ok: true, account: null, text: null });
  const warning = "Work is used up until 2026-01-01T10:00:00.000Z";
  assert.deepEqual(accountOutcome({ kind: "account", account: work, reason: "pin", stale: false, warning }, "codex", now),
    { ok: true, account: { id: "acct_1", driver: "codex", label: "Work", homePath: "", shadowPath: "" }, text: `Account: Work · ${warning}` });
  assert.deepEqual(accountOutcome({ kind: "exhausted", earliestReset: null }, "claude", now),
    { ok: false, text: "Every Claude account is used up." });
  assert.deepEqual(accountOutcome({ kind: "unknown-pin", pin: "gone" }, "codex", now),
    { ok: false, text: "That account was removed; pick another." });
});
