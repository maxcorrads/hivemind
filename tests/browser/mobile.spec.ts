import { expect, test, type Page, type Route } from "./fixtures.ts";

import type { Agent, Channel, Message, Project } from "../../src/shared/types.ts";
import type { DecisionView } from "../../src/shared/decisions.ts";
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
const decisionRoot = message("decision", 3, "build", "Decision needed");

function decision(patch: Partial<DecisionView> = {}): DecisionView {
  return { id: "decision", projectId: alpha.id, channelId: "build", taskId: "task", taskRevision: 1, requesterId: "brain",
    requesterName: "Beacon", revision: 1, storedState: "awaiting_input", state: "awaiting_input",
    question: "Which release train?", options: [{ id: "a", label: "Friday", impact: "Short QA window" }],
    recommendation: null, evidenceSeqs: [], artifacts: [], affectedWorkers: [], requestedByAt: null,
    relatedDecisionIds: [], supersedesDecisionId: null, supersededByDecisionId: null, rootSeq: 3, createdAt: 1, updatedAt: 1,
    answer: null, withdrawn: null, currentTaskRevision: 1, staleReason: null, delivery: [], warning: "", ...patch };
}

function payload(ch: Channel, messages: Message[], extra: Partial<ChannelPayload> = {}): ChannelPayload {
  return { channel: ch, threadId: null, messages, hasOlder: false, hasNewer: false, threads: [], replyCounts: {},
    snapshotSeq: Math.max(0, ...messages.map(m => m.seq)), cursors: { before: messages[0]?.seq, after: messages.at(-1)?.seq },
    ...extra };
}

const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

async function installHive(page: Page) {
  const unexpected: string[] = [];
  const answers: unknown[] = [];
  page.on("pageerror", error => unexpected.push(error.message));
  let current = decision();
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
  await page.route("**/api/ui/mentions?*", route => json(route, {
    readInstance: "mobile-fixture", readRevision: 0, readSeq: 3, messages: [], hasMore: false }));
  await page.route("**/api/ui/channels/*/room", route => json(route, { room: null, tasks: [], activeTaskCount: 0,
    tasksHasMore: false, nextTaskCursor: null, links: [], unmanagedBots: [] }));
  await page.route("**/api/ui/channels/*/messages*", route => {
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
    const threadId = url.searchParams.get("threadId");
    const ch = [general, build, dm].find(c => c.id === id)!;
    if (threadId === "root") return json(route, payload(ch, [root, reply], { threadId }));
    if (threadId === "decision") return json(route, payload(ch, [decisionRoot], { threadId, decision: current }));
    return json(route, payload(ch, id === "build" ? [root, decisionRoot] : [], { replyCounts: { root: 1 } }));
  });
  await page.route("**/api/ui/decisions?*", route => json(route, { items: [current], awaiting: 1, warning: "" }));
  await page.route("**/api/ui/decisions/*/answer", route => {
    answers.push(route.request().postDataJSON());
    current = decision({ state: "answered", storedState: "answered", revision: 2,
      answer: { messageId: "answer", seq: 4, body: "a: Friday", at: 2, source: "hive" } });
    return json(route, { decision: current, message: message("answer", 4, "build", "a: Friday", "decision"), duplicate: false });
  });
  await page.routeWebSocket("**/ws", socket => {
    socket.send(JSON.stringify({ type: "hello", payload: null, streamId: "mobile", sequence: 1 }));
  });
  return { unexpected, answers };
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Sections" });

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

test("the Decisions tab answers a decision and its thread returns through the back arrows", async ({ page }) => {
  const hive = await installHive(page);
  await page.goto("/#/home/alpha");
  await tabs(page).getByRole("button", { name: "Decisions" }).click();
  await expect(page).toHaveURL(/#\/decisions\/alpha$/);
  await expect(tabs(page).getByRole("button", { name: "Decisions" })).toHaveAttribute("aria-current", "page");
  const card = page.getByRole("region", { name: "Human decision request" });
  await card.getByRole("button", { name: /Friday/ }).click();
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card.getByText("answered", { exact: true })).toBeVisible();
  expect(hive.answers).toEqual([expect.objectContaining({ expectedRevision: 1, body: "a: Friday" })]);

  await card.getByRole("button", { name: "Open decision thread" }).click();
  await expect(page).toHaveURL(/#\/c\/build\/t\/decision$/);
  await expect(page.locator(".thread").getByText("Which release train?")).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Back to channel" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/decisions\/alpha$/);
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
  await page.locator(".desk").getByRole("button", { name: "Beacon 1" }).click();
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
