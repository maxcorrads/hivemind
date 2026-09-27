import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Agent, Project } from "../src/shared/types.ts";
import type { WorkerTemplate } from "../src/shared/worker-templates.ts";
import type { LaunchRequestView } from "./api.ts";
import type { NativeMessage } from "./native-bridge.ts";

const window = new Window({ url: "http://localhost/#/inbox/acme" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, CustomEvent: window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { api } = await import("./api.ts");
const { LaunchRequests, useLaunchRequests } = await import("./LaunchRequests.tsx");
const { decideLaunch } = await import("./launch-approval.ts");
const { TERMINAL_EVENT, resetNativePlatform, runNativeCommand } = await import("./native-bridge.ts");
after(() => window.happyDOM.close());

const project = { id: "project-1", slug: "acme", name: "Acme" } as Project;
const brain = { id: "brain-1", name: "Atlas", role: "brain" } as Agent;
const worker = { id: "worker-1", name: "Forge-api", role: "worker" } as Agent;
const template = (id: string, label: string): WorkerTemplate => ({
  id, projectId: project.id, slug: id, revision: 1, createdAt: 1, updatedAt: 1,
  spec: { label, description: "Work", software: "codex2", model: "", effort: "", extraFlags: "", environment: {},
    secretNames: [], seniority: "mid", focus: "", maxConcurrent: 1, enabled: true },
});
const templates = [template("template-a", "Codex"), template("template-b", "OpenCode")];
const request = (patch: Partial<LaunchRequestView> = {}): LaunchRequestView => ({
  id: "request-1", projectId: project.id, brainId: brain.id, templateId: templates[0]!.id, templateLabel: "Codex",
  taskId: "task-1", jobId: null, agentId: worker.id, state: "awaiting_approval", reason: "Build the API",
  requestedAt: Date.UTC(2026, 8, 27), decidedBy: null, decidedAt: null, session: null, error: null, capBlocked: false, ...patch,
});

async function fixture(t: TestContext, native: boolean, initial: LaunchRequestView[] = [request()], platform: "macos" | "ios" = "macos") {
  resetNativePlatform();
  if (native && platform === "ios") runNativeCommand({ command: "ready", platform: "ios" }, {
    jump() {}, forYou() {}, newChannel() {}, settings() {}, toggleTheme() {}, navigate() {},
  });
  let rows = initial;
  let readError: Error | null = null;
  let templateError: Error | null = null;
  t.mock.method(api, "launchRequests", async () => {
    if (readError) throw readError;
    return { requests: rows };
  });
  t.mock.method(api, "workerTemplates", async () => {
    if (templateError) throw templateError;
    return { templates };
  });
  const posted: NativeMessage[] = [];
  const win = window as unknown as { webkit?: unknown };
  if (native) win.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => {
    posted.push(message);
    if (message.type === "launcher-approve" || message.type === "launcher-reject") {
      rows = [];
      window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: { type: "launcher-decided", id: message.id,
        requestId: message.requestId, action: message.type === "launcher-approve" ? "approve" : "reject" } }));
    }
  } } } };
  else delete win.webkit;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let emit: (event: { type: string; payload: unknown }) => void = () => {};
  function Harness({ available = true }: { available?: boolean }) {
    const queue = useLaunchRequests([project], [brain, worker]);
    emit = queue.onLiveEvent;
    return <LaunchRequests requests={queue.requests} projects={[project]} agents={[brain, worker]}
      launcherAvailable={available} error={queue.error} loading={queue.loading} onRetry={() => void queue.refresh()}
      onDecide={queue.decide} native={native} />;
  }
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  const render = async (available = true) => { await act(async () => root.render(<Harness available={available} />)); await settle(); };
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
  const click = async (label: string) => { const target = button(label); assert.ok(target, label); await act(async () => target.click()); await settle(); };
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete win.webkit; resetNativePlatform(); });
  return { host, posted, render, settle, click, button, emit: (event: { type: string; payload: unknown }) => emit(event),
    setRows: (next: LaunchRequestView[]) => { rows = next; }, setReadError: (next: Error | null) => { readError = next; },
    setTemplateError: (next: Error | null) => { templateError = next; } };
}

