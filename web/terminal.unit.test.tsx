import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import type { Agent, Channel, Project } from "../src/shared/types.ts";
import type { NativeMessage, TerminalSessionInfo } from "./native-bridge.ts";
import type { ScreenFactory, TerminalScreen } from "./TerminalView.tsx";

// The terminal UI of Hivemind.app against a fake bridge (the app's side of
// docs/terminal-broker.md#bridge) and a fake screen in place of xterm.js: no
// app, broker, tmux or PTY.

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, MutationObserver: window.MutationObserver,
  KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id) });
window.HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; } as never;
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT, BROKER_UNAVAILABLE_HINT, SERVER_UNVERIFIED_HINT, TMUX_INSTALL_HINT, REMOTE_BROKER_UNAVAILABLE_HINT,
  REMOTE_TMUX_INSTALL_HINT, appLinks, parseTerminalEvent, resetNativePlatform, runNativeCommand } = await import("./native-bridge.ts");
const opened: string[] = [];
appLinks.open = url => { opened.push(url); };
const terminal = await import("./use-terminal.ts");
const { createTerminalHub, resetTerminalHub, terminalBlocker, touchKey, withControl, agentTerminalSession, liveSession, rgbColor,
  TerminalRequestError } = terminal;
const { TerminalView, TerminalPanel } = await import("./TerminalView.tsx");
const { SessionsSheet, sessionOwner } = await import("./SessionsSheet.tsx");
const { AgentList } = await import("./AgentList.tsx");
const { ChannelDesk } = await import("./ChannelDesk.tsx");
const { api } = await import("./api.ts");
after(() => window.happyDOM.close());

type Win = typeof window & { webkit?: unknown };
const win = window as Win;
let posted: NativeMessage[] = [];
const installBridge = () => {
  win.webkit = { messageHandlers: { hivemind: { postMessage: (message: NativeMessage) => { posted.push(structuredClone(message)); } } } };
};
const sent = <T extends NativeMessage["type"]>(type: T) => posted.filter((m): m is Extract<NativeMessage, { type: T }> => m.type === type);

/** An event from the app, dispatched as the app evaluates it (HivemindKit BridgeTerminalEvent.javaScript). */
const fromApp = (detail: object) => act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail })); });
const connected = { type: "terminal-status", tmux: "available", broker: "connected" } as const;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
const bytes = (text: string) => [...new TextEncoder().encode(text)];
const base64 = (text: string) => Buffer.from(text).toString("base64");
const decode = (data: string) => Buffer.from(data, "base64").toString();

const session = (name: string, patch: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ name, project: "acme", agent: null, alive: true, attached: 0, createdAt: Date.now() - 120_000, ...patch });
const agent = (id: string, name: string, patch: Partial<Agent> & { terminalSession?: string | null } = {}): Agent =>
  ({ id, name, role: "brain", seniority: null, focus: "coord", online: true, lastSeenAt: 0, createdAt: 0, projectId: "p1",
    project: "acme", ...patch }) as Agent;
const project: Project = { id: "p1", slug: "acme", name: "Acme", worktree: "/Users/me/acme", createdAt: 0 };

let unmounts: Array<() => void> = [];
beforeEach(() => {
  posted = [];
  delete win.webkit;
  resetTerminalHub();
  resetNativePlatform();
  document.documentElement.className = "";
});
afterEach(() => {
  for (const unmount of unmounts.reverse()) unmount();
  unmounts = [];
  document.body.innerHTML = "";
  resetTerminalHub();
});

