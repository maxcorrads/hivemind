import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import type { Agent, Channel } from "../src/shared/types.ts";
import type { NativeMessage, TerminalSessionInfo } from "./native-bridge.ts";
import type { TerminalState } from "./use-terminal.ts";

// Which live tmux session an agent maps to (roster terminal icon, DM Terminal tab): its reported label, else the one
// session the broker recorded at launch for its project and name. Against a fake bridge: no app, broker, tmux or PTY.

const window = new Window({ url: "http://127.0.0.1:7420/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id) });
const { createRoot } = await import("react-dom/client");
const { TERMINAL_EVENT, resetNativePlatform } = await import("./native-bridge.ts");
const { agentLiveSession, recordedSession, resetTerminalHub } = await import("./use-terminal.ts");
const { AgentList } = await import("./AgentList.tsx");
const { ChannelDesk } = await import("./ChannelDesk.tsx");
const { api } = await import("./api.ts");
after(() => window.happyDOM.close());

const session = (name: string, patch: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ name, project: "acme", agent: null, alive: true, attached: 0, createdAt: 0, ...patch });
const agent = (name: string, patch: Partial<Agent> = {}): Agent =>
  ({ id: name.toLowerCase(), name, role: "worker", seniority: "mid", focus: null, online: true, lastSeenAt: 0, createdAt: 0,
    projectId: "p1", project: "acme", ...patch });
const state = (sessions: TerminalSessionInfo[] | null): TerminalState =>
  ({ native: true, platform: "macos", tmux: "available", broker: "connected", sessions, lastError: null });

test("the reported label wins over the recorded name", () => {
  const listed = state([session("hm-acme-atlas", { agent: "Atlas" }), session("hm-acme-new-1", { agent: "Atlas" })]);
  const atlas = agent("Atlas", { terminalSession: "hm-acme-new-1" });
  assert.equal(agentLiveSession(listed, atlas)?.name, "hm-acme-new-1");
  // A label whose session ended maps to nothing: no guessing past it.
  assert.equal(agentLiveSession(state([session("hm-acme-atlas", { agent: "Atlas" })]), atlas), null);
});

test("with no label, the one live session recorded for its project and name, case-insensitive", () => {
  const listed = state([
    session("hm-acme-atlas", { agent: "atlas" }),
    session("hm-acme-bea", { agent: "Bea" }),
    session("hm-acme-dead", { agent: "Cy", alive: false }),
    session("hm-acme-new-1", { agent: null }),
  ]);
  assert.equal(agentLiveSession(listed, agent("Atlas"))?.name, "hm-acme-atlas");
  assert.equal(recordedSession(listed, agent("BEA"))?.name, "hm-acme-bea");
  assert.equal(agentLiveSession(listed, agent("Cy")), null, "not a dead one");
  assert.equal(agentLiveSession(listed, agent("Dan")), null);
  assert.equal(agentLiveSession(state(null), agent("Atlas")), null, "nothing while the list is unknown");
  assert.equal(agentLiveSession(listed, null), null);
  assert.equal(agentLiveSession(listed, agent("Atlas", { removedAt: 1 })), null, "not a removed agent");
});

test("several matching sessions map to none", () => {
  const listed = state([session("hm-acme-atlas", { agent: "Atlas" }), session("hm-acme-atlas-2", { agent: "ATLAS" })]);
  assert.equal(agentLiveSession(listed, agent("Atlas")), null);
  // One of them dead leaves one.
  const oneDead = state([session("hm-acme-atlas", { agent: "Atlas" }), session("hm-acme-atlas-2", { agent: "Atlas", alive: false })]);
  assert.equal(agentLiveSession(oneDead, agent("Atlas"))?.name, "hm-acme-atlas");
});

test("a session recorded for another project, or with no project, maps to none", () => {
  const listed = state([session("hm-other-atlas", { project: "other", agent: "Atlas" }), session("hm-x-atlas", { project: null, agent: "Atlas" })]);
  assert.equal(agentLiveSession(listed, agent("Atlas")), null);
  assert.equal(agentLiveSession(listed, agent("Atlas", { project: "other" }))?.name, "hm-other-atlas");
  assert.equal(agentLiveSession(listed, agent("Atlas", { project: null })), null);
});

test("a session another agent's label claims is not a fallback", () => {
  const listed = state([session("hm-acme-atlas", { agent: "Atlas" })]);
  const atlas = agent("Atlas");
  const bea = agent("Bea", { terminalSession: "hm-acme-atlas" });
  assert.equal(agentLiveSession(listed, atlas, [atlas, bea]), null);
  assert.equal(agentLiveSession(listed, bea, [atlas, bea])?.name, "hm-acme-atlas");
  assert.equal(agentLiveSession(listed, atlas, [atlas])?.name, "hm-acme-atlas");
});

// ---- Where it is used ------------------------------------------------------------------------------------------------

type Win = typeof window & { webkit?: unknown };
const win = window as Win;
const installBridge = () => {
  win.webkit = { messageHandlers: { hivemind: { postMessage: (_message: NativeMessage) => {} } } };
};
const fromApp = (detail: object) => act(async () => { window.dispatchEvent(new window.CustomEvent(TERMINAL_EVENT, { detail })); });
const connected = { type: "terminal-status", tmux: "available", broker: "connected" } as const;

let unmounts: Array<() => void> = [];
beforeEach(() => {
  delete win.webkit;
  resetTerminalHub();
  resetNativePlatform();
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
  unmounts.push(() => act(() => root.unmount()));
  return host as unknown as HTMLElement;
}

test("the roster marks an unlabelled agent by the session recorded for it", async () => {
  const agents = [agent("Atlas", { role: "brain", seniority: null }), agent("Bea"), agent("Cleo", { terminalSession: "hm-acme-cleo" })];
  installBridge();
  const host = await mount(() => <AgentList agents={agents} projectName="Acme" onCreateBot={() => {}} queued={{}} onOpen={() => {}}
    onAskClear={() => {}} onAskRemove={() => {}} />);
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas", { agent: "atlas" }), session("hm-acme-b1", { agent: "Bea" }),
    session("hm-acme-b2", { agent: "Bea" }), session("hm-acme-cleo")] });
  const marked = Array.from(host.querySelectorAll(".person")).filter(row => row.querySelector(".person-term"))
    .map(row => [row.querySelector(".pn")?.textContent, row.querySelector(".person-term")?.getAttribute("title")]);
  assert.deepEqual(marked, [["Atlas", "Running in tmux session hm-acme-atlas"], ["Cleo", "Running in tmux session hm-acme-cleo"]],
    "Bea has two, so none");
});

