import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import type { HostCatalogEntry } from "../src/shared/hosts.ts";
import type { NativeMessage } from "./native-bridge.ts";

// The Launch sheet's Host field (docs/remote-hosts.md#launch): hidden with no host, in the apps only, and every launch
// of the sheet goes to the chosen host with that host's MCP. In-process only: no server, socket or host is reached.

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT } = await import("./native-bridge.ts");
const { resetTerminalHub } = await import("./use-terminal.ts");
const { LaunchSheet } = await import("./LaunchSheet.tsx");
after(() => window.happyDOM.close());

const buildMac: HostCatalogEntry = { id: "20000000-0000-4000-8000-000000000001", label: "Build Mac", online: true };
const sleepy: HostCatalogEntry = { id: "20000000-0000-4000-8000-000000000002", label: "Sleepy Mac", online: false };

async function fixture(t: TestContext, native: boolean, hosts: HostCatalogEntry[], saved: Record<string, unknown> = {}) {
  window.localStorage.clear();
  window.localStorage.setItem("hivemind-launch", JSON.stringify({ software: "claude", ...saved }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-sheet-hosts-ui-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  hive.hosts.replace({ hosts });
  const app = createApp(hive);
  const project = { ...hive.projects.listProjects()[0]!, worktree: "/Users/me/acme" };
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requested.push(url);
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
  await act(async () => root.render(<LaunchSheet projects={[project]} agents={hive.identity.listAgents()} defaultProject={project.slug}
    onClose={() => undefined} />));
  await settle();
  if (native) {
    await act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "terminal-status", tmux: "available",
      broker: "connected", platform: "macos" } })); });
    await settle();
  }
  const labelled = (label: string) => Array.from(host.querySelectorAll("label")).find(item => item.firstChild?.textContent?.trim() === label);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
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
  const launched = () => posted.find(message => message.type === "terminal-launch");
  return { host, labelled, button, choose, click, launched, requested: () => requested };
}

test("with no host the sheet has no Host field and launches on this Mac exactly as before hosts", async t => {
  const f = await fixture(t, true, []);
  assert.equal(f.labelled("Host"), undefined);
  assert.ok(f.requested().every(url => !url.includes("host=")), "the launch context is this Mac's");
  await f.click("Start in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  assert.equal("host" in launch.launches[0]!, false);
  assert.ok(!launch.launches[0]!.command.includes("Hivemind/remote"), "this Mac's MCP");
});

test("in a browser there is no Host field even with hosts: only the apps launch on a host", async t => {
  const f = await fixture(t, false, [buildMac]);
  assert.equal(f.labelled("Host"), undefined);
});

test("the Host field offers this Mac and each host, and a launch on a host carries it with that host's MCP", async t => {
  const f = await fixture(t, true, [buildMac, sleepy]);
  const select = f.labelled("Host")?.querySelector("select");
  assert.ok(select);
  assert.deepEqual(Array.from(select.options).map(option => option.textContent), ["This Mac", "Build Mac", "Sleepy Mac (offline)"]);
  assert.equal(select.value, "", "this Mac by default");
  await f.choose("Host", buildMac.id);
  assert.ok(f.requested().some(url => url.includes(`host=${buildMac.id}`)), "the context follows the host");
  await f.click("Start in background");
  const launch = f.launched();
  assert.ok(launch && "launches" in launch);
  assert.equal(launch.launches[0]!.host, buildMac.id);
  assert.match(launch.launches[0]!.command, /"command":"\/bin\/sh"/, "Claude's MCP is the host's runtime");
  assert.match(launch.launches[0]!.command, /http:\/\/127\.0\.0\.1:7422/);
  assert.equal(JSON.parse(window.localStorage.getItem("hivemind-launch")!).host, buildMac.id, "the pick is remembered");
});

test("an offline host refuses the launch and says why; a remembered host that is gone falls back to this Mac", async t => {
  const offline = await fixture(t, true, [buildMac, sleepy], { host: sleepy.id });
  assert.equal(offline.labelled("Host")?.querySelector("select")?.value, sleepy.id);
  assert.match(offline.host.textContent!, /Sleepy Mac is offline/);
  assert.equal(offline.button("Start in background")?.disabled, true);

  const gone = await fixture(t, true, [buildMac], { host: sleepy.id });
  assert.equal(gone.labelled("Host")?.querySelector("select")?.value, "");
  await gone.click("Start in background");
  const launch = gone.launched();
  assert.ok(launch && "launches" in launch);
  assert.equal("host" in launch.launches[0]!, false);
});
