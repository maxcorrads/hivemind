import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Agent, Channel } from "../src/shared/types.ts";

// The channel header's one-click Archive/Unarchive: no form, no reason, and never offered for DMs.

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id) });
const { createRoot } = await import("react-dom/client");
const { ChannelDesk } = await import("./ChannelDesk.tsx");
const { api } = await import("./api.ts");
after(() => window.happyDOM.close());

const human: Agent = { id: "human", name: "Human", role: "human", seniority: null, focus: null, online: true, lastSeenAt: 0, createdAt: 0,
  projectId: "p1", project: "acme" };
const channelOf = (type: Channel["type"]): Channel => ({ id: "c1", name: "sensors", type, topic: null, createdBy: "human", createdAt: 0,
  memberIds: ["human"], projectId: "p1", project: "acme" });

async function mount(t: TestContext, channel: Channel, archived: boolean) {
  const calls: Array<{ channel: string; archived: boolean }> = [];
  t.mock.method(api, "channelTasks", async () => ({ items: [], hasMore: false }));
  t.mock.method(api, "setChannelArchived", async (channel: string, next: boolean) => { calls.push({ channel, archived: next }); return { archived: next }; });
  const ref = <T,>(current: T) => ({ current });
  const errors: string[] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = (isArchived: boolean) => act(async () => root.render(<ChannelDesk channelId={channel.id} activeChannel={channel}
    archived={isArchived} agents={[human]} roomAgents={[human]}
    channel={{ pane: null, setPane() {}, channelStream: ref(null), channelJournal: ref(new Map()), loadChannel: async () => {} } as never}
    threadPaneId={null} stickBottom={ref(true)} threadOpenAnchor={ref(null)} go={() => {}} roomTick={0} routingView={null}
    activeBrainChannel={false} brainNames={{}} onOpenRouting={() => {}} onInvite={() => {}}
    compose={{ sendChannel: async () => true } as never} onMarkUnread={async () => {}} setErr={error => errors.push(error)} onBack={() => {}} />));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(archived);
  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label);
  return { calls, errors, button, render };
}

test("Archive is one click: it archives the channel with no form or reason", async t => {
  const f = await mount(t, channelOf("public"), false);
  const archive = f.button("Archive");
  assert.ok(archive, "public channels offer Archive in the header");
  assert.equal(f.button("Unarchive"), undefined);
  await act(async () => archive.click());
  assert.deepEqual(f.calls, [{ channel: "c1", archived: true }]);
  assert.equal(document.querySelector("header input, header textarea, header select, header form"), null, "no reason or running-task prompt");
  assert.deepEqual(f.errors, []);
});

test("an archived channel offers Unarchive, which clears the archive", async t => {
  const f = await mount(t, channelOf("private"), true);
  assert.equal(f.button("Archive"), undefined);
  const unarchive = f.button("Unarchive");
  assert.ok(unarchive);
  await act(async () => unarchive.click());
  assert.deepEqual(f.calls, [{ channel: "c1", archived: false }]);
});

test("DMs have no archive control", async t => {
  const f = await mount(t, { ...channelOf("dm"), name: "Human" }, false);
  assert.equal(f.button("Archive"), undefined);
  assert.equal(f.button("Unarchive"), undefined);
});