async function mount(render: () => ReactNode) {
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

/** A TerminalScreen that records what the terminal would draw and lets the test type into it. */
function fakeScreen(size = { cols: 100, rows: 30 }) {
  const inputs = new Set<(data: string | Uint8Array) => void>();
  const resizes = new Set<(cols: number, rows: number) => void>();
  const record = { written: [] as number[], created: 0, focused: 0, disposed: 0, rethemed: 0, applicationCursor: false,
    host: null as HTMLElement | null, undrawn: [] as Array<() => void>, drawAtOnce: true };
  const screen: TerminalScreen = {
    get cols() { return size.cols; },
    get rows() { return size.rows; },
    get applicationCursor() { return record.applicationCursor; },
    write: (data, drawn) => {
      record.written.push(...data);
      if (!drawn) return;
      if (record.drawAtOnce) drawn(); else record.undrawn.push(drawn);
    },
    onInput: listener => { inputs.add(listener); return () => inputs.delete(listener); },
    onResize: listener => { resizes.add(listener); return () => resizes.delete(listener); },
    fit() {},
    focus: () => { record.focused++; },
    retheme: () => { record.rethemed++; },
    dispose: () => { record.disposed++; },
  };
  const load = async (): Promise<ScreenFactory> => async host => { record.created++; record.host = host; return screen; };
  return {
    record, load,
    type: (data: string | Uint8Array) => act(async () => { for (const listener of inputs) listener(data); }),
    resize: (cols: number, rows: number) => act(async () => { size = { cols, rows }; for (const listener of resizes) listener(cols, rows); }),
  };
}

// ---- The hub ----------------------------------------------------------------------------------------------------

function hub() {
  installBridge();
  const made = createTerminalHub(window as never, { request: 40, attach: 40, linger: 0 });
  unmounts.push(() => made.dispose());
  return made;
}

test("the session list is subscribed while anyone watches it, and follows the app's status", async () => {
  const h = hub();
  const off = [h.subscribe(() => {}), h.subscribe(() => {})];
  assert.deepEqual(posted, [{ type: "sessions-subscribe" }], "one subscription for every viewer");
  off[0]!();
  await flush();
  assert.equal(sent("sessions-unsubscribe").length, 0);
  off[1]!();
  await flush();
  assert.deepEqual(posted.slice(1), [{ type: "sessions-unsubscribe" }]);

  const state = () => h.state;
  assert.deepEqual(state(), { native: true, platform: "macos", tmux: null, broker: null, sessions: null, lastError: null });
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas")] });
  assert.equal(state().sessions?.[0]?.name, "hm-acme-atlas");
  await fromApp({ type: "sessions", items: [{ name: "not-ours" }] });
  assert.equal(state().sessions?.length, 1, "a malformed event is dropped");
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable" });
  assert.equal(state().sessions, null, "no broker, no known sessions");
});

test("a launch is answered by its own id; refusals, errors and silence reject it", async () => {
  const h = hub();
  const launch = { project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: null, command: "claude" };
  const first = h.launch([launch], true);
  const [message] = sent("terminal-launch");
  assert.deepEqual(message, { type: "terminal-launch", id: message!.id, openInTerminal: true,
    launches: [{ project: "acme", agent: "Atlas", title: "Acme - Atlas", command: "claude" }] });
  await fromApp({ type: "terminal-launched", id: "someone-else", names: [], created: [], errors: [] });
  await fromApp({ type: "terminal-launched", id: message!.id, names: ["hm-acme-atlas"], created: [], errors: [] });
  assert.deepEqual((await first).names, ["hm-acme-atlas"]);

  const refused = assert.rejects(h.launch([launch], false), (error: InstanceType<typeof TerminalRequestError>) => error.code === "tmux-missing");
  await fromApp({ type: "terminal-error", id: sent("terminal-launch")[1]!.id, code: "tmux-missing", message: "no tmux", stream: null });
  await refused;

  await assert.rejects(h.launch([launch], false), /did not answer/, "the app drops a throttled message without an answer");
  const before = posted.length;
  await assert.rejects(h.launch([{ ...launch, cwd: "relative" }], false), /absolute workspace path/);
  await assert.rejects(h.launch([], false), /Nothing to launch/);
  assert.equal(posted.length, before, "nothing the app would refuse is sent");
});

test("a stream carries keys and sizes to the broker and its output back, until it ends", async () => {
  const h = hub();
  await fromApp(connected);
  const events: string[] = [];
  const output: number[] = [];
  const stream = h.attach("hm-acme-atlas", 5000, 0.5, {
    output: data => output.push(...data), attached: id => events.push(`attached ${id}`),
    exit: status => events.push(`exit ${status}`), error: error => events.push(`error ${error.code}`),
  });
  const [attach] = sent("terminal-attach");
  assert.deepEqual(attach, { type: "terminal-attach", id: attach!.id, session: "hm-acme-atlas", cols: 1000, rows: 1 }, "clamped");
  assert.equal(stream.input("early"), false, "keys before the stream exists are dropped");
  stream.resize(120, 40);
  assert.equal(sent("terminal-resize").length, 0, "held until attached");

  await fromApp({ type: "terminal-attached", id: attach!.id, stream: 3, session: "hm-acme-atlas" });
  assert.equal(stream.stream, 3);
  assert.deepEqual(sent("terminal-resize"), [{ type: "terminal-resize", stream: 3, cols: 120, rows: 40 }]);
  stream.resize(120, 40);
  assert.equal(sent("terminal-resize").length, 1, "an unchanged size is not sent again");

  assert.equal(stream.input("ls\r"), true);
  assert.deepEqual(sent("terminal-input").map(m => [m.stream, decode(m.data)]), [[3, "ls\r"]]);
  await fromApp({ type: "terminal-output", stream: 3, data: base64("héllo") });
  await fromApp({ type: "terminal-output", stream: 9, data: base64("not mine") });
  assert.deepEqual(output, bytes("héllo"));

  await fromApp({ type: "terminal-exit", stream: 3, status: 0 });
  assert.deepEqual(events, ["attached 3", "exit 0"]);
  assert.equal(stream.stream, null);
  assert.equal(stream.input("x"), false);
  stream.detach();
  assert.equal(sent("terminal-detach").length, 0, "an ended stream needs no detach");
});

test("a viewer that leaves before the answer detaches the stream it gets; refusals and lost brokers end streams", async () => {
  const h = hub();
  await fromApp(connected);
  const handlers = (log: string[]) => ({ output() {}, exit: (status: number | null) => log.push(`exit ${status}`),
    error: (error: Error & { code?: string }) => log.push(`error ${error.code}`) });

  const early: string[] = [];
  const gone = h.attach("hm-acme-atlas", 80, 24, handlers(early));
  gone.detach();
  await fromApp({ type: "terminal-attached", id: sent("terminal-attach")[0]!.id, stream: 1, session: "hm-acme-atlas" });
  assert.deepEqual(sent("terminal-detach"), [{ type: "terminal-detach", stream: 1 }]);
  assert.deepEqual(early, []);

  const refused: string[] = [];
  h.attach("hm-acme-gone", 80, 24, handlers(refused));
  await fromApp({ type: "terminal-error", id: sent("terminal-attach")[1]!.id, code: "no-such-session", message: "gone", stream: null });
  assert.deepEqual(refused, ["error no-such-session"]);

  const unanswered: string[] = [];
  h.attach("hm-acme-atlas", 80, 24, handlers(unanswered));
  await flush(); await flush(); await flush(); await flush(); await flush(); await flush(); await flush(); await flush(); await flush();
  assert.deepEqual(unanswered, ["error no-answer"]);

  const bad: string[] = [];
  h.attach("Not A Session", 80, 24, handlers(bad));
  await flush();
  assert.deepEqual(bad, ["error bad-message"]);

  const live: string[] = [];
  const stream = h.attach("hm-acme-atlas", 80, 24, handlers(live));
  await fromApp({ type: "terminal-attached", id: sent("terminal-attach").at(-1)!.id, stream: 4, session: "hm-acme-atlas" });
  await fromApp({ type: "terminal-error", id: null, code: "bad-message", message: "input", stream: 4 });
  assert.equal(stream.stream, 4, "a refused input does not end the stream");
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable" });
  assert.deepEqual(live, ["exit null"], "the broker's streams end with its connection");
});

test("kill is answered with killed and drops the session from the list", async () => {
  const h = hub();
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas"), session("hm-acme-bea")] });
  const killed = h.kill("hm-acme-atlas");
  const [message] = sent("terminal-kill");
  assert.deepEqual(message, { type: "terminal-kill", id: message!.id, session: "hm-acme-atlas" });
  await fromApp({ type: "terminal-killed", id: message!.id, session: "hm-acme-atlas" });
  await killed;
  assert.deepEqual(h.state.sessions?.map(item => item.name), ["hm-acme-bea"]);
  await assert.rejects(h.kill("../etc"), /Not a Hivemind session/);
  assert.equal(h.open("hm-acme-bea"), true);
  assert.equal(h.open("bea"), false);
  assert.deepEqual(sent("terminal-open"), [{ type: "terminal-open", session: "hm-acme-bea" }]);
});

test("helpers: blockers, session mapping, keys and colors", () => {
  const state = (patch: Partial<ReturnType<typeof createTerminalHub>["state"]>) =>
    ({ native: true, platform: "macos" as const, tmux: null, broker: null, sessions: null, lastError: null, ...patch });
  assert.equal(terminalBlocker({ ...state({}), native: false }), null);
  assert.equal(terminalBlocker(state({}))?.kind, "connecting");
  assert.equal(terminalBlocker(state({ broker: "unavailable", tmux: "unknown" }))?.message, BROKER_UNAVAILABLE_HINT);
  // A window opened on a server the app could not verify has no terminals, whatever tmux does.
  assert.deepEqual(terminalBlocker(state({ broker: "unverified", tmux: "unknown" })), { kind: "unverified", message: SERVER_UNVERIFIED_HINT });
  assert.equal(terminalBlocker(state({ broker: "connected", tmux: "missing" }))?.message, TMUX_INSTALL_HINT);
  assert.equal(terminalBlocker(state({ broker: "connected", tmux: "available" })), null);

  assert.equal(agentTerminalSession(agent("a", "Atlas", { terminalSession: "hm-acme-atlas" })), "hm-acme-atlas");
  assert.equal(agentTerminalSession(agent("a", "Atlas", { terminalSession: "rm -rf" })), null);
  assert.equal(agentTerminalSession(agent("a", "Atlas")), null);
  const listed = state({ sessions: [session("hm-acme-atlas"), session("hm-acme-dead", { alive: false })] });
  assert.equal(liveSession(listed, "hm-acme-atlas")?.name, "hm-acme-atlas");
  assert.equal(liveSession(listed, "hm-acme-dead"), null);
  assert.equal(liveSession(state({}), "hm-acme-atlas"), null);

  assert.equal(withControl("c"), "\x03");
  assert.equal(withControl("C"), "\x03");
  assert.equal(withControl("["), "\x1b");
  assert.equal(withControl("1"), "1");
  assert.equal(withControl("ab"), "ab", "a paste is not a key");
  assert.equal(touchKey("up"), "\x1b[A");
  assert.equal(touchKey("up", true), "\x1bOA");
  assert.equal(touchKey("esc"), "\x1b");
  // happy-dom has no canvas: the token is passed through for xterm to read.
  assert.equal(rgbColor("#ffffff"), "#ffffff");

  const [atlas, owner] = [agent("a", "Atlas", { terminalSession: "hm-acme-atlas" }), sessionOwner];
  assert.deepEqual(owner(session("hm-acme-atlas"), [atlas], [project]).label, "Atlas");
  assert.deepEqual(owner(session("hm-acme-new-1"), [atlas], [project]), { agent: null, label: "New agent", detail: ["not joined", "Acme"] });
});

// ---- The terminal ------------------------------------------------------------------------------------------------

test("the terminal attaches at its size, sends keys, draws output, and detaches when it goes", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" loadScreen={fake.load} />);
  await flush();
  const [attach] = sent("terminal-attach");
  assert.deepEqual({ ...attach, id: undefined }, { type: "terminal-attach", id: undefined, session: "hm-acme-atlas", cols: 100, rows: 30 });
  assert.match(view.host.querySelector(".term-note")?.textContent ?? "", /Connecting to hm-acme-atlas/);
  await fromApp({ type: "terminal-attached", id: attach!.id, stream: 2, session: "hm-acme-atlas" });
  assert.equal(view.host.querySelector(".term-note"), null);
  assert.equal(fake.record.focused, 1);

  await fake.type("echo hi\r");
  await fake.type("\x03");
  await fake.type(new Uint8Array([0x1b, 0x5b, 0x4d]));
  assert.deepEqual(sent("terminal-input").map(m => decode(m.data)), ["echo hi\r", "\x03", "\x1b[M"]);
  await fake.resize(90, 20);
  assert.deepEqual(sent("terminal-resize"), [{ type: "terminal-resize", stream: 2, cols: 90, rows: 20 }]);
  await fromApp({ type: "terminal-output", stream: 2, data: base64("\x1b[1mhi\x1b[0m") });
  assert.deepEqual(fake.record.written, bytes("\x1b[1mhi\x1b[0m"));

  // Keys stay in the terminal: Escape must not reach a dialog's window listener.
  let reached = 0;
  const onKey = () => { reached++; };
  window.addEventListener("keydown", onKey);
  const screen = view.host.querySelector(".term-screen")!;
  screen.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  screen.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }) as unknown as Event);
  window.removeEventListener("keydown", onKey);
  assert.equal(reached, 1, "only the ⌘ shortcut passes");

  document.documentElement.classList.add("dark");
  await flush();
  assert.equal(fake.record.rethemed, 1, "follows the light/dark switch");

  view.unmount();
  assert.deepEqual(sent("terminal-detach"), [{ type: "terminal-detach", stream: 2 }]);
  assert.equal(fake.record.disposed, 1);
});