test("a DM with an unlabelled agent has a Terminal tab for its recorded session, kept while the broker reconnects", async () => {
  const original = api.channelTasks;
  api.channelTasks = (async () => ({ items: [], hasMore: false })) as unknown as typeof api.channelTasks;
  unmounts.push(() => { api.channelTasks = original; });
  const human = agent("Human", { role: "human", seniority: null });
  const atlas = agent("Atlas", { role: "brain", seniority: null });
  const dm: Channel = { id: "dm1", name: "Atlas", type: "dm", topic: null, createdBy: "human", createdAt: 0, memberIds: ["human", "atlas"],
    projectId: "p1", project: "acme" };
  const ref = <T,>(current: T) => ({ current });
  installBridge();
  const host = await mount(() => <ChannelDesk channelId="dm1" activeChannel={dm} agents={[human, atlas]} roomAgents={[human, atlas]}
    channel={{ pane: null, setPane() {}, channelStream: ref(null), channelJournal: ref(new Map()), loadChannel: async () => {} } as never}
    threadPaneId={null} stickBottom={ref(true)} threadOpenAnchor={ref(null)} go={() => {}} roomTick={0} routingView={null}
    activeBrainChannel={false} brainNames={{}} onOpenRouting={() => {}} onInvite={() => {}}
    compose={{ sendChannel: async () => true } as never} onMarkUnread={async () => {}} setErr={() => {}} onBack={() => {}} />);
  const tabs = () => Array.from(host.querySelectorAll("[role=tab]")).map(tab => tab.textContent);
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas", { project: "other", agent: "Atlas" })] });
  assert.deepEqual(tabs(), ["Messages", "Tasks"], "another project's session is not Atlas's");
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas", { agent: "Atlas" })] });
  assert.deepEqual(tabs(), ["Messages", "Tasks", "Terminal"]);
  await fromApp({ type: "terminal-status", tmux: "unknown", broker: "connecting" });
  assert.deepEqual(tabs(), ["Messages", "Tasks", "Terminal"], "the list is only unknown");
  await fromApp(connected);
  await fromApp({ type: "sessions", items: [session("hm-acme-atlas", { agent: "Atlas" }), session("hm-acme-atlas-2", { agent: "Atlas" })] });
  assert.deepEqual(tabs(), ["Messages", "Tasks"], "two sessions for Atlas: ambiguous");
});
