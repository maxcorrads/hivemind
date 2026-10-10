import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Channel, Message, Project } from "../src/shared/types.ts";
import { buildLaunchCommand, launchBlockText, projectLaunchTools, softwareFamily, type LaunchContext } from "../src/shared/launch-prompt.ts";
import type { DesktopNotifications } from "./desktop-notifications.ts";
import {
  appLinks, badgeSync, inNativeApp, nativeBridge, notifyNative, postNative, reportedNativePlatform, resetNativePlatform, runNativeCommand,
  startHivemindServer, useNativeBridge,
  BROKER_UNAVAILABLE_HINT, NATIVE_EVENT, REMOTE_BROKER_UNAVAILABLE_HINT, REMOTE_TMUX_INSTALL_HINT, SERVER_UNVERIFIED_HINT, TERMINAL_EVENT,
  OPENCODE_API_KEY_PROBLEM, TMUX_INSTALL_HINT, type NativeCommandHandlers, type NativeMessage,
  type TerminalSessionLaunch,
} from "./native-bridge.ts";
import type { Sel } from "./selection.ts";
import type { LaunchSettings } from '../src/shared/launch-settings.ts';

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
  resetNativePlatform();
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

test("Switch Mac… shows only in the iPhone/iPad app, also when its ready answer comes after the menu, and asks the app", async () => {
  const handlers = { jump() {}, forYou() {}, newChannel() {}, settings() {}, toggleTheme() {}, navigate() {} };
  const entry = (host: HTMLElement) => Array.from(host.querySelectorAll(".tool-action")).find(button => button.textContent === "Switch Mac…");
  const browser = await mount(() => createElement(SettingsMenu, menuProps({})));
  assert.equal(entry(browser.host as unknown as HTMLElement), undefined, "not in a browser");
  browser.unmount();

  installBridge();
  const mac = await mount(() => createElement(SettingsMenu, menuProps({ native: true })));
  assert.equal(entry(mac.host as unknown as HTMLElement), undefined, "not in Hivemind.app on the Mac");
  await act(async () => { runNativeCommand({ command: "ready", platform: "ios" }, handlers); });
  const button = entry(mac.host as unknown as HTMLElement) as unknown as HTMLButtonElement | undefined;
  assert.ok(button, "the iOS app's answer to ready shows it");
  await act(async () => { button.click(); });
  assert.deepEqual(posted, [{ type: "switch-mac" }]);
  mac.unmount();

  const later = await mount(() => createElement(SettingsMenu, menuProps({ native: true })));
  assert.ok(entry(later.host as unknown as HTMLElement), "a menu mounted after the answer shows it at once");
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
const launchContext: LaunchContext = { project: { id: "p1", slug: "acme" }, botDefinitions: [], botInstructions: "",
  hivemindMcp: { command: "hivemind", args: ["mcp"], env: {} } };
const seat = (id: string, name: string, role: "brain" | "worker"): Agent => ({ id, name, role, seniority: role === "worker" ? "mid" : null,
  focus: role === "brain" ? "coord" : "frontend", online: false, lastSeenAt: 0, createdAt: 0, projectId: "p1", project: "acme" });

async function mountLaunchSheet(agents: Agent[] = [], context = launchContext, pendingContext?: Promise<LaunchContext>) {
  const original = api.launchContext, originalPrepare = api.prepareLaunch;
  api.launchContext = async () => pendingContext ?? context;
  // Unit boundary: server-issued tracking is covered by the HTTP/MCP integration tests.
  // Preserve the submitted configuration here so these tests exercise bridge batching and secrets.
  api.prepareLaunch = async request => ({ ...buildLaunchCommand({ ...request.settings,
    ...projectLaunchTools(context, project, request.settings.role), projectSlug: project.slug, hiveName: project.name,
    resume: Boolean(request.agentId), resumeName: agents.find(a => a.id === request.agentId)?.name,
    ...(request.native ? { nativeResume: { software: softwareFamily(request.settings.software) as 'codex' | 'claude' | 'cursor', sessionId: request.sessionId! } } : {}) }),
    environment: request.settings.environment });
  const view = await mount(() => createElement(LaunchSheet, { projects: [project], agents, defaultProject: "acme", onClose() {} }));
  await act(async () => {});
  unmounts.push(() => { api.launchContext = original; api.prepareLaunch = originalPrepare; });
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
  assert.match(launch.command, /^HIVEMIND_ROLE='brain' codex /);
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

test('mixed resume uses per-employee providers, conversation IDs, models and environments in one native batch', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'codex',
    environments: { codex: 'CODEX_HOME=/tmp/codex-fixture', claude: 'CLAUDE_CONFIG_DIR=/tmp/claude-fixture' } }));
  installBridge();
  const codexId = '67d735d1-9e33-4a61-9645-a931afc97f2b', claudeId = '456734b7-51a8-47cf-b541-146ac0b3cc36';
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain'), seat('a2', 'Bea', 'worker')], {
    ...launchContext, nativeSessions: {
      a1: { software: 'codex', model: 'gpt-6-sol', effort: 'high', sessionId: codexId },
      a2: { software: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', sessionId: claudeId },
    },
  });
  await ready();
  await act(async () => sheet.button(/^Start 2 in background$/)!.click());
  const [batch] = launchesPosted();
  assert.match(batch.launches[0].command, new RegExp(`codex resume '${codexId}' -m gpt-6-sol`));
  assert.match(batch.launches[1].command, new RegExp(`claude --resume '${claudeId}' --model claude-opus-5-5 --effort xhigh`));
  assert.deepEqual(batch.launches.map(l => l.environment), [
    { CODEX_HOME: '/tmp/codex-fixture' }, { CLAUDE_CONFIG_DIR: '/tmp/claude-fixture' },
  ]);
  assert.equal(batch.launches[1].command.includes(codexId), false);
  assert.equal(batch.launches[0].command.includes(claudeId), false);
  assert.equal(localStorage.getItem('hivemind-launch')!.includes(codexId), false);
});

