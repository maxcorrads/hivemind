import { expect, test, type Page, type Route } from "./fixtures.ts";

import type { Agent, Channel, Message, Project } from "../../src/shared/types.ts";
import type { ChannelPayload, Snapshot } from "../../web/api.ts";

// Runs in the "mobile" Playwright project (a phone viewport with touch): the
// one-screen-at-a-time layout with bottom tabs from #223.

const human: Agent = { id: "human", name: "Human", role: "human", seniority: null, focus: null, online: true,
  lastSeenAt: 1, createdAt: 1, projectId: null, project: null };
const alpha: Project = { id: "project-alpha", slug: "alpha", name: "Alpha Hive", worktree: null, createdAt: 1 };
const channel = (id: string, name: string, patch: Partial<Channel> = {}): Channel => ({ id, name, type: "public", topic: null,
  createdBy: "human", createdAt: 1, memberIds: ["human"], projectId: alpha.id, project: alpha.slug, ...patch });
const general = channel("general", "general");
const build = channel("build", "build");
const dm = channel("dm-beacon", "Beacon", { type: "dm", memberIds: ["human", "brain"] });

function message(id: string, seq: number, channelId: string, body: string, threadId: string | null = null): Message {
  return { id, seq, channelId, threadId, authorId: "human", authorName: "Human", authorRole: "human", body, kind: "chat",
    control: null, mentions: [], createdAt: 1_780_000_000_000 + seq };
}

const root = message("root", 1, "build", "Ship the release?");
const reply = message("reply", 2, "build", "Checking the changelog", "root");

function payload(ch: Channel, messages: Message[], extra: Partial<ChannelPayload> = {}): ChannelPayload {
  return { channel: ch, threadId: null, messages, hasOlder: false, hasNewer: false, threads: [], replyCounts: {},
    snapshotSeq: Math.max(0, ...messages.map(m => m.seq)), cursors: { before: messages[0]?.seq, after: messages.at(-1)?.seq },
    ...extra };
}

const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

