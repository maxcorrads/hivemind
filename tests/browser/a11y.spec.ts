import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route, type WebSocketRoute } from "./fixtures.ts";

import type { Agent, Channel, Message, Project } from "../../src/shared/types.ts";
import type { ChannelPayload, Snapshot } from "../../web/api.ts";
import type { RoomView } from "../../src/shared/rooms.ts";

const human: Agent = { id: "human", name: "Human", role: "human", seniority: null, focus: null, online: true, lastSeenAt: 1,
  createdAt: 1, projectId: null, project: null };
const brain: Agent = { ...human, id: "brain-1", name: "Atlas", role: "brain", projectId: "project-alpha", project: "alpha" };
const alpha: Project = { id: "project-alpha", slug: "alpha", name: "Alpha Hive", worktree: null, createdAt: 1 };
const general: Channel = { id: "general", name: "general", type: "public", topic: "Team room", createdBy: "human", createdAt: 1,
  memberIds: ["human", "brain-1"], projectId: alpha.id, project: alpha.slug };
const dm: Channel = { ...general, id: "dm-atlas", name: "Atlas", type: "dm", topic: null };
const quiet: Channel = { ...general, id: "quiet", name: "quiet", topic: null };

const message = (id: string, seq: number, channelId: string, body: string, patch: Partial<Message> = {}): Message => ({
  id, seq, channelId, threadId: null, authorId: "brain-1", authorName: "Atlas", authorRole: "brain", body, kind: "chat",
  control: null, mentions: [], createdAt: 1_780_000_000_000 + seq, ...patch,
});
const messages: Record<string, Message[]> = {
  general: [message("m1", 1, "general", "Plan is ready", { reactions: [{ emoji: "👍", count: 1, mine: true }] }),
    message("m2", 2, "general", "Starting the worker")],
  "dm-atlas": [message("d1", 3, "dm-atlas", "Hi")],
  quiet: [],
};