test('online agents are not restarted and task-bound, archived and pending seats use their existing lifecycle controls', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true }));
  installBridge();
  const sheet = await mountLaunchSheet([
    { ...seat('a1', 'Atlas', 'brain'), online: true }, seat('a2', 'Bea', 'worker'),
    { ...seat('a3', 'TaskWorker', 'worker'), templateId: 'template-1' },
    { ...seat('a4', 'Archived', 'worker'), archivedAt: 123 },
    { ...seat('a5', 'Pending', 'worker'), pending: { until: Date.now() + 60000 } },
  ]);
  await ready();
  assert.equal(sheet.view.host.querySelectorAll('.launch-card').length, 2);
  assert.match(sheet.view.host.textContent!, /Already online or running/);
  await act(async () => sheet.button(/^Start in background$/)!.click());
  assert.deepEqual(launchesPosted()[0].launches.map(l => l.agent), ['Bea']);
});

test('resume ignores edits made before saved settings load, then changes only the explicitly selected model', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'codex',
    model: 'stale-model', effort: 'high', extraFlags: '--search' }));
  installBridge();
  const id = '67d735d1-9e33-4a61-9645-a931afc97f2b';
  const settings: LaunchSettings = { software: 'claude-work', model: 'saved-model', effort: 'xhigh', extraFlags: '--verbose',
    environment: { CLAUDE_CONFIG_DIR: '/fixture/original-profile' }, workspacePath: '/fixture/original-worktree',
    cdWorktree: true, passProject: true, adoptUntrusted: true, role: 'brain', seniority: null, focus: 'coord' };
  const context = { ...launchContext, savedLaunches: { a1: { settings, sessionId: id, captured: true } } };
  let resolveContext!: (context: LaunchContext) => void;
  const pending = new Promise<LaunchContext>(resolve => { resolveContext = resolve; });
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], context, pending);
  const card = sheet.view.host.querySelector('.launch-card')!;
  const model = Array.from(card.querySelectorAll('label')).find(label => label.textContent?.startsWith('Model'))!
    .querySelector('select')!;
  const recovery = Array.from(card.querySelectorAll('label')).find(label => label.textContent?.startsWith('Recovery'))!
    .querySelector('select')!;
  assert.match(card.textContent!, /Loading this employee/);
  // Synthetic/late events must be harmless too, not just pointer/keyboard input.
  await act(async () => {
    model.value = ''; model.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    recovery.value = 'handoff'; recovery.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  });
  await act(async () => resolveContext(context));
  assert.match(card.querySelector('pre')!.textContent!, /claude-work --resume/);
  assert.match(card.querySelector('pre')!.textContent!, /saved-model/);
  assert.equal(recovery.value, 'native');
  await act(async () => { model.value = ''; model.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event); });
  const submitted: LaunchSettings[] = [], prepare = api.prepareLaunch;
  api.prepareLaunch = async request => {
    assert.equal(request.native, true);
    assert.equal(request.sessionId, id);
    submitted.push(request.settings);
    return prepare(request);
  };
  await ready();
  await act(async () => sheet.button(/^Start in background$/)!.click());
  assert.deepEqual(submitted, [{ ...settings, model: '', effort: '' }]);
  const batch = launchesPosted()[0];
  assert.match(batch.launches[0].command, new RegExp(`claude-work --resume '${id}'`));
  assert.deepEqual(batch.launches[0].environment, settings.environment);
  await fromApp({ type: 'terminal-launched', id: batch.id, names: ['hm-acme-atlas'], created: ['hm-acme-atlas'], errors: [] });
});

test('saved launch choices beat stale browser preferences and explicit edits start from the saved card', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'claude',
    resumePreferences: { a1: { software: 'claude', model: 'stale-model', effort: 'low', extraFlags: '--stale' } } }));
  installBridge();
  const id = '67d735d1-9e33-4a61-9645-a931afc97f2b';
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], { ...launchContext, savedLaunches: { a1: {
    settings: { software: 'codex-work', model: 'saved-model', effort: 'high', extraFlags: '--search',
      workspacePath: '/fixture/original-worktree', cdWorktree: true, passProject: true, adoptUntrusted: true,
      role: 'brain', seniority: null, focus: 'coord', environment: { CODEX_HOME: '/fixture/original-profile' } },
    sessionId: id, captured: true,
  } } });
  const card = sheet.view.host.querySelector('.launch-card')!;
  assert.match(card.querySelector('pre')!.textContent!, /codex-work resume/);
  assert.match(card.querySelector('pre')!.textContent!, /saved-model/);
  const flags = Array.from(card.querySelectorAll('label')).find(label => label.textContent?.startsWith('CLI flags'))!.querySelector('input')!;
  await typeInto(flags as unknown as HTMLInputElement, '--search --color never');
  await ready();
  await act(async () => sheet.button(/^Start in background$/)!.click());
  const launch = launchesPosted()[0].launches[0];
  assert.match(launch.command, new RegExp(`codex-work resume '${id}' -m saved-model -c model_reasoning_effort=high --search --color never`));
  assert.equal(launch.cwd, '/fixture/original-worktree');
  assert.deepEqual(launch.environment, { CODEX_HOME: '/fixture/original-profile' });
  assert.doesNotMatch(launch.command, /stale-model|--stale/);
});

