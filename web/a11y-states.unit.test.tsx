import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Channel } from "../src/shared/types.ts";
import { ChannelItem } from "./ChannelNav.tsx";
import { Inbox } from "./Inbox.tsx";
import { useTheme } from "./use-theme.ts";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
after(() => window.happyDOM.close());

/** A controllable `prefers-color-scheme: dark` query. */
function mockOsTheme(dark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = { matches: dark, addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn) };
  Object.assign(window, { matchMedia: (media: string) => media.includes("prefers-color-scheme") ? query : { matches: true } });
  return (next: boolean) => { query.matches = next; for (const fn of listeners) fn({ matches: next }); };
}

async function mountTheme() {
  let current: ReturnType<typeof useTheme> | null = null;
  const Probe = () => { current = useTheme(); return null; };
  const host = document.createElement("div");
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(createElement(Probe)));
  return { get: () => current!, unmount: () => act(async () => root.unmount()) };
}

const isDark = () => document.documentElement.classList.contains("dark");

test("the theme follows the OS until the Human picks one, then keeps the saved choice", async () => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  const setOs = mockOsTheme(true);
  const probe = await mountTheme();
  assert.equal(probe.get()[0], "dark");
  assert.ok(isDark());
  assert.equal(localStorage.getItem("hivemind-theme"), null, "following the OS saves nothing");
  await act(async () => setOs(false));
  assert.equal(probe.get()[0], "light");
  assert.ok(!isDark());
  await act(async () => probe.get()[1](theme => theme === "dark" ? "light" : "dark"));
  assert.equal(localStorage.getItem("hivemind-theme"), "dark");
  await act(async () => setOs(false));
  assert.equal(probe.get()[0], "dark", "an explicit choice wins over later OS changes");
  await probe.unmount();

  mockOsTheme(true);
  localStorage.setItem("hivemind-theme", "light");
  const saved = await mountTheme();
  assert.equal(saved.get()[0], "light");
  await saved.unmount();
});

const inbox = (props: Partial<Parameters<typeof Inbox>[0]>) => renderToStaticMarkup(createElement(Inbox, {
  box: "unread", items: [], unread: 0, filter: "all", onFilter: () => undefined, hasMore: false, channels: [], agents: [],
  onBox: () => undefined, onOpen: () => undefined,
  onOlder: () => undefined, onMarkSeen: () => undefined, onMarkMessage: async () => undefined, onDecisions: () => undefined, ...props,
}));

test("For you never claims the Human is caught up before the unread page arrived", () => {
  const loading = inbox({ loading: true });
  assert.match(loading, /role="status"[^>]*>Loading unread messages…/);
  assert.doesNotMatch(loading, /caught up/);
  assert.match(inbox({ failed: true }), /Unread messages could not be loaded/);
  assert.doesNotMatch(inbox({ failed: true }), /caught up/);
  assert.match(inbox({}), /You&#x27;re all caught up/);
  assert.match(inbox({ box: "all", loading: true }), /role="status"[^>]*>Loading activity…/);
  assert.match(inbox({ box: "all", failed: true }), /Activity could not be loaded/);
  assert.match(inbox({ box: "all" }), /No activity yet/);
});

test("the active sidebar entry is announced as the current page", () => {
  const ch: Channel = { id: "c", name: "general", type: "public", topic: null, createdBy: "human", createdAt: 0, memberIds: [],
    projectId: "p", project: "alpha" };
  assert.match(renderToStaticMarkup(createElement(ChannelItem, { ch, unread: 0, active: true, onClick: () => undefined })), /aria-current="page"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ChannelItem, { ch, unread: 0, active: false, onClick: () => undefined })), /aria-current/);
});
