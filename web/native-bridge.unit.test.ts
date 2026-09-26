import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Channel, Message, Project } from "../src/shared/types.ts";
import { launchBlockText, type LaunchContext } from "../src/shared/launch-prompt.ts";
import type { DesktopNotifications } from "./desktop-notifications.ts";
import {
  appLinks, badgeSync, inNativeApp, nativeBridge, notifyNative, postNative, runNativeCommand, startHivemindServer, useNativeBridge,
  BROKER_UNAVAILABLE_HINT, NATIVE_EVENT, TERMINAL_EVENT, TMUX_INSTALL_HINT, type NativeCommandHandlers, type NativeMessage,
  type TerminalSessionLaunch,
} from "./native-bridge.ts";
import type { Sel } from "./selection.ts";

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage,
  CustomEvent: window.CustomEvent, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { useDesktopNotifications } = await import("./desktop-notifications.ts");
const { SettingsMenu } = await import("./SettingsMenu.tsx");
const { LaunchSheet } = await import("./LaunchSheet.tsx");
const { api } = await import("./api.ts");
const { resetTerminalHub } = await import("./use-terminal.ts");
after(() => window.happyDOM.close());

type Win = typeof window & { webkit?: unknown; Notification?: unknown };
const win = window as Win;
let posted: NativeMessage[] = [];
const installBridge = () => {
  win.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => { posted.push(structuredClone(message)); } } } };
};

let focused = false;
let shown: Array<{ title: string; options: NotificationOptions }> = [];
let permissionAsks = 0;
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => { permissionAsks++; return FakeNotification.permission; };
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions) { shown.push({ title, options }); }
  close() {}
}
window.document.hasFocus = () => focused;

let unmounts: Array<() => void> = [];
beforeEach(() => {
  posted = [];
  shown = [];
  permissionAsks = 0;
  focused = false;
  delete win.webkit;
  resetTerminalHub();
  win.Notification = FakeNotification;
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  localStorage.clear();
});
afterEach(() => {
  for (const unmount of unmounts.reverse()) unmount();
  unmounts = [];
  document.body.innerHTML = "";
});

async function mount(render: () => React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const Harness = () => render();
  await act(async () => root.render(createElement(Harness)));
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; act(() => root.unmount()); } };
  unmounts.push(unmount);
  return { host, rerender: () => act(async () => root.render(createElement(Harness))), unmount };
}

function recorder() {
  const calls: string[] = [];
  const handlers: NativeCommandHandlers = {
    jump: () => calls.push("jump"), forYou: () => calls.push("for-you"), newChannel: () => calls.push("new-channel"),
    settings: () => calls.push("settings"), toggleTheme: () => calls.push("toggle-theme"),
    navigate: sel => calls.push(`navigate ${JSON.stringify(sel)}`),
  };
  return { calls, handlers };
}

const channel: Channel = { id: "dm1", name: "Atlas", type: "dm", topic: null, createdBy: "human", createdAt: 0,
  memberIds: ["human", "a"], projectId: "p", project: "acme" };
const message = (patch: Partial<Message> = {}) => ({ type: "message", payload: {
  id: "m1", channelId: "dm1", threadId: "root", authorId: "a", authorName: "Atlas", kind: "chat", body: "hello", ...patch,
} as Message });

test("the bridge exists only where WebKit registered a hivemind handler", () => {
  assert.equal(nativeBridge(undefined), null);
  assert.equal(nativeBridge({}), null);
  assert.equal(nativeBridge({ webkit: {} }), null);
  assert.equal(nativeBridge({ webkit: { messageHandlers: { other: { postMessage() {} } } } }), null);
  assert.equal(nativeBridge({ webkit: { messageHandlers: { hivemind: { postMessage: "no" } } } }), null);
  assert.equal(inNativeApp(), false);
  assert.equal(postNative({ type: "ready" }), false);

  installBridge();
  assert.equal(inNativeApp(), true);
  assert.equal(postNative({ type: "ready" }), true);
  assert.deepEqual(posted, [{ type: "ready" }]);
  win.webkit = { messageHandlers: { hivemind: { postMessage() { throw new Error("DataCloneError"); } } } };
  assert.equal(postNative({ type: "ready" }), false);
});