for (const savedValue of [true, false]) test(`resume launch checkboxes restore saved ${savedValue}, and explicit edits reach Copy and Start`, async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true,
    cdWorktree: !savedValue, passProject: !savedValue, adoptUntrusted: !savedValue }));
  installBridge();
  const settings: LaunchSettings = { software: 'claude', model: '', effort: '', extraFlags: '', environment: {},
    workspacePath: '/fixture/original-worktree', cdWorktree: savedValue, passProject: savedValue, adoptUntrusted: savedValue,
    role: 'brain', seniority: null, focus: 'coord' };
  const context = { ...launchContext, savedLaunches: { a1: { settings, sessionId: null, captured: true } } };
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], context);
  const checks = Array.from(sheet.view.host.querySelectorAll('fieldset.checks input')) as unknown as HTMLInputElement[];
  assert.equal(checks.length, 3);
  assert.deepEqual(checks.map(c => [c.checked, c.indeterminate]), Array(3).fill([savedValue, false]));
  for (const check of checks) await act(async () => check.click());
  assert.deepEqual(checks.map(c => c.checked), Array(3).fill(!savedValue));
  const submitted: LaunchSettings[] = [], prepare = api.prepareLaunch;
  api.prepareLaunch = async request => { submitted.push(request.settings); return prepare(request); };
  const copies: string[] = [];
  const oldClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text: string) => { copies.push(text); } } });
  try {
    await act(async () => sheet.button(/^Copy all$/)!.click());
    assert.deepEqual(submitted[0], { ...settings, cdWorktree: !savedValue, passProject: !savedValue, adoptUntrusted: !savedValue });
    assert.equal(copies[0]!.includes("cd -- '/fixture/original-worktree'"), !savedValue);
    assert.equal(copies[0]!.includes('project=acme'), !savedValue);
    assert.equal(copies[0]!.includes('authorizes the assigned work'), !savedValue);
    await ready();
    await act(async () => sheet.button(/^Start in background$/)!.click());
    assert.deepEqual(submitted[1], submitted[0]);
    const batch = launchesPosted()[0], launch = batch.launches[0];
    assert.equal(launch.cwd ?? null, savedValue ? null : settings.workspacePath);
    assert.equal(launch.command.includes('project=acme'), !savedValue);
    assert.equal(launch.command.includes('authorizes the assigned work'), !savedValue);
    await fromApp({ type: 'terminal-launched', id: batch.id, names: ['hm-acme-atlas'], created: ['hm-acme-atlas'], errors: [] });
    sheet.view.unmount();
    const reopened = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], context);
    const restored = Array.from(reopened.view.host.querySelectorAll('fieldset.checks input')) as unknown as HTMLInputElement[];
    assert.deepEqual(restored.map(c => c.checked), Array(3).fill(savedValue), 'unsaved browser defaults never replace the last successful launch');
  } finally {
    if (oldClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', oldClipboard);
    else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
  }
});

test('mixed resume options remain per employee until that exact launch checkbox is edited', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, cdWorktree: false, passProject: false, adoptUntrusted: false }));
  const settings: LaunchSettings = { software: 'claude', model: '', effort: '', extraFlags: '', environment: {},
    workspacePath: project.worktree, cdWorktree: true, passProject: true, adoptUntrusted: true,
    role: 'brain', seniority: null, focus: 'coord' };
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain'), seat('a2', 'Bea', 'worker'), seat('a3', 'Cedar', 'worker')], {
    ...launchContext, savedLaunches: {
      a1: { settings, sessionId: null, captured: true },
      a2: { settings: { ...settings, role: 'worker', seniority: 'mid', cdWorktree: false, passProject: false, adoptUntrusted: false }, sessionId: null, captured: true },
    },
  });
  const checks = Array.from(sheet.view.host.querySelectorAll('fieldset.checks input')) as unknown as HTMLInputElement[];
  assert.deepEqual(checks.map(c => [c.checked, c.indeterminate]), Array(3).fill([false, true]));
  const submitted: LaunchSettings[] = [], prepare = api.prepareLaunch;
  api.prepareLaunch = async request => { submitted.push(request.settings); return prepare(request); };
  const oldClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  try {
    await act(async () => sheet.button(/^Copy all$/)!.click());
    assert.deepEqual(submitted.map(s => [s.cdWorktree, s.passProject, s.adoptUntrusted]), [[true, true, true], [false, false, false], [false, false, false]]);
    // A mixed checkbox first selects all; explicitly clearing it revokes the prompt authorization for every card.
    await act(async () => checks[2]!.click());
    await act(async () => checks[2]!.click());
    assert.deepEqual(checks.map(c => [c.checked, c.indeterminate]), [[false, true], [false, true], [false, false]]);
    await act(async () => sheet.button(/^(Copy all|Copied)$/)!.click());
    assert.deepEqual(submitted.slice(3).map(s => [s.cdWorktree, s.passProject, s.adoptUntrusted]), [[true, true, false], [false, false, false], [false, false, false]]);
    assert.ok(sheet.blocks().every(block => !block.includes('authorizes the assigned work')));
  } finally {
    if (oldClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', oldClipboard);
    else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
  }
});

test('resume preserves literal quotes and whitespace in saved environment values, including after editing', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true }));
  installBridge();
  const environment = { JSON_STRING: '"enabled"', SINGLE_QUOTES: "'literal'", SPACES: '  keep  ', EMPTY: '',
    CODEX_HOME: '/fixture/profile with spaces', SHELL_TEXT: '$HOME `id` \\n' };
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], { ...launchContext, savedLaunches: { a1: {
    settings: { software: 'codex', model: '', effort: '', extraFlags: '', environment,
      workspacePath: project.worktree, cdWorktree: true, passProject: true, adoptUntrusted: true,
      role: 'brain', seniority: null, focus: 'coord' },
    sessionId: '67d735d1-9e33-4a61-9645-a931afc97f2b', captured: true,
  } } });
  const submitted: Record<string, string>[] = [], prepare = api.prepareLaunch;
  api.prepareLaunch = async request => { submitted.push(request.settings.environment); return prepare(request); };
  const copies: string[] = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text: string) => { copies.push(text); } } });
  try {
    await act(async () => sheet.button(/^Copy all$/)!.click());
    assert.deepEqual(submitted[0], environment, 'the copied command receives exactly the saved values');
    assert.ok(copies[0]!.includes(`JSON_STRING='"enabled"'`));
    const editor = sheet.view.host.querySelector('.launch-card textarea')! as unknown as HTMLTextAreaElement;
    await typeInto(editor, editor.value + '\nADDED=edited');
    await ready();
    await act(async () => sheet.button(/^Start in background$/)!.click());
    assert.deepEqual(submitted[1], { ...environment, ADDED: 'edited' });
    assert.deepEqual(launchesPosted()[0].launches[0].environment, { ...environment, ADDED: 'edited' });
  } finally {
    delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
  }
});

