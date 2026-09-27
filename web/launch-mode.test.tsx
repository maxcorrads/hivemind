import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Agent } from "../src/shared/types.ts";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { api } = await import("./api.ts");
const { AgentList } = await import("./AgentList.tsx");
after(() => window.happyDOM.close());

const agent = (id: string, role: Agent["role"]): Agent => ({ id, name: id, role, seniority: role === "worker" ? "mid" : null,
  focus: null, online: false, lastSeenAt: 0, createdAt: 0, projectId: "project-1", project: "acme" });

async function fixture(t: TestContext) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let finish: ((response: Response) => void) | null = null;
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/ui/session") return Response.json({ ok: true });
    calls.push({ path, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "null")) });
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [agents, setAgents] = useState<Agent[]>([agent("Atlas", "brain"), agent("Forge", "worker")]);
    return <AgentList agents={agents} projectName="Acme" queued={{}} onCreateBot={() => {}} onOpen={() => {}}
      onAskClear={() => {}} onAskRemove={() => {}} onSetLaunchMode={async (current, mode) => {
        const { agent: saved } = await api.setAgentLaunchMode(current.name, mode);
        setAgents(items => items.map(item => item.id === saved.id ? saved : item));
      }} />;
  }
  await act(async () => root.render(<Harness />));
  const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".person")]
    .find(item => item.querySelector(".pn")?.textContent === name)!;
  const open = async (name: string) => {
    await act(async () => row(name).querySelector<HTMLButtonElement>(`.kebab`)!.click());
  };
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, calls, row, open, settle, answer: async (response: Response) => {
    assert.ok(finish);
    await act(async () => { finish!(response); await new Promise(resolve => setTimeout(resolve, 0)); });
    finish = null;
  } };
}

test("new brain shows Approval, worker has no toggle, and Auto PATCH uses the exact body", async t => {
  const f = await fixture(t);
  assert.match(f.row("Atlas").textContent!, /Approval/);
  assert.doesNotMatch(f.row("Forge").textContent!, /Approval|Auto/);
  await f.open("Forge");
  assert.equal(f.row("Forge").querySelector('[role="menuitemcheckbox"]'), null);
  await f.open("Atlas");
  const toggle = f.row("Atlas").querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
  assert.equal(document.activeElement, toggle, "the first menu item receives focus");
  const menu = f.row("Atlas").querySelector<HTMLElement>('[role="menu"]')!;
  await act(async () => menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
  assert.equal(document.activeElement?.textContent, "Remove");
  await act(async () => menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }) as unknown as Event));
  assert.equal(document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await act(async () => toggle.click());
  assert.equal(toggle.disabled, true);
  assert.match(toggle.textContent!, /Saving launch mode/);
  assert.match(f.row("Atlas").textContent!, /Approval/, "the displayed value remains saved mode while pending");
  assert.deepEqual(f.calls, [{ path: "/api/ui/agents/Atlas/launch-mode", method: "PATCH", body: { mode: "auto" } }]);
  await f.answer(Response.json({ agent: { ...agent("Atlas", "brain"), launchMode: "auto" } }));
  assert.match(f.row("Atlas").textContent!, /Auto/);
  await f.open("Atlas");
  assert.equal(f.row("Atlas").querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked"), "true");
});

test("failed save keeps the saved Approval mode, shows error, and permits retry", async t => {
  const f = await fixture(t);
  await f.open("Atlas");
  const toggle = f.row("Atlas").querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
  await act(async () => toggle.click());
  await f.answer(Response.json({ error: "Mode could not be saved" }, { status: 409 }));
  assert.match(f.row("Atlas").textContent!, /Approval/);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(toggle.disabled, false);
  assert.match(f.row("Atlas").querySelector('[role="alert"]')!.textContent!, /Mode could not be saved/);
  await act(async () => toggle.click());
  assert.deepEqual(f.calls[1], { path: "/api/ui/agents/Atlas/launch-mode", method: "PATCH", body: { mode: "auto" } });
  await f.answer(Response.json({ agent: { ...agent("Atlas", "brain"), launchMode: "auto" } }));
  assert.match(f.row("Atlas").textContent!, /Auto/);
  assert.equal(f.row("Atlas").querySelector('[role="alert"]'), null);
});