test("a notice crosses as its hash route, the form the app hands back as navigate", () => {
  installBridge();
  const target: Sel = { kind: "channel", id: "c 1", thread: "t/2" };
  assert.equal(notifyNative({ title: "Atlas", body: "hi", tag: "m1", target }), true);
  assert.deepEqual(posted, [{ type: "notify", title: "Atlas", body: "hi", tag: "m1", target: "#/c/c%201/t/t%2F2" }]);
  // The round trip lands on the same selection.
  const { calls, handlers } = recorder();
  runNativeCommand({ command: "navigate", hash: (posted[0] as { target: string }).target }, handlers);
  assert.deepEqual(calls, [`navigate ${JSON.stringify(target)}`]);
});

test("the badge is sent only when the count changes, and retried after a refused post", () => {
  const sent: number[] = [];
  let accept = true;
  const send = badgeSync(message => { if (!accept) return false; sent.push((message as { count: number }).count); return true; });
  send(0); send(0); send(3); send(3); send(1);
  accept = false; send(5);
  accept = true; send(5); send(5);
  assert.deepEqual(sent, [0, 3, 1, 5]);
});

test("every native command reaches its handler; malformed ones are ignored", () => {
  const { calls, handlers } = recorder();
  for (const command of ["jump", "for-you", "new-channel", "settings", "toggle-theme"])
    assert.equal(runNativeCommand({ command }, handlers), true);
  assert.equal(runNativeCommand({ command: "navigate", hash: "#/inbox/acme/all" }, handlers), true);
  assert.deepEqual(calls, ["jump", "for-you", "new-channel", "settings", "toggle-theme",
    `navigate ${JSON.stringify({ kind: "inbox", project: "acme", box: "all" })}`]);

  for (const detail of [null, "jump", {}, { command: "reload" }, { command: "navigate" }, { command: "navigate", hash: 7 },
    { command: "navigate", hash: "/c/general" }, { command: "navigate", hash: "#/" }, { command: "navigate", hash: "#/c/a b" },
    { command: "navigate", hash: "https://example.com/#/c/x" }])
    assert.equal(runNativeCommand(detail, handlers), false, JSON.stringify(detail));
  assert.equal(calls.length, 6);
});

test("inside the app the page listens for commands, reports ready once it has a snapshot, and mirrors the badge", async () => {
  installBridge();
  const { calls, handlers } = recorder();
  let props: { ready: boolean; badge: number | null } = { ready: false, badge: null };
  const view = await mount(() => { useNativeBridge({ ...props, handlers }); return null; });
  assert.deepEqual(posted, []);

  props = { ready: true, badge: 2 };
  await view.rerender();
  props = { ready: true, badge: 2 };
  await view.rerender();
  props = { ready: true, badge: 0 };
  await view.rerender();
  assert.deepEqual(posted, [{ type: "badge", count: 2 }, { type: "ready" }, { type: "badge", count: 0 }]);

  window.dispatchEvent(new window.CustomEvent(NATIVE_EVENT, { detail: { command: "for-you" } }));
  window.dispatchEvent(new window.CustomEvent(NATIVE_EVENT, { detail: { command: "navigate", hash: "#/c/general" } }));
  assert.deepEqual(calls, ["for-you", `navigate ${JSON.stringify({ kind: "channel", id: "general" })}`]);
  view.unmount();
  window.dispatchEvent(new window.CustomEvent(NATIVE_EVENT, { detail: { command: "jump" } }));
  assert.equal(calls.length, 2);
});