test("xterm opens in an unpadded box inside the framed screen, so the fit addon sizes the grid to the room it has", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" loadScreen={fake.load} autoFocus={false} />);
  await flush();
  const host = fake.record.host!;
  assert.equal(host.className, "term-fit");
  assert.equal(host.parentElement, view.host.querySelector(".term-screen"));
  // The fit addon reads its parent's computed width and height, which under border-box include padding and border.
  const css = readFileSync(new URL("./styles/terminal.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`^\\${selector} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
  assert.match(rule(".term-screen"), /padding:/, "the frame is the outer box's");
  assert.doesNotMatch(rule(".term-fit"), /padding|border/);
  assert.match(rule(".term-fit"), /flex: 1 1 auto/);
});

test("the page acks each output once drawn, so the app can hold the broker back while it is behind", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" loadScreen={fake.load} autoFocus={false} />);
  await flush();
  await fromApp({ type: "terminal-attached", id: sent("terminal-attach")[0]!.id, stream: 4, session: "hm-acme-atlas" });
  await fromApp({ type: "terminal-output", stream: 4, data: base64("hello") });
  assert.deepEqual(sent("terminal-ack"), [{ type: "terminal-ack", stream: 4, bytes: 5 }]);

  // Not before xterm has drawn it.
  fake.record.drawAtOnce = false;
  await fromApp({ type: "terminal-output", stream: 4, data: base64("abcdef") });
  await fromApp({ type: "terminal-output", stream: 9, data: base64("not ours") });
  assert.equal(sent("terminal-ack").length, 1);
  fake.record.undrawn.shift()!();
  fake.record.undrawn.length = 0;
  assert.deepEqual(sent("terminal-ack").at(-1), { type: "terminal-ack", stream: 4, bytes: 6 });

  // Output drawn after the viewer left is not acked: the app has already forgotten it.
  await fromApp({ type: "terminal-output", stream: 4, data: base64("late") });
  view.unmount();
  for (const drawn of fake.record.undrawn) drawn();
  assert.equal(sent("terminal-ack").length, 2);
});