test('a failed prepare never launches any part of a selected batch', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true }));
  installBridge();
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain'), seat('a2', 'Bea', 'worker')]);
  const prepare = api.prepareLaunch;
  api.prepareLaunch = async request => {
    if (request.agentId === 'a2') throw new Error('Employee resumed since this command was prepared');
    return prepare(request);
  };
  await ready();
  await act(async () => sheet.button(/^Start 2 in background$/)!.click());
  assert.deepEqual(launchesPosted(), []);
  assert.match(sheet.view.host.querySelector('[role=alert]')!.textContent!, /Employee resumed/);
});

test('Copy requests clipboard access during the click, before async preparation completes (Safari)', async t => {
  const sheet = await mountLaunchSheet();
  let release!: () => void, requested = false, copied = '';
  const gate = new Promise<void>(resolve => { release = resolve; }), prepare = api.prepareLaunch;
  api.prepareLaunch = async request => { await gate; return prepare(request); };
  const oldItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  const oldClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  class Item { constructor(readonly data: Record<string, Promise<Blob>>) {} }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: Item });
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: {
    write: async (items: Item[]) => { requested = true; copied = await (await items[0].data['text/plain']).text(); },
  } });
  t.after(() => {
    if (oldItem) Object.defineProperty(globalThis, 'ClipboardItem', oldItem); else Reflect.deleteProperty(globalThis, 'ClipboardItem');
    if (oldClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', oldClipboard); else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
  });
  await act(async () => sheet.button(/^Copy command$/)!.click());
  assert.equal(requested, true, 'permission requested before network completion');
  assert.equal(copied, '');
  await act(async () => { release(); await gate; });
  assert.match(copied, /HIVEMIND_ROLE='brain' codex/);
  assert.ok(sheet.button(/^Copied$/));
});

test('switching a resume card to another provider explicitly clears native recovery and keeps other cards intact', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true }));
  const id = '67d735d1-9e33-4a61-9645-a931afc97f2b';
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain'), seat('a2', 'Bea', 'worker')], {
    ...launchContext, nativeSessions: { a1: { software: 'codex', model: 'gpt-6-sol', effort: 'high', sessionId: id } },
  });
  const cards = sheet.view.host.querySelectorAll('.launch-card');
  const input = cards[0].querySelector('input[list="launch-software"]') as HTMLInputElement;
  await typeInto(input, 'claude');
  await act(async () => { input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as unknown as Event); });
  assert.match(cards[0].querySelector('pre')!.textContent!, /HIVEMIND_ROLE='brain' claude /);
  assert.doesNotMatch(cards[0].querySelector('pre')!.textContent!, /gpt-6-sol|--resume/);
  assert.match(cards[0].textContent!, /previous transcript is not restored/);
  assert.match(cards[1].querySelector('pre')!.textContent!, /codex /);
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

  // A window opened without terminals on an unverified server: disabled, explained, no Start button.
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unverified" });
  assert.equal(open().disabled, true);
  assert.equal(open().title, SERVER_UNVERIFIED_HINT);
  assert.match(sheet.view.host.querySelector(".term-notice.unverified")?.textContent ?? "", /couldn't verify/);
  assert.equal(sheet.view.host.querySelectorAll(".term-notice button").length, 0);

  await fromApp({ type: "terminal-status", tmux: "missing", broker: "connected" });
  assert.equal(open().disabled, true);
  assert.equal(open().title, TMUX_INSTALL_HINT);
  assert.equal(sheet.button(/background/)!.disabled, true);
  assert.match(sheet.view.host.querySelector(".term-notice")?.textContent ?? "", /brew install tmux/);

  await ready();
  assert.equal(open().disabled, false);
  assert.equal(sheet.view.host.querySelector(".term-notice"), null);
});

// The iPhone/iPad app (docs/remote-access.md): the same launches, started on the Mac, with no Terminal.app.
const readyOnIos = () => fromApp({ type: "terminal-status", tmux: "available", broker: "connected", platform: "ios" });

test("on iOS the Launch agent sheet starts sessions on the Mac and opens the in-app terminal, never Terminal.app", async () => {
  installBridge();
  const sheet = await mountLaunchSheet();
  await readyOnIos();
  assert.equal(sheet.button(/Terminal/), undefined, "no Open in Terminal on iOS");
  assert.ok(sheet.button(/^Copy command$/), "Copy stays");
  assert.match(sheet.view.host.textContent ?? "", /tmux session on your Mac/);
  const start = sheet.button(/^Start on Mac$/)!;
  assert.equal(start.disabled, false);
  assert.equal(start.className, "primary launch-background");
  await act(async () => { start.click(); });
  const [message] = launchesPosted();
  assert.equal(message.openInTerminal, false);
  assert.ok(sheet.button(/^Launching…$/)?.disabled);
  await fromApp({ type: "terminal-launched", id: message.id, names: ["hm-acme-new-1"], created: ["hm-acme-new-1"], errors: [] });
  // The sheet gives way to the session's terminal.
  assert.equal(sheet.view.host.querySelector(".launch-sheet"), null);
  const sessions = sheet.view.host.querySelector("[aria-label='Terminals']");
  assert.ok(sessions, "the sessions sheet replaces the launch sheet");
  assert.equal(sessions.querySelector(".sheet-head h2")?.textContent, "hm-acme-new-1");
  assert.equal(Array.from(sessions.querySelectorAll("button")).some(b => /Open in Terminal/.test(b.textContent ?? "")), false);
});

test("the iOS app's answer to ready names the platform before any terminal status", async () => {
  const { calls, handlers } = recorder();
  assert.equal(runNativeCommand({ command: "ready" }, handlers), false, "a ready answer names its platform");
  assert.equal(reportedNativePlatform(), null);
  assert.equal(runNativeCommand({ command: "ready", platform: "ios" }, handlers), true);
  assert.deepEqual(calls, [], "no handler runs");
  assert.equal(reportedNativePlatform(), "ios");

  installBridge();
  const sheet = await mountLaunchSheet();
  assert.equal(sheet.button(/Terminal/), undefined, "never shown on iOS, not even before the first status");
  assert.equal(sheet.button(/^Start on Mac$/)?.disabled, true);
});