const snapshot = (): Snapshot => ({
  readInstance: "a11y-fixture", readRevision: 0, readSeq: 3, mentionCounts: {}, you: human, projects: [alpha],
  agents: [human, brain], channels: [general, quiet, dm], unread: {}, mentions: [], mentionsHasMore: false, queued: {},
  telegram: { running: false, configured: false },
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type Fixture = { sockets: WebSocketRoute[]; failMessages: boolean; refuseSockets: boolean; holdMentions: Promise<void> | null };

async function install(page: Page, fixture: Partial<Fixture> = {}): Promise<Fixture> {
  const state: Fixture = { sockets: [], failMessages: false, refuseSockets: false, holdMentions: null, ...fixture };
  await page.route("**/api/**", route => json(route, { error: "Unmocked browser fixture request" }, 501));
  await page.route("**/api/ui/session", route => json(route, { ok: true }));
  await page.route("**/api/ui/snapshot", route => json(route, snapshot()));
  await page.route("**/api/ui/read-state", route => json(route, snapshot()));
  await page.route("**/api/ui/read", route => json(route, snapshot()));
  await page.route("**/api/ui/mentions?*", async route => {
    if (state.holdMentions) await state.holdMentions;
    await json(route, { readInstance: "a11y-fixture", readRevision: 0, readSeq: 3, messages: [], hasMore: false })
      .catch(() => undefined);
  });
  const room: RoomView = { room: null, tasks: [], activeTaskCount: 0, tasksHasMore: false, nextTaskCursor: null, links: [],
    unmanagedBots: [] };
  await page.route("**/api/ui/channels/*/room", route => json(route, room));
  await page.route("**/api/ui/adaptive-routing*", route => json(route, { executions: [], events: [], state: null }));
  await page.route("**/api/ui/channels/*/messages*", async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    if (state.failMessages) return json(route, { error: "Fixture load failure" }, 500);
    const ch = [general, quiet, dm].find(item => item.id === id)!;
    const list = messages[id] ?? [];
    const body: ChannelPayload = { channel: ch, threadId: null, messages: list, hasOlder: false, hasNewer: false, threads: [],
      replyCounts: {}, snapshotSeq: 3, cursors: { before: list[0]?.seq, after: list.at(-1)?.seq } };
    await json(route, body);
  });
  let sequence = 0;
  await page.routeWebSocket("**/ws", socket => {
    if (state.refuseSockets) return void socket.close({ code: 1013, reason: "fixture offline" });
    state.sockets.push(socket);
    socket.send(JSON.stringify({ type: "hello", payload: null, streamId: "a11y", sequence: ++sequence }));
  });
  return state;
}

async function expectNoAxeViolations(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map(v => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes.map(n => n.target.join(" ")).slice(0, 3).join(", ")}`))
    .toEqual([]);
}

test("channel, thread-less DM and For you views have no WCAG A/AA axe violations in light and dark", async ({ page }) => {
  await install(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/#/c/general");
    await expect(page.getByText("Starting the worker")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
    await expectNoAxeViolations(page, `${scheme} channel`);
    await page.getByRole("button", { name: "Conversation actions for Atlas" }).click();
    await expectNoAxeViolations(page, `${scheme} DM menu`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "For you" }).click();
    await expect(page.getByText("You're all caught up.")).toBeVisible();
    await expectNoAxeViolations(page, `${scheme} For you`);
  }
});

test("keyboard only: visible focus, sidebar menu with arrows and Escape, current page and composer label", async ({ page }) => {
  await install(page);
  await page.goto("/#/c/general");
  await expect(page.getByText("Starting the worker")).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search projects and messages" });
  await search.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  expect(await search.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");

  await expect(page.getByRole("button", { name: "# general" })).toHaveAttribute("aria-current", "page");
  const kebab = page.getByRole("button", { name: "Conversation actions for Atlas" });
  await kebab.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Conversation actions for Atlas" });
  await expect(menu.getByRole("menuitem", { name: "Close" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(kebab).toBeFocused();

  await page.getByRole("button", { name: "Atlas", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\/dm-atlas$/);
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("Hi");
  const composer = page.getByRole("textbox", { name: "Message Atlas" });
  await composer.focus();
  await expect(page.locator(".composer-box")).toHaveCSS("outline-style", "solid");
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
});

test("the channel shows loading, then an explicit empty state", async ({ page }) => {
  await install(page);
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/ui/channels/quiet/messages*", async route => {
    await held;
    await route.fallback();
  });
  await page.goto("/#/c/quiet");
  await expect(page.getByRole("status").filter({ hasText: "Loading messages…" })).toBeVisible();
  release();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByText("Loading messages…")).toHaveCount(0);
});

test("For you says it is loading instead of all caught up while the unread page is pending", async ({ page }) => {
  let release!: () => void;
  await install(page, { holdMentions: new Promise<void>(done => { release = done; }) });
  await page.goto("/#/inbox/alpha");
  await expect(page.getByText("Loading unread messages…")).toBeVisible();
  await expect(page.getByText("You're all caught up.")).toHaveCount(0);
  release();
  await expect(page.getByText("You're all caught up.")).toBeVisible();
});

test("a load error is an alert with keyboard Retry and Dismiss", async ({ page }) => {
  const state = await install(page, { failMessages: true });
  await page.goto("/#/c/general");
  const alert = page.getByRole("alert").filter({ hasText: "Fixture load failure" });
  await expect(alert).toBeVisible();
  state.failMessages = false;
  await alert.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await expect(alert).toHaveCount(0);
  await expect(page.getByText("Starting the worker")).toBeVisible();

  state.failMessages = true;
  await page.getByRole("button", { name: "# quiet" }).click();
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Dismiss error" }).press("Enter");
  await expect(alert).toHaveCount(0);
});

test("a dropped connection shows a Reconnecting banner until the socket is back", async ({ page }) => {
  const state = await install(page);
  await page.goto("/#/c/general");
  await expect(page.getByText("Starting the worker")).toBeVisible();
  await expect(page.getByRole("img", { name: "Connected" })).toBeVisible();
  await expect(page.getByText(/Reconnecting/)).toHaveCount(0);
  await expect.poll(() => state.sockets.length).toBe(1);
  state.refuseSockets = true;
  await state.sockets[0]!.close({ code: 1013, reason: "fixture drop" });
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Not connected" })).toBeVisible();
  state.refuseSockets = false;
  await expect.poll(() => state.sockets.length, { timeout: 6_000 }).toBe(2);
  await expect(page.getByText(/Reconnecting/)).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Connected" })).toBeVisible();
});