async function installHive(page: Page) {
  const unexpected: string[] = [];
  page.on("pageerror", error => unexpected.push(error.message));
  const snap: Snapshot = { readInstance: "mobile-fixture", readRevision: 0, readSeq: 3, mentionCounts: { alpha: 2 },
    you: human, projects: [alpha], agents: [human, { ...human, id: "brain", name: "Beacon", role: "worker", projectId: alpha.id,
      project: alpha.slug }], channels: [general, build, dm], unread: { "dm-beacon": 1 }, mentions: [],
    mentionsHasMore: false, queued: {}, telegram: { running: false, configured: false } };
  await page.route("**/api/**", route => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/ui/session", route => json(route, { ok: true }));
  await page.route(/\/api\/ui\/(snapshot|read-state|read)(\?|$)/, route => json(route, snap));
  await page.route("**/api/ui/activity?*", route => json(route, {
    readInstance: "mobile-fixture", readRevision: 0, readSeq: 3, items: [], hasMore: false }));
  await page.route("**/api/ui/nav-status", route => json(route, { agentWork: {} }));
  await page.route("**/api/ui/channels/*/room", route => json(route, { room: null, tasks: [], activeTaskCount: 0,
    tasksHasMore: false, nextTaskCursor: null, links: [], unmanagedBots: [] }));
  await page.route("**/api/ui/channels/*/tasks", route => json(route, { items: [], hasMore: false }));
  await page.route("**/api/ui/channels/*/messages*", route => {
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
    const threadId = url.searchParams.get("threadId");
    const ch = [general, build, dm].find(c => c.id === id)!;
    if (threadId === "root") return json(route, payload(ch, [root, reply], { threadId }));
    return json(route, payload(ch, id === "build" ? [root] : [], { replyCounts: { root: 1 } }));
  });
  await page.routeWebSocket("**/ws", socket => {
    socket.send(JSON.stringify({ type: "hello", payload: null, streamId: "mobile", sequence: 1 }));
  });
  return { unexpected };
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Sections" });

for (const kind of ['root', 'reply', 'system'] as const) {
  test(`the mobile DM unread badge opens and highlights its latest unread ${kind}`, async ({ page }) => {
    const hive = await installHive(page), receipts: number[] = [];
    const threadId = kind === 'reply' ? 'root' : null;
    await page.route('**/api/ui/channels/dm-beacon/last-unread', route =>
      json(route, { target: { channelId: dm.id, threadId, seq: 240 } }));
    await page.route('**/api/ui/channels/dm-beacon/messages*', route => {
      const url = new URL(route.request().url()), before = url.searchParams.get('beforeSeq');
      const requestedThread = url.searchParams.get('threadId');
      const target = { ...message('target', 240, dm.id, 'Mobile unread destination', requestedThread),
        authorId: 'brain', authorName: 'Beacon', authorRole: 'worker' as const,
        kind: kind === 'system' ? 'system' as const : 'chat' as const };
      return json(route, payload(dm, before ? [target] : [], { threadId: requestedThread, hasNewer: Boolean(before) }));
    });
    await page.route('**/api/ui/read', route => {
      receipts.push(...route.request().postDataJSON().messageSeqs);
      return json(route, { readInstance: 'mobile-fixture', readRevision: 1, readSeq: 240,
        unread: { [dm.id]: 0 }, mentionCounts: {} });
    });
    await page.goto('/#/dms/alpha');
    await page.getByRole('button', { name: 'Jump to last unread message in Beacon (1 unread)' }).tap();
    await expect(page).toHaveURL(new RegExp('#/c/dm-beacon' + (threadId ? '/t/root' : '') + '$'));
    const scope = page.locator(threadId ? 'aside.thread' : 'main.desk');
    const target = scope.locator('[data-message-seq="240"]');
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/unread-target/);
    await expect(target).toBeFocused();
    await expect.poll(() => receipts.includes(240)).toBe(true);
    expect(receipts.every(seq => seq === 240)).toBe(true);
    expect(hive.unexpected).toEqual([]);
  });
}

test("a phone starts on Home and opens a channel and a thread full screen, with back arrows", async ({ page }, testInfo) => {
  const hive = await installHive(page);
  await page.goto("/");
  await expect(page).toHaveURL(/#\/home\/alpha$/);
  const rail = page.locator(".rail");
  await expect(rail).toBeVisible();
  await expect(page.locator(".rail > .launch-cta")).toHaveCount(1);
  await expect(page.locator(".rail > .launch-cta")).toBeHidden();
  await expect(tabs(page).getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("mobile-home.png") });

  await rail.getByRole("button", { name: "# build", exact: true }).click();
  await expect(page).toHaveURL(/#\/c\/build$/);
  await expect(page.getByRole("heading", { name: "#build" })).toBeVisible();
  await expect(rail).toBeHidden();
  await expect(tabs(page)).toHaveCount(0);
  const desk = await page.locator(".desk").boundingBox();
  expect(desk!.width).toBe(page.viewportSize()!.width);

  await page.getByRole("button", { name: "1 reply" }).click();
  await expect(page).toHaveURL(/#\/c\/build\/t\/root$/);
  await expect(page.getByText("Checking the changelog", { exact: true })).toBeVisible();
  await expect(page.locator(".desk")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("mobile-thread.png") });

  await page.getByRole("button", { name: "Back to channel" }).click();
  await expect(page).toHaveURL(/#\/c\/build$/);
  await expect(page.locator(".thread")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "#build" })).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/home\/alpha$/);
  await expect(rail).toBeVisible();
  expect(hive.unexpected).toEqual([]);
});

test("the bottom bar has no Decisions tab, and an old Decisions link opens Activity", async ({ page }) => {
  const hive = await installHive(page);
  await page.goto("/#/decisions/alpha");
  await expect(tabs(page).getByRole("button")).toHaveText([/^Home/, /^DMs/, /^Activity/]);
  await expect(tabs(page).getByRole("button", { name: "Activity" })).toHaveAttribute("aria-current", "page");
  expect(hive.unexpected).toEqual([]);
});

test("DMs and Activity tabs list the project's conversations and its For you view", async ({ page }) => {
  const hive = await installHive(page);
  await page.goto("/#/home/alpha");
  await expect(tabs(page).getByRole("button", { name: "DMs 1" })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Activity 2" })).toBeVisible();

  await tabs(page).getByRole("button", { name: /DMs/ }).click();
  await expect(page).toHaveURL(/#\/dms\/alpha$/);
  await expect(page.locator(".rail")).toBeHidden();
  await page.locator(".desk").getByRole("button", { name: "Beacon", exact: true }).click();
  await expect(page).toHaveURL(/#\/c\/dm-beacon$/);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/dms\/alpha$/);

  await tabs(page).getByRole("button", { name: /Activity/ }).click();
  await expect(page).toHaveURL(/#\/inbox\/alpha$/);
  await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: /Activity/ })).toHaveAttribute("aria-current", "page");
  expect(hive.unexpected).toEqual([]);
});

test("the phone-only list routes fall back to For you on a wide screen", async ({ page }) => {
  const hive = await installHive(page);
  await page.goto("/#/dms/alpha");
  await expect(page.getByRole("heading", { name: "Direct messages" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page).toHaveURL(/#\/inbox\/alpha$/);
  await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
  await expect(tabs(page)).toBeHidden();
  await expect(page.locator(".rail")).toBeVisible();
  expect(hive.unexpected).toEqual([]);
});