test("in a browser the bridge hook sends nothing and ignores command events", async () => {
  const { calls, handlers } = recorder();
  await mount(() => { useNativeBridge({ ready: true, badge: 4, handlers }); return null; });
  window.dispatchEvent(new window.CustomEvent(NATIVE_EVENT, { detail: { command: "jump" } }));
  assert.deepEqual(calls, []);
  assert.deepEqual(posted, []);
});

async function notificationsHook() {
  const went: Sel[] = [];
  let current!: DesktopNotifications;
  await mount(() => { current = useDesktopNotifications([channel], sel => { went.push(sel); }); return null; });
  return { get current() { return current; }, went };
}

test("inside the app notices go to the app, whatever the opt-in and focus, never to the Notification API", async () => {
  installBridge();
  focused = true;
  const hook = await notificationsHook();
  assert.equal(hook.current.native, true);
  assert.equal(hook.current.enabled, true);
  assert.equal(hook.current.blocked, false);
  await act(() => hook.current.toggle());
  assert.equal(permissionAsks, 0);

  hook.current.onLiveEvent(message());
  hook.current.onLiveEvent(message({ id: "m2", authorId: "human" }));
  hook.current.onLiveEvent({ type: "presence", payload: {} });
  assert.deepEqual(posted, [{ type: "notify", title: "Atlas", body: "hello", tag: "m1", target: "#/c/dm1/t/root" }]);
  assert.deepEqual(shown, []);
});

test("in a browser notices keep the opt-in, permission and focus rules of the Notification API", async () => {
  localStorage.setItem("hivemind-notifications", "on");
  const hook = await notificationsHook();
  assert.equal(hook.current.native, false);
  assert.equal(hook.current.supported, true);
  assert.equal(hook.current.enabled, true);

  focused = true;
  hook.current.onLiveEvent(message());
  assert.deepEqual(shown, []);
  focused = false;
  hook.current.onLiveEvent(message());
  assert.deepEqual(shown, [{ title: "Atlas", options: { body: "hello", tag: "m1", icon: "/icon.png" } }]);
  assert.deepEqual(posted, []);

  localStorage.setItem("hivemind-notifications", "off");
  const off = await notificationsHook();
  assert.equal(off.current.enabled, false);
  off.current.onLiveEvent(message());
  assert.equal(shown.length, 1);
  await act(() => off.current.toggle());
  assert.equal(permissionAsks, 0, "already granted");
  assert.equal(off.current.enabled, true);
  assert.equal(localStorage.getItem("hivemind-notifications"), "on");
});

const menuProps = (notifications: Partial<DesktopNotifications>, openRequest?: number) => ({
  theme: "light" as const, onToggleTheme() {}, layout: "rail" as const, onLayout() {}, telegram: undefined as never,
  onTelegram() {}, onAdaptiveRouting() {}, onLaunch() {}, onHelp() {}, openRequest,
  notifications: { supported: true, native: false, enabled: false, blocked: false, toggle: async () => {}, onLiveEvent() {},
    ...notifications },
});

test("the Settings menu drops the browser opt-in inside the app", () => {
  assert.match(renderToStaticMarkup(createElement(SettingsMenu, menuProps({}))), /Desktop notifications: off/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SettingsMenu, menuProps({ native: true, enabled: true }))),
    /notifications/i);
});

test("the app's Settings… command opens the menu, and a remounted copy does not replay it", async () => {
  let request = 0;
  const view = await mount(() => createElement(SettingsMenu, menuProps({}, request)));
  const details = () => view.host.querySelector("details") as unknown as HTMLDetailsElement;
  assert.equal(details().open, false);
  request = 1;
  await view.rerender();
  assert.equal(details().open, true);
  assert.equal(document.activeElement?.getAttribute("aria-checked"), "true");

  const fresh = await mount(() => createElement(SettingsMenu, menuProps({}, request)));
  assert.equal((fresh.host.querySelector("details") as unknown as HTMLDetailsElement).open, false);
});