test("the touch row sends Esc, Tab, ^C, arrows in the program's cursor mode, and a sticky Ctrl", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" loadScreen={fake.load} autoFocus={false} />);
  await flush();
  await fromApp({ type: "terminal-attached", id: sent("terminal-attach")[0]!.id, stream: 1, session: "hm-acme-atlas" });
  const key = (label: string) => Array.from(view.host.querySelectorAll(".term-keys button"))
    .find(button => (button.getAttribute("aria-label") ?? button.textContent) === label) as unknown as HTMLButtonElement;
  await act(async () => { key("Esc").click(); key("Tab").click(); key("Ctrl+C").click(); key("Up").click(); });
  fake.record.applicationCursor = true;
  await act(async () => { key("Left").click(); });
  await act(async () => { key("Ctrl").click(); });
  assert.equal(key("Ctrl").getAttribute("aria-pressed"), "true");
  await fake.type("d");
  assert.equal(key("Ctrl").getAttribute("aria-pressed"), "false", "Ctrl holds for one key");
  await fake.type("d");
  assert.deepEqual(sent("terminal-input").map(m => decode(m.data)), ["\x1b", "\t", "\x03", "\x1b[A", "\x1bOD", "\x04", "d"]);
});

test("a detached or refused terminal says so and reconnects on request", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" loadScreen={fake.load} />);
  await flush();
  await fromApp({ type: "terminal-attached", id: sent("terminal-attach")[0]!.id, stream: 1, session: "hm-acme-atlas" });
  await fromApp({ type: "terminal-exit", stream: 1, status: 0 });
  assert.match(view.host.querySelector(".term-note")?.textContent ?? "", /Detached from hm-acme-atlas/);
  const reconnect = view.host.querySelector(".term-note button") as unknown as HTMLButtonElement;
  await act(async () => { reconnect.click(); });
  await flush();
  assert.equal(sent("terminal-attach").length, 2);
  assert.equal(fake.record.disposed, 1, "the old screen is gone");
  await fromApp({ type: "terminal-error", id: sent("terminal-attach")[1]!.id, code: "no-such-session", message: "No session hm-acme-atlas", stream: null });
  assert.equal(view.host.querySelector("[role=alert]")?.textContent?.startsWith("No session hm-acme-atlas"), true);
});

