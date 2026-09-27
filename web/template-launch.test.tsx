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

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT } = await import("./native-bridge.ts");
const { resetTerminalHub } = await import("./use-terminal.ts");
const { TemplateLaunchSheet } = await import("./TemplateLaunch.tsx");
after(() => window.happyDOM.close());

const spec = (patch: Partial<WorkerTemplateSpec> = {}): WorkerTemplateSpec => ({
  label: "OpenCode worker", description: "Frontend tasks.", software: "opencode-hm", model: "", effort: "", extraFlags: "--auto",
  environment: { OPENCODE_DISABLE_FFF: "1" }, secretNames: ["OPENCODE_API_KEY"], seniority: "mid", focus: "frontend",
  maxConcurrent: 2, enabled: true, ...patch,
});

async function fixture(t: TestContext, native: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "template-launch-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  const human = hive.identity.getAgent("human");
  const project = { ...hive.projects.listProjects()[0]!, worktree: "/Users/me/acme" };
  const template = hive.workerTemplates.create(human, project.id, { slug: "opencode", spec: spec() });
  let copied = "";
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/ui/session") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
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
  return { hive, host, template, type, click, settle, posted, copied: () => copied };
}

test("in a browser, Reserve and copy reserves a worker named after the task and copies its ticketed command", async t => {
  const f = await fixture(t, false);
  assert.match(f.host.querySelector(".launch-pre")!.textContent!, /claim=hmc_0{48}/, "the preview stands in for the ticket");
  await f.type("Task", "Settings page");
  await f.click("Reserve and copy");
  const [worker] = f.hive.identity.listAgents().filter(agent => agent.templateId === f.template.id);
  assert.ok(worker?.pending);
  assert.match(worker.name, /-settings-page$/);
  assert.match(f.copied(), /^cd -- '\/Users\/me\/acme' && OPENCODE_DISABLE_FFF='1' opencode-hm --auto --prompt '/);
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