let opened: string[] = [];
appLinks.open = url => { opened.push(url); };

test("Start Hivemind Server opens the app's hivemind-server://start, and only inside it", () => {
  opened = [];
  assert.equal(startHivemindServer(), false);
  assert.deepEqual(opened, []);
  installBridge();
  assert.equal(startHivemindServer(), true);
  assert.deepEqual(opened, ["hivemind-server://start"]);
  assert.deepEqual(posted, []);
});

const project: Project = { id: "p1", slug: "acme", name: "Acme", worktree: "/Users/me/My Acme", createdAt: 0 };
const launchContext: LaunchContext = { project: { id: "p1", slug: "acme" }, plugins: [], pluginInstructions: "",
  hivemindMcp: { command: "hivemind", args: ["mcp"], env: {} } };
const seat = (id: string, name: string, role: "brain" | "worker"): Agent => ({ id, name, role, seniority: role === "worker" ? "mid" : null,
  focus: role === "brain" ? "coord" : "frontend", online: false, lastSeenAt: 0, createdAt: 0, projectId: "p1", project: "acme" });

async function mountLaunchSheet(agents: Agent[] = []) {
  const original = api.launchContext;
  api.launchContext = async () => launchContext;
  const view = await mount(() => createElement(LaunchSheet, { projects: [project], agents, defaultProject: "acme", onClose() {} }));
  await act(async () => {});
  unmounts.push(() => { api.launchContext = original; });
  const buttons = () => Array.from(view.host.querySelectorAll(".launch-footer button")) as unknown as HTMLButtonElement[];
  const button = (label: RegExp) => buttons().find(b => label.test(b.textContent ?? ""));
  const blocks = () => Array.from(view.host.querySelectorAll(".launch-pre")).map(pre => pre.textContent ?? "");
  return { view, button, blocks };
}

/** What the app sends the page (HivemindKit BridgeTerminalEvent), as the app delivers it. */
const fromApp = (detail: unknown) => act(async () => {
  window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail: detail as object }));
});
const ready = () => fromApp({ type: "terminal-status", tmux: "available", broker: "connected" });
const launchesPosted = () => posted.filter((m): m is Extract<NativeMessage, { type: "terminal-launch" }> => m.type === "terminal-launch");

test("the Launch agent sheet starts the command it would copy in a tmux session, inside the app only", async () => {
  const browser = await mountLaunchSheet();
  assert.ok(browser.button(/^Copy command$/));
  assert.equal(browser.button(/Terminal|background/), undefined);
  assert.deepEqual(posted, [], "a browser sends nothing");
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  installBridge();
  const sheet = await mountLaunchSheet();
  assert.deepEqual(posted, [{ type: "sessions-subscribe" }]);
  await ready();
  assert.ok(sheet.button(/^Copy command$/), "Copy stays");
  const open = sheet.button(/^Open in Terminal$/)!;
  assert.equal(open.disabled, false);
  await act(async () => { open.click(); });
  const [message] = launchesPosted();
  assert.equal(message.openInTerminal, true);
  assert.equal(message.launches.length, 1);
  const [launch] = message.launches;
  assert.deepEqual({ project: launch.project, agent: launch.agent, title: launch.title, cwd: launch.cwd },
    { project: "acme", agent: null, title: "Acme - new brain", cwd: "/Users/me/My Acme" });
  assert.match(launch.command, /^codex /);
  // One source of truth: the copied block is this launch with its cd.
  assert.equal(launchBlockText({ cwd: launch.cwd ?? null, command: launch.command }), sheet.blocks()[0]);
  assert.ok(sheet.button(/^Launching…$/)?.disabled);
  await fromApp({ type: "terminal-launched", id: message.id, names: ["hm-acme-new-1"], created: ["hm-acme-new-1"], errors: [] });
  assert.ok(sheet.button(/^Opened$/));

  posted = [];
  const background = sheet.button(/^Start in background$/)!;
  await act(async () => { background.click(); });
  assert.equal(launchesPosted()[0].openInTerminal, false);
  await fromApp({ type: "terminal-launched", id: launchesPosted()[0].id, names: [null],  created: [],
    errors: [{ index: 0, code: "cwd-missing", message: "No such folder" }] });
  assert.match(sheet.view.host.querySelector("[role=alert]")?.textContent ?? "", /Acme - new brain: No such folder/);
});