test("the panel shows why there is no terminal, and nothing at all in a browser", async () => {
  const fake = fakeScreen();
  const browser = await mount(() => <TerminalPanel session="hm-acme-atlas" loadScreen={fake.load} />);
  assert.equal(browser.host.innerHTML, "");
  assert.deepEqual(posted, []);
  browser.unmount();

  installBridge();
  const view = await mount(() => <TerminalPanel session="hm-acme-atlas" loadScreen={fake.load} />);
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable" });
  assert.match(view.host.textContent ?? "", /Start Hivemind Server to use terminals/);
  await act(async () => { (view.host.querySelector(".term-notice button") as unknown as HTMLButtonElement).click(); });
  assert.deepEqual(opened, ["hivemind-server://start"]);
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [] });
  assert.match(view.host.textContent ?? "", /hm-acme-atlas is not running/);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas")] });
  await flush();
  assert.equal(sent("terminal-attach").length, 1);
  assert.equal(fake.record.created, 1);
});

// ---- Sessions sheet, roster and DM tab ---------------------------------------------------------------------------

test("the sessions sheet maps sessions to agents, opens them here or in Terminal, and terminates after confirming", async () => {
  installBridge();
  const fake = fakeScreen();
  const atlas = agent("a1", "Atlas", { terminalSession: "hm-acme-atlas" });
  const view = await mount(() => <SessionsSheet agents={[atlas]} projects={[project]} onClose={() => {}} loadScreen={fake.load} />);
  assert.deepEqual(sent("sessions-subscribe").length, 1);
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas", { attached: 2 }), session("hm-acme-new-1", { agent: null })] });
  const rows = () => Array.from(view.host.querySelectorAll(".session-list > li"));
  assert.equal(rows().length, 2);
  assert.match(rows()[0]!.textContent ?? "", /Atlas.*brain · Acme · running · 2 attached · started 2m ago.*hm-acme-atlas/);
  assert.match(rows()[1]!.textContent ?? "", /New agent.*not joined · Acme/);
  const button = (label: string) => view.host.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement;

  await act(async () => { button("Open hm-acme-new-1 in Terminal").click(); });
  assert.deepEqual(sent("terminal-open"), [{ type: "terminal-open", session: "hm-acme-new-1" }]);
  await fromApp({ type: "terminal-error", id: null, code: "no-such-session", message: "hm-acme-new-1 is not running", stream: null });
  assert.equal(view.host.querySelector("[role=alert]")?.textContent, "hm-acme-new-1 is not running");

  await act(async () => { button("Open hm-acme-atlas").click(); });
  await flush();
  assert.equal(sent("terminal-attach")[0]?.session, "hm-acme-atlas");
  assert.match(view.host.querySelector(".sheet-head h2")?.textContent ?? "", /Atlas/);
  await act(async () => { button("All sessions").click(); });
  assert.deepEqual(sent("terminal-detach").length, 0, "never attached, nothing to detach");
  assert.equal(rows().length, 2);

  await act(async () => { button("Terminate hm-acme-atlas").click(); });
  const confirm = document.querySelector("[role=alertdialog]")!;
  assert.match(confirm.textContent ?? "", /Terminate Atlas\?.*hm-acme-atlas.*Atlas’s CLI/);
  assert.equal(sent("terminal-kill").length, 0, "nothing is killed before the confirmation");
  const yes = Array.from(confirm.querySelectorAll("button")).find(b => b.textContent === "Terminate") as unknown as HTMLButtonElement;
  await act(async () => { yes.click(); });
  const [kill] = sent("terminal-kill");
  assert.equal(kill?.session, "hm-acme-atlas");
  await fromApp({ type: "terminal-killed", id: kill!.id, session: "hm-acme-atlas" });
  await flush();
  assert.equal(document.querySelector("[role=alertdialog]"), null);
  assert.equal(rows().length, 1);
});