test("browser sees approval cards but cannot decide or trigger native notifications", async t => {
  const f = await fixture(t, false);
  await f.render(false);
  assert.match(f.host.textContent!, /Atlas requests Forge-api/);
  assert.match(f.host.textContent!, /Build the API/);
  assert.match(f.host.textContent!, /Template: Codex/);
  assert.match(f.host.textContent!, /Open Hivemind\.app/);
  assert.match(f.host.textContent!, /Launches need Hivemind Server\.app/);
  assert.equal(f.button("Approve"), undefined);
  assert.equal(f.button("Reject"), undefined);
  await act(async () => f.emit({ type: "launch-requests", payload: { request: request() } }));
  assert.equal(f.posted.length, 0);
  await assert.rejects(decideLaunch("request-1", "approve"), /Open Hivemind\.app/);
});

test("a missing current template keeps its saved label and cannot be approved until another is chosen", async t => {
  const f = await fixture(t, true, [request({ templateId: "removed-template", templateLabel: "Archived Codex" })]);
  await f.render();
  assert.match(f.host.textContent!, /Archived Codex \(unavailable\)/);
  assert.equal(f.button("Approve")?.disabled, true);
  const select = f.host.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, "template-b");
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  assert.equal(f.button("Approve")?.disabled, false);
});

test("native card waits at cap, then approves a different template through the bridge", async t => {
  const f = await fixture(t, true, [request({ capBlocked: true })]);
  await f.render();
  assert.match(f.host.textContent!, /concurrent worker limit/);
  assert.equal(f.button("Approve")?.disabled, true);
  const select = f.host.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, "template-b");
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  assert.equal(f.button("Approve")?.disabled, false);
  await f.click("Approve");
  assert.deepEqual(f.posted.filter(message => message.type === "launcher-approve").map(message =>
    ({ requestId: message.requestId, templateId: message.templateId })), [{ requestId: "request-1", templateId: "template-b" }]);
  assert.equal(f.host.querySelector(".launch-request-card"), null);
});

test("native reject uses the signed bridge path and never calls a Human mutation API", async t => {
  const f = await fixture(t, true);
  await f.render();
  await f.click("Reject");
  assert.deepEqual(f.posted.filter(message => message.type === "launcher-reject").map(message => message.requestId), ["request-1"]);
});

test("list errors and native decision errors remain visible and retriable", async t => {
  const f = await fixture(t, true);
  f.setReadError(new Error("Temporarily unavailable"));
  await f.render();
  assert.match(f.host.querySelector('[role="alert"]')!.textContent!, /Temporarily unavailable/);
  f.setReadError(null);
  await f.click("Refresh");
  assert.match(f.host.textContent!, /Build the API/);
  const win = window as unknown as { webkit?: { messageHandlers?: { hivemind?: { postMessage(message: NativeMessage): void } } } };
  win.webkit!.messageHandlers!.hivemind!.postMessage = message => {
    if (message.type === "launcher-approve") window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT,
      { detail: { type: "terminal-error", id: message.id, code: "cap-reached", message: "Template is full" } }));
  };
  await f.click("Approve");
  assert.match(f.host.querySelector('.launch-request-card [role="alert"]')!.textContent!, /Template is full/);
  assert.equal(f.button("Approve")?.disabled, false);
});

test("Refresh retries a failed template list before allowing approval", async t => {
  const f = await fixture(t, true);
  f.setTemplateError(new Error("Template list unavailable"));
  await f.render();
  assert.match(f.host.textContent!, /Template list unavailable/);
  assert.equal(f.button("Approve")?.disabled, true);
  f.setTemplateError(null);
  await f.click("Refresh");
  assert.doesNotMatch(f.host.textContent!, /Template list unavailable/);
  assert.equal(f.host.querySelectorAll("select option").length, 2);
  assert.equal(f.button("Approve")?.disabled, false);
});

test("a new live request notifies the iOS app once and refreshes its cards", async t => {
  const f = await fixture(t, true, [], "ios");
  await f.render();
  f.setRows([request()]);
  await act(async () => f.emit({ type: "launch-requests", payload: { request: request() } }));
  await f.settle();
  assert.match(f.host.textContent!, /Build the API/);
  assert.deepEqual(f.posted.filter(message => message.type === "notify").map(message =>
    ({ tag: message.tag, target: message.target })), [{ tag: "launch-request-1", target: "#/inbox/acme" }]);
  await act(async () => f.emit({ type: "launch-requests", payload: { request: request() } }));
  assert.equal(f.posted.filter(message => message.type === "notify").length, 1);
});

test("Mac approval notification belongs to Server.app and the page emits no duplicate", async t => {
  const f = await fixture(t, true, []);
  await f.render();
  f.setRows([request()]);
  await act(async () => f.emit({ type: "launch-requests", payload: { request: request() } }));
  await f.settle();
  assert.match(f.host.textContent!, /Build the API/);
  assert.equal(f.posted.filter(message => message.type === "notify").length, 0);
});