test("on iOS a failed launch stays on the sheet, and several open the session list", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ resume: true }));
  installBridge();
  const sheet = await mountLaunchSheet([seat("a1", "Atlas", "brain"), seat("a2", "Bea", "worker")]);
  await readyOnIos();
  assert.equal(sheet.button(/terminals/), undefined);
  await act(async () => { sheet.button(/^Start 2 on Mac$/)!.click(); });
  await fromApp({ type: "terminal-launched", id: launchesPosted()[0].id, names: ["hm-acme-atlas", null], created: ["hm-acme-atlas"],
    errors: [{ index: 1, code: "cwd-missing", message: "No such folder" }] });
  assert.match(sheet.view.host.querySelector("[role=alert]")?.textContent ?? "", /Acme - Bea: No such folder/);
  assert.ok(sheet.view.host.querySelector(".launch-sheet"), "an error keeps the sheet");

  await act(async () => { sheet.button(/^Start 2 on Mac$/)!.click(); });
  await fromApp({ type: "terminal-launched", id: launchesPosted()[1].id, names: ["hm-acme-atlas", "hm-acme-bea"], created: ["hm-acme-bea"],
    errors: [] });
  assert.equal(sheet.view.host.querySelector(".launch-sheet"), null);
  assert.equal(sheet.view.host.querySelector("[aria-label='Terminals'] .sheet-head h2")?.textContent, "Terminals");
});

test("on iOS the launch notice names the Mac and offers no Start Hivemind Server", async () => {
  installBridge();
  const sheet = await mountLaunchSheet();
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable", platform: "ios" });
  const start = sheet.button(/^Start on Mac$/)!;
  assert.equal(start.disabled, true);
  assert.equal(start.title, REMOTE_BROKER_UNAVAILABLE_HINT);
  assert.equal(sheet.view.host.querySelector(".term-notice button"), null);
  await fromApp({ type: "terminal-status", tmux: "missing", broker: "connected", platform: "ios" });
  assert.equal(start.title, REMOTE_TMUX_INSTALL_HINT);
  const notice = sheet.view.host.querySelector(".term-notice");
  assert.equal(notice?.textContent, "Install tmux on your Mac: brew install tmux");
  assert.equal(notice?.querySelector("code")?.textContent, "brew install tmux");
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


// The OpenCode Go API key (docs/terminal-broker.md#launch-secrets): pasted per launch, sent only with it.
const OPENCODE_KEY = "sk-go-TEST_s3cr3t_VALUE";
const keyInput = (host: ParentNode) => host.querySelector(".launch-secret input") as unknown as HTMLInputElement | null;
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}
const everywhereButTheLaunch = (host: ParentNode) => {
  const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!) ?? "");
  return [host.textContent ?? "", ...stored, window.location.href, JSON.stringify(posted.filter(m => m.type !== "terminal-launch"))];
};

test("the OpenCode Go API key field shows only for OpenCode, and only where the page can launch", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode" }));
  const browser = await mountLaunchSheet();
  assert.equal(keyInput(browser.view.host), null, "not in a browser, which cannot launch");
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  installBridge();
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "codex" }));
  const codex = await mountLaunchSheet();
  assert.equal(keyInput(codex.view.host), null, "not for Codex");
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  for (const software of ["opencode", "/opt/homebrew/bin/opencode"]) {
    localStorage.setItem("hivemind-launch", JSON.stringify({ software }));
    const sheet = await mountLaunchSheet();
    const input = keyInput(sheet.view.host)!;
    assert.ok(input, software);
    assert.equal(input.type, "password");
    assert.equal(input.getAttribute("autocomplete"), "off");
    assert.equal(input.getAttribute("spellcheck"), "false");
    assert.match(input.closest("label")?.textContent ?? "", /^OpenCode Go API key \(optional\)/);
    assert.match(sheet.view.host.querySelector("#launch-opencode-key-help")?.textContent ?? "",
      /^Passed to OpenCode as OPENCODE_API_KEY\. Not saved — if empty, OpenCode uses the key from \/connect\./);
    // Switching the software away hides it and forgets what was typed.
    await typeInto(input, OPENCODE_KEY);
    const software_ = sheet.view.host.querySelector("input[list='launch-software']") as unknown as HTMLInputElement;
    await typeInto(software_, "claude");
    assert.equal(keyInput(sheet.view.host), null);
    await typeInto(software_, "opencode");
    assert.equal(keyInput(sheet.view.host)!.value, "");
    for (const unmount of unmounts.splice(0).reverse()) unmount();
  }

  // The iPhone/iPad app launches on the Mac: the field is there too.
  resetTerminalHub();
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode" }));
  const ios = await mountLaunchSheet();
  await readyOnIos();
  assert.ok(keyInput(ios.view.host));
});

test("the Codex setup hint appears for both copied and native launches", async () => {
  const hint = (host: ParentNode) => host.querySelector(".launch-codex-env")?.textContent ?? null;
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "codex" }));
  const browser = await mountLaunchSheet();
  assert.match(hint(browser.view.host)!, /Review and trust that hook in \/hooks/, 'copied commands also need hook trust');
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  installBridge();
  for (const software of ["codex", "", "/opt/homebrew/bin/codex"]) {
    localStorage.setItem("hivemind-launch", JSON.stringify({ software }));
    const sheet = await mountLaunchSheet();
    assert.match(hint(sheet.view.host)!, /Prepared Codex launches include the Hivemind MCP binding/);
    assert.match(hint(sheet.view.host)!, /Review and trust that hook in \/hooks/);
    assert.match(hint(sheet.view.host)!, /hivemind mcp-config --codex/);
    const field = sheet.view.host.querySelector("input[list='launch-software']")!.closest("label")!;
    assert.equal(field.nextElementSibling?.nextElementSibling?.className, "help-p launch-codex-env", "right under the Software field");
    for (const other of ["claude", "opencode", "agent"]) {
      await typeInto(sheet.view.host.querySelector("input[list='launch-software']") as unknown as HTMLInputElement, other);
      assert.equal(hint(sheet.view.host), null, other);
    }
    for (const unmount of unmounts.splice(0).reverse()) unmount();
  }
});