test("the roster marks agents running in a live session, inside the app only", async () => {
  const agents = [agent("a1", "Atlas", { terminalSession: "hm-acme-atlas" }), agent("a2", "Bea", { role: "worker", seniority: "mid" }),
    agent("a3", "Cleo", { terminalSession: "hm-acme-cleo" })];
  const render = () => <AgentList agents={agents} projectName="Acme" onCreateBot={() => {}} queued={{}} onOpen={() => {}}
    onAskClear={() => {}} onAskRemove={() => {}} />;
  const browser = await mount(render);
  assert.equal(browser.host.querySelectorAll(".person-term").length, 0);
  assert.deepEqual(posted, []);
  browser.unmount();

  installBridge();
  const view = await mount(render);
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas")] });
  const marked = Array.from(view.host.querySelectorAll(".person")).filter(row => row.querySelector(".person-term"))
    .map(row => row.querySelector(".pn")?.textContent);
  assert.deepEqual(marked, ["Atlas"], "Cleo's session is not running");
  assert.equal(view.host.querySelector(".person-term")?.getAttribute("title"), "Running in tmux session hm-acme-atlas");
});

test("a DM with an agent whose session runs has a Terminal tab, inside the app only", async () => {
  const original = api.channelTasks;
  api.channelTasks = (async () => ({ items: [], hasMore: false })) as unknown as typeof api.channelTasks;
  unmounts.push(() => { api.channelTasks = original; });
  const human = agent("human", "Human", { role: "human" });
  const atlas = agent("a1", "Atlas", { terminalSession: "hm-acme-atlas" });
  const dm: Channel = { id: "dm1", name: "Atlas", type: "dm", topic: null, createdBy: "human", createdAt: 0, memberIds: ["human", "a1"],
    projectId: "p1", project: "acme" };
  const ref = <T,>(current: T) => ({ current });
  const render = () => <ChannelDesk channelId="dm1" activeChannel={dm} agents={[human, atlas]} roomAgents={[human, atlas]}
    channel={{ pane: null, setPane() {}, channelStream: ref(null), channelJournal: ref(new Map()), loadChannel: async () => {} } as never}
    threadPaneId={null} stickBottom={ref(true)} threadOpenAnchor={ref(null)} go={() => {}} roomTick={0} routingView={null}
    activeBrainChannel={false} brainNames={{}} onOpenRouting={() => {}} onInvite={() => {}}
    compose={{ sendChannel: async () => true } as never} onMarkUnread={async () => {}} setErr={() => {}} onBack={() => {}} />;
  const tabs = (host: HTMLElement) => Array.from(host.querySelectorAll("[role=tab]")).map(tab => tab.textContent);

  const browser = await mount(render);
  assert.deepEqual(tabs(browser.host as unknown as HTMLElement), ["Messages", "Tasks"]);
  browser.unmount();

  installBridge();
  const view = await mount(render);
  const host = view.host as unknown as HTMLElement;
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [] });
  assert.deepEqual(tabs(host), ["Messages", "Tasks"], "no running session, no tab");
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas")] });
  assert.deepEqual(tabs(host), ["Messages", "Tasks", "Terminal"]);
  const terminalTab = Array.from(host.querySelectorAll("[role=tab]")).find(tab => tab.textContent === "Terminal") as unknown as HTMLButtonElement;
  await act(async () => { terminalTab.click(); });
  assert.equal(terminalTab.getAttribute("aria-selected"), "true");
  assert.ok(host.querySelector("#channel-panel-terminal .term"), "the terminal replaces the messages");
  assert.equal((host.querySelector("#channel-panel-messages") as unknown as HTMLElement).hidden, true, "which stay mounted");

  await fromApp({ type: "sessions", items: [] });
  assert.deepEqual(tabs(host), ["Messages", "Tasks"], "the session ended");
  assert.equal(host.querySelector("#channel-panel-terminal"), null);
});