test("Resume same employees starts one session per employee at once, each named for its employee", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ resume: true }));
  installBridge();
  // Atlas was first launched as a new agent and still runs in that session: resuming reuses it.
  const sheet = await mountLaunchSheet([{ ...seat("a1", "Atlas", "brain"), terminalSession: "hm-acme-new-1" }, seat("a2", "Bea", "worker")]);
  await ready();
  assert.ok(sheet.button(/^Copy all$/));
  assert.ok(sheet.button(/^Start 2 in background$/));
  const open = sheet.button(/^Open 2 terminals$/)!;
  await act(async () => { open.click(); });
  const [{ id, launches }] = launchesPosted();
  assert.deepEqual(launches.map((l: TerminalSessionLaunch) => [l.project, l.agent, l.title]),
    [["acme", "Atlas", "Acme - Atlas"], ["acme", "Bea", "Acme - Bea"]]);
  assert.deepEqual(launches.map(l => l.session ?? null), ["hm-acme-new-1", null], "the session hint travels only when known");
  assert.deepEqual(launches.map(l => launchBlockText({ cwd: l.cwd ?? null, command: l.command })), sheet.blocks());
  assert.ok(launches.every(l => l.cwd === "/Users/me/My Acme"));
  await fromApp({ type: "terminal-launched", id, names: ["hm-acme-new-1", "hm-acme-bea"], created: ["hm-acme-bea"], errors: [] });
  assert.match(sheet.view.host.querySelector(".launch-note")?.textContent ?? "", /1 already running/);
  assert.ok(sheet.button(/^Opened$/));
});

test("the launch buttons wait for Hivemind Server and tmux, and say what is missing", async () => {
  installBridge();
  const sheet = await mountLaunchSheet();
  const open = () => sheet.button(/^Open in Terminal$/)!;
  assert.equal(open().disabled, true, "no status from the app yet");

  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable" });
  assert.equal(open().disabled, true);
  assert.equal(open().title, BROKER_UNAVAILABLE_HINT);
  assert.match(sheet.view.host.querySelector(".term-notice")?.textContent ?? "", /Start Hivemind Server to use terminals/);
  const start = Array.from(sheet.view.host.querySelectorAll(".term-notice button"))[0] as unknown as HTMLButtonElement;
  opened = [];
  await act(async () => { start.click(); });
  assert.deepEqual(opened, ["hivemind-server://start"]);

  await fromApp({ type: "terminal-status", tmux: "missing", broker: "connected" });
  assert.equal(open().disabled, true);
  assert.equal(open().title, TMUX_INSTALL_HINT);
  assert.equal(sheet.button(/background/)!.disabled, true);
  assert.match(sheet.view.host.querySelector(".term-notice")?.textContent ?? "", /brew install tmux/);

  await ready();
  assert.equal(open().disabled, false);
  assert.equal(sheet.view.host.querySelector(".term-notice"), null);
});

test("a workspace path the app cannot cd into disables the launch buttons but not Copy", async () => {
  installBridge();
  const sheet = await mountLaunchSheet();
  await ready();
  const input = sheet.view.host.querySelector(".launch-workspace input") as unknown as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, "relative/dir");
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  const open = sheet.button(/^Open in Terminal$/)!;
  assert.equal(open.disabled, true);
  assert.match(open.title, /absolute workspace path/);
  assert.equal(sheet.button(/^Copy command$/)!.disabled, false);
});