test('Cursor CLI setup and native approval guidance appears for copied and native launches', async () => {
  for (const native of [false, true]) {
    if (native) installBridge();
    localStorage.setItem('hivemind-launch', JSON.stringify({ software: 'cursor-agent' }));
    const sheet = await mountLaunchSheet();
    const hint = () => sheet.view.host.querySelector('.launch-cursor-env')?.textContent ?? '';
    assert.match(hint(), /hivemind mcp-config --cursor/);
    assert.match(hint(), /a new launch can require approval again/);
    assert.match(hint(), /does not approve servers automatically/);
    await typeInto(sheet.view.host.querySelector("input[list='launch-software']") as unknown as HTMLInputElement, 'claude');
    assert.equal(hint(), '');
    for (const unmount of unmounts.splice(0).reverse()) unmount();
  }
});

test("the key goes with the launch only: never copied, stored or shown, and cleared once the launch started", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode" }));
  installBridge();
  const copies: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
  const sheet = await mountLaunchSheet();
  await ready();
  await typeInto(keyInput(sheet.view.host)!, `  ${OPENCODE_KEY}  `);
  await act(async () => { sheet.button(/^Copy command$/)!.click(); });
  assert.equal(copies.length, 1);
  assert.ok(!copies[0]!.includes(OPENCODE_KEY), "not in the copied command");
  assert.ok(sheet.blocks().every(block => !block.includes(OPENCODE_KEY)), "nor in the preview");

  await act(async () => { sheet.button(/^Start in background$/)!.click(); });
  const [message] = launchesPosted();
  assert.deepEqual(message.launches[0]!.secrets, { OPENCODE_API_KEY: OPENCODE_KEY }, "trimmed, and sent with the launch");
  assert.ok(!message.launches[0]!.command.includes(OPENCODE_KEY), "never part of the command");
  for (const text of everywhereButTheLaunch(sheet.view.host)) assert.ok(!text.includes(OPENCODE_KEY));
  // A launch that failed keeps it for another try.
  await fromApp({ type: "terminal-launched", id: message.id, names: [null], created: [],
    errors: [{ index: 0, code: "cwd-missing", message: "No such folder" }] });
  assert.equal(keyInput(sheet.view.host)!.value, `  ${OPENCODE_KEY}  `);

  posted = [];
  await act(async () => { sheet.button(/^Start in background$/)!.click(); });
  const [second] = launchesPosted();
  await fromApp({ type: "terminal-launched", id: second.id, names: ["hm-acme-new-1"], created: ["hm-acme-new-1"], errors: [] });
  assert.equal(keyInput(sheet.view.host)!.value, "", "cleared once the launch started");
  posted = [];
  await act(async () => { sheet.button(/^Started$/)!.click(); });
  assert.equal(launchesPosted()[0]!.launches[0]!.secrets, undefined, "the next launch goes without it");
  for (const text of everywhereButTheLaunch(sheet.view.host)) assert.ok(!text.includes(OPENCODE_KEY));
  delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

test("an empty key sends nothing, a malformed one blocks the launch without quoting it, and Resume passes it to every employee", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode", resume: true }));
  installBridge();
  const sheet = await mountLaunchSheet([seat("a1", "Atlas", "brain"), seat("a2", "Bea", "worker")]);
  await ready();
  assert.match(sheet.view.host.querySelector("#launch-opencode-key-help")?.textContent ?? "", /still running keeps it/);
  const start = () => sheet.button(/^(Start 2 in background|Started)$/)!;

  await typeInto(keyInput(sheet.view.host)!, `${OPENCODE_KEY} extra`);
  assert.equal(start().disabled, true);
  assert.equal(start().title, OPENCODE_API_KEY_PROBLEM);
  assert.equal(sheet.view.host.querySelector(".launch-secret ~ [role=alert]")?.textContent, OPENCODE_API_KEY_PROBLEM);
  assert.ok(!(sheet.view.host.textContent ?? "").includes(OPENCODE_KEY));
  assert.equal(sheet.button(/^Copy all$/)!.disabled, false, "Copy never needs the key");

  await typeInto(keyInput(sheet.view.host)!, "");
  await act(async () => { start().click(); });
  assert.ok(launchesPosted()[0]!.launches.every(l => !("secrets" in l)), "no key, no secrets");
  await fromApp({ type: "terminal-launched", id: launchesPosted()[0]!.id, names: ["hm-acme-atlas", "hm-acme-bea"], created: [], errors: [] });

  posted = [];
  await typeInto(keyInput(sheet.view.host)!, OPENCODE_KEY);
  await act(async () => { start().click(); });
  assert.deepEqual(launchesPosted()[0]!.launches.map(l => l.secrets), [{ OPENCODE_API_KEY: OPENCODE_KEY }, { OPENCODE_API_KEY: OPENCODE_KEY }]);
});

const savedResumeContext = (software: string): LaunchContext => ({ ...launchContext, savedLaunches: { a1: {
  settings: { software, model: '', effort: '', extraFlags: '', environment: {}, workspacePath: project.worktree,
    cdWorktree: true, passProject: true, adoptUntrusted: true, role: 'brain', seniority: null, focus: 'coord' },
  sessionId: null, captured: true,
} } });