// ---- The iPhone/iPad app ------------------------------------------------------------------------------------------
// The same bridge, but the broker is the Mac's (docs/remote-access.md): the app says "ios" in every terminal-status,
// and the page offers nothing that runs on the Mac's desktop (Terminal.app, Start Hivemind Server).

const onIos = { ...connected, platform: "ios" } as const;

test("terminal-status names the platform; Hivemind.app on the Mac, which sends none, is macos", () => {
  const status = (platform?: unknown) => parseTerminalEvent({ type: "terminal-status", tmux: "available", broker: "connected",
    ...(platform === undefined ? {} : { platform }) });
  assert.deepEqual(status(), { type: "terminal-status", tmux: "available", broker: "connected", platform: "macos" });
  assert.equal((status(null) as { platform: string }).platform, "macos");
  assert.equal((status("macos") as { platform: string }).platform, "macos");
  assert.equal((status("ios") as { platform: string }).platform, "ios");
  // Anything else is not the Mac, so it is offered no Mac desktop action.
  assert.equal((status("ipados") as { platform: string }).platform, "ios");
  assert.equal((status(7) as { platform: string }).platform, "ios");
});

test("the hub takes the platform from the iOS app's answer to ready, before or after it exists", async () => {
  const handlers = { jump() {}, forYou() {}, newChannel() {}, settings() {}, toggleTheme() {}, navigate() {} };
  const before = hub();
  assert.equal(before.state.platform, "macos", "the Mac app never says");
  runNativeCommand({ command: "ready", platform: "ios" }, handlers);
  assert.equal(before.state.platform, "ios");
  const after = hub();
  assert.equal(after.state.platform, "ios");
});