test('mixed resume offers the OpenCode key independently of defaults and sends it only to OpenCode', async t => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'codex' }));
  installBridge();
  const copies: string[] = [], requests: unknown[] = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true,
    value: { writeText: async (text: string) => { copies.push(text); } } });
  t.after(() => { delete (globalThis.navigator as { clipboard?: unknown }).clipboard; });
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain'), seat('a2', 'Bea', 'worker')], savedResumeContext('opencode-work'));
  const prepare = api.prepareLaunch;
  api.prepareLaunch = async request => { requests.push(request); return prepare(request); };
  await ready();
  assert.ok(keyInput(sheet.view.host), 'saved OpenCode seat, despite the Codex browser default');
  const start = () => sheet.button(/^Start 2 in background$/)!;
  await typeInto(keyInput(sheet.view.host)!, `${OPENCODE_KEY} invalid`);
  assert.equal(start().disabled, true, 'invalid key still blocks a mixed launch');
  await typeInto(keyInput(sheet.view.host)!, ` ${OPENCODE_KEY} `);
  assert.equal(start().disabled, false);
  await act(async () => sheet.button(/^Copy all$/)!.click());
  assert.equal(copies.length, 1);
  assert.ok(!copies[0]!.includes(OPENCODE_KEY));
  await act(async () => start().click());
  const batch = launchesPosted()[0]!;
  assert.match(batch.launches[0]!.command, /opencode-work/);
  assert.match(batch.launches[1]!.command, /codex/);
  assert.deepEqual(batch.launches.map(launch => launch.secrets), [{ OPENCODE_API_KEY: OPENCODE_KEY }, undefined]);
  assert.ok(!JSON.stringify(requests).includes(OPENCODE_KEY), 'never sent to launch preparation');
  for (const launch of batch.launches) assert.ok(!launch.command.includes(OPENCODE_KEY));
  for (const text of everywhereButTheLaunch(sheet.view.host)) assert.ok(!text.includes(OPENCODE_KEY));
  await fromApp({ type: 'terminal-launched', id: batch.id, names: ['hm-acme-atlas', 'hm-acme-bea'],
    created: ['hm-acme-atlas', 'hm-acme-bea'], errors: [] });
  assert.equal(keyInput(sheet.view.host)!.value, '', 'cleared after a successful launch');
});

test('resume key visibility waits for saved settings and follows selection and explicit software edits', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'opencode' }));
  installBridge();
  const context = savedResumeContext('claude-work');
  let resolve!: (context: LaunchContext) => void;
  const pending = new Promise<LaunchContext>(done => { resolve = done; });
  const sheet = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], context, pending);
  assert.equal(keyInput(sheet.view.host), null, 'provisional defaults cannot expose the key field');
  await act(async () => resolve(context));
  assert.equal(keyInput(sheet.view.host), null, 'the saved Claude seat overrides the OpenCode default');
  const card = sheet.view.host.querySelector('.launch-card')!;
  const software = card.querySelector('input[list]') as unknown as HTMLInputElement;
  const changeSoftware = async (value: string) => {
    await act(async () => software.focus());
    await typeInto(software, value);
    await act(async () => software.blur());
  };
  await changeSoftware('opencode-work');
  assert.ok(keyInput(sheet.view.host));
  await typeInto(keyInput(sheet.view.host)!, OPENCODE_KEY);
  await typeInto(softwareInput(sheet.view.host), 'codex');
  assert.equal(keyInput(sheet.view.host)!.value, OPENCODE_KEY, 'changing unrelated defaults does not erase the selected seat key');
  const include = card.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async () => include.click());
  assert.equal(keyInput(sheet.view.host), null);
  await act(async () => include.click());
  assert.equal(keyInput(sheet.view.host)!.value, '', 'excluding the last OpenCode seat clears the key');
  await typeInto(keyInput(sheet.view.host)!, OPENCODE_KEY);
  await changeSoftware('claude-work');
  assert.equal(keyInput(sheet.view.host), null);
  await changeSoftware('opencode-work');
  assert.equal(keyInput(sheet.view.host)!.value, '', 'switching away from OpenCode also clears the key');
});

test('saved OpenCode resumes do not offer secrets in a browser or for an online employee', async () => {
  localStorage.setItem('hivemind-launch', JSON.stringify({ resume: true, software: 'opencode' }));
  const context = savedResumeContext('opencode-work');
  const browser = await mountLaunchSheet([seat('a1', 'Atlas', 'brain')], context);
  assert.equal(keyInput(browser.view.host), null);
  for (const unmount of unmounts.splice(0).reverse()) unmount();
  installBridge();
  const native = await mountLaunchSheet([{ ...seat('a1', 'Atlas', 'brain'), online: true }], context);
  assert.equal(keyInput(native.view.host), null, 'no selected launch target needs the key');
});

// Environment variables (docs/terminal-broker.md#launch-environment): remembered per software, prefixed to the copied
// command, and beside the command (never in it) in the apps.
const envInput = (host: ParentNode) => host.querySelector(".launch-env textarea") as unknown as HTMLTextAreaElement;
const softwareInput = (host: ParentNode) => host.querySelector("input[list='launch-software']") as unknown as HTMLInputElement;
const savedEnvironments = () => JSON.parse(localStorage.getItem("hivemind-launch") ?? "{}").environments as Record<string, string> | undefined;
const ENV_MARKER = "V4LUE_MARKER";
const ENV_TEXT = [
  "# OpenCode",
  "OPENCODE_DISABLE_FFF=1",
  `OPENCODE_CONFIG_CONTENT={"snapshot":false,"x":"${ENV_MARKER}"}`,
  "QUOTE=it's $HOME `id` 😀",
].join("\n");
const ENV = { OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: `{"snapshot":false,"x":"${ENV_MARKER}"}`, QUOTE: "it's $HOME `id` 😀" };

test("environment variables are remembered per software in this browser and come back with that software", async () => {
  const sheet = await mountLaunchSheet();
  const host = sheet.view.host;
  assert.equal(envInput(host).value, "");
  assert.match(host.querySelector("#launch-env-help")?.textContent ?? "",
    /Remembered for codex in this browser\. Don't put secrets here — use the API key field\./);
  await typeInto(envInput(host), "CODEX_ONLY=1");
  assert.deepEqual(savedEnvironments(), { codex: "CODEX_ONLY=1" });

  await typeInto(softwareInput(host), "  opencode ");
  assert.equal(envInput(host).value, "", "another software starts empty");
  assert.match(host.querySelector("#launch-env-help")?.textContent ?? "", /Remembered for opencode in this browser/);
  await typeInto(envInput(host), ENV_TEXT);
  assert.deepEqual(savedEnvironments(), { opencode: ENV_TEXT, codex: "CODEX_ONLY=1" }, "keyed by the trimmed software");
  await typeInto(softwareInput(host), "codex");
  assert.equal(envInput(host).value, "CODEX_ONLY=1");
  assert.match(host.querySelector(".settings-disclosure summary small")?.textContent ?? "", /1 env variable/);
  // Emptying the field forgets it for that software only.
  await typeInto(envInput(host), "");
  assert.deepEqual(savedEnvironments(), { opencode: ENV_TEXT });
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode", environments: {
    opencode: ENV_TEXT, constructor: "X=1", junk: 7, "": "Y=1", __proto__: "Z=1" } }));
  const again = await mountLaunchSheet();
  assert.equal(envInput(again.view.host).value, ENV_TEXT, "restored on the next visit");
  assert.match(again.view.host.querySelector(".settings-disclosure summary small")?.textContent ?? "", /3 env variables/);
  await typeInto(softwareInput(again.view.host), "hasOwnProperty");
  assert.equal(envInput(again.view.host).value, "", "an inherited name is no saved field");
});