test("on iOS the hub never asks for Terminal.app, and says where the broker and tmux are", async () => {
  const h = hub();
  await fromApp(onIos);
  assert.equal(h.state.platform, "ios");
  const launch = { project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: null, command: "claude" };
  void h.launch([launch], true).catch(() => {});
  assert.equal(sent("terminal-launch")[0]?.openInTerminal, false, "a launch goes without a Terminal.app window");
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas")] });
  assert.equal(h.open("hm-acme-atlas"), false);
  assert.deepEqual(sent("terminal-open"), []);

  const state = (patch: object) => ({ ...h.state, ...patch });
  const server = terminalBlocker(state({ broker: "unavailable", tmux: "unknown" }));
  assert.deepEqual(server, { kind: "server", message: REMOTE_BROKER_UNAVAILABLE_HINT, canStart: false });
  assert.equal(terminalBlocker(state({ tmux: "missing" }))?.message, REMOTE_TMUX_INSTALL_HINT);
  assert.equal(terminalBlocker(state({ platform: "macos", broker: "unavailable" }))?.canStart, true);

  // A dropped broker ends the page's requests with the device's hint.
  const attached = new Promise<string>(resolve => {
    h.attach("hm-acme-atlas", 80, 24, { output() {}, exit() {}, error: error => resolve(error.message) });
  });
  await fromApp({ ...onIos, broker: "unavailable" });
  assert.equal(await attached, REMOTE_BROKER_UNAVAILABLE_HINT);
});

test("on iOS the panel explains a missing broker without offering to start it", async () => {
  installBridge();
  const fake = fakeScreen();
  const view = await mount(() => <TerminalPanel session="hm-acme-atlas" loadScreen={fake.load} />);
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "unavailable", platform: "ios" });
  assert.match(view.host.textContent ?? "", /Terminals need Hivemind Server running on your Mac/);
  assert.equal(view.host.querySelector(".term-notice button"), null, "a device cannot start the Mac's server");
  await fromApp({ type: "terminal-status", tmux: "missing", broker: "connected", platform: "ios" });
  await fromApp({ type: "sessions", items: [] });
  assert.match(view.host.textContent ?? "", /hm-acme-atlas is not running/, "a missing tmux does not hide a panel");
});

test("on iOS the sessions sheet opens sessions only here, and can open straight on one", async () => {
  installBridge();
  const fake = fakeScreen();
  const atlas = agent("a1", "Atlas", { terminalSession: "hm-acme-atlas" });
  const view = await mount(() => <SessionsSheet agents={[atlas]} projects={[project]} onClose={() => {}} loadScreen={fake.load}
    initialSession="hm-acme-atlas" />);
  await fromApp(onIos);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas"), session("hm-acme-new-1")] });
  await flush();
  assert.equal(sent("terminal-attach")[0]?.session, "hm-acme-atlas", "the initial session's terminal is shown");
  assert.match(view.host.querySelector(".sheet-head h2")?.textContent ?? "", /Atlas/);
  assert.equal(Array.from(view.host.querySelectorAll(".sheet-head button")).some(b => /Open in Terminal/.test(b.textContent ?? "")), false);

  const back = view.host.querySelector('[aria-label="All sessions"]') as unknown as HTMLButtonElement;
  await act(async () => { back.click(); });
  assert.equal(view.host.querySelectorAll(".session-list > li").length, 2);
  assert.ok(view.host.querySelector('[aria-label="Open hm-acme-atlas"]'), "Open stays");
  assert.equal(view.host.querySelector('[aria-label="Open hm-acme-atlas in Terminal"]'), null, "no Terminal.app on iOS");
  assert.equal(view.host.querySelector('[aria-label="Terminate hm-acme-atlas"]') !== null, true);
  assert.match(view.host.textContent ?? "", /tmux sessions on your Mac/);
});

test("on iOS the touch row always shows, and a key tap keeps the focus in the terminal", async () => {
  installBridge();
  const h = terminal.terminalHub()!;
  await fromApp(onIos);
  const fake = fakeScreen();
  const view = await mount(() => <TerminalView session="hm-acme-atlas" hub={h} loadScreen={fake.load} autoFocus={false} />);
  await flush();
  assert.equal(view.host.querySelector(".term")?.getAttribute("data-platform"), "ios");
  const css = readFileSync(new URL("./styles/terminal.css", import.meta.url), "utf8");
  assert.match(css, /\.term\[data-platform="ios"\] \.term-keys \{ display: flex; \}/);
  const esc = Array.from(view.host.querySelectorAll(".term-keys button")).find(b => b.textContent === "Esc")!;
  for (const type of ["pointerdown", "mousedown"]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    esc.dispatchEvent(event as unknown as Event);
    assert.equal(event.defaultPrevented, true, `${type} must not move focus off xterm`);
  }
});