test("storage that throws never breaks the environment field", async () => {
  const proto = Object.getPrototypeOf(localStorage) as Storage;
  const { getItem, setItem } = proto;
  proto.getItem = () => { throw new Error("denied"); };
  proto.setItem = () => { throw new Error("quota"); };
  try {
    const sheet = await mountLaunchSheet();
    await typeInto(envInput(sheet.view.host), "A=1");
    assert.equal(envInput(sheet.view.host).value, "A=1");
    assert.match(sheet.blocks()[0]!, /&& A='1' HIVEMIND_ROLE='brain' codex /);
  } finally {
    proto.getItem = getItem;
    proto.setItem = setItem;
  }
});

test("in a browser the preview and Copy command start the command with the variables, single-quoted", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode", environments: { opencode: ENV_TEXT } }));
  const copies: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
  try {
    const sheet = await mountLaunchSheet();
    const [block] = sheet.blocks();
    assert.ok(block!.startsWith(`cd -- '/Users/me/My Acme' && OPENCODE_DISABLE_FFF='1' ` +
      `OPENCODE_CONFIG_CONTENT='{"snapshot":false,"x":"${ENV_MARKER}"}' QUOTE='it'\\''s $HOME \`id\` 😀' HIVEMIND_ROLE='brain' opencode `), block);
    await act(async () => { sheet.button(/^Copy command$/)!.click(); });
    assert.deepEqual(copies, [block]);
  } finally {
    delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
  }
});

test("a refused line blocks Copy and launching and says why without quoting it; a repeated name warns", async () => {
  installBridge();
  const sheet = await mountLaunchSheet();
  await ready();
  const host = sheet.view.host;
  await typeInto(envInput(host), `A=1\nPATH=/tmp/${ENV_MARKER}\nA=2`);
  assert.equal(host.querySelector(".launch-env-errors")?.getAttribute("role"), "alert");
  assert.match(host.querySelector(".launch-env-errors")?.textContent ?? "", /Line 2: PATH belongs to the shell/);
  assert.equal(envInput(host).getAttribute("aria-invalid"), "true");
  assert.equal(sheet.button(/^Copy command$/)!.disabled, true);
  assert.equal(sheet.button(/^Open in Terminal$/)!.disabled, true);
  assert.match(host.textContent ?? "", /Fix the environment variables first/);
  assert.match(host.querySelector(".launch-env-warnings")?.textContent ?? "", /A is set on lines 1, 3; line 3 wins/);
  assert.ok(!(host.querySelector(".launch-env-errors")?.textContent ?? "").includes(ENV_MARKER));

  await typeInto(envInput(host), "A=1\nA=2");
  assert.equal(host.querySelector(".launch-env-errors"), null);
  assert.equal(sheet.button(/^Copy command$/)!.disabled, false);
  assert.match(sheet.blocks()[0]!, /&& A='2' HIVEMIND_ROLE='brain' codex /, "the last one wins");
});

test("the apps send the variables beside the command, never in it, and Resume gives every employee the same", async () => {
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode", environments: { opencode: ENV_TEXT } }));
  installBridge();
  const sheet = await mountLaunchSheet();
  await ready();
  await act(async () => { sheet.button(/^Start in background$/)!.click(); });
  const [message] = launchesPosted();
  assert.deepEqual(message.launches[0]!.environment, ENV);
  assert.ok(!message.launches[0]!.command.includes(ENV_MARKER), "never part of the command");
  assert.ok(!message.launches[0]!.command.includes("OPENCODE_DISABLE_FFF"));
  // The copied text keeps them, for a person to paste.
  assert.equal(launchBlockText({ cwd: message.launches[0]!.cwd ?? null, command: message.launches[0]!.command }, ENV), sheet.blocks()[0]);
  for (const unmount of unmounts.splice(0).reverse()) unmount();

  posted = [];
  resetTerminalHub();
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode", resume: true, environments: { opencode: ENV_TEXT } }));
  const resumed = await mountLaunchSheet([seat("a1", "Atlas", "brain"), seat("a2", "Bea", "worker")]);
  await ready();
  assert.match(resumed.view.host.querySelector("#launch-env-help")?.textContent ?? "", /still running keeps the variables it started with/);
  await act(async () => { resumed.button(/^Start 2 in background$/)!.click(); });
  const [resume] = launchesPosted();
  assert.deepEqual(resume.launches.map(l => l.environment), [ENV, ENV]);
  assert.ok(resume.launches.every(l => !l.command.includes(ENV_MARKER)));
  assert.equal(resumed.blocks().length, 2);
  assert.ok(resumed.blocks().every(block => block.includes("&& OPENCODE_DISABLE_FFF='1' ") &&
    (block.includes("😀' HIVEMIND_ROLE='brain' opencode ") || block.includes("😀' HIVEMIND_ROLE='worker' opencode "))),
    "each card's Copy (and so Copy all) has them too");

  // No variables, no key.
  for (const unmount of unmounts.splice(0).reverse()) unmount();
  posted = [];
  resetTerminalHub();
  localStorage.setItem("hivemind-launch", JSON.stringify({ software: "opencode" }));
  const plain = await mountLaunchSheet();
  await ready();
  await act(async () => { plain.button(/^Start in background$/)!.click(); });
  assert.ok(!("environment" in launchesPosted()[0]!.launches[0]!));
});
