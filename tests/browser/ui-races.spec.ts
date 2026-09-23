import { expect, test, type Page, type Route, type WebSocketRoute } from "./fixtures.ts";

import type { Agent, Channel, Message, Project, Thread } from "../../src/shared/types.ts";
import type { ChannelPayload, Snapshot } from "../../web/api.ts";
import type { RoomView } from "../../src/shared/rooms.ts";

type Harness = { seq: number; revision: number; receipts: number[][]; unexpected: string[]; errors: string[] };
const harnesses = new WeakMap<Page, Harness>();

test.beforeEach(async ({ page }) => {
  const harness: Harness = { seq: 0, revision: 0, receipts: [], unexpected: [], errors: [] };
  harnesses.set(page, harness);
  page.on("pageerror", error => harness.errors.push(error.message));
  // Unexpected UI requests must fail the test, not accidentally reach a live hive.
  await page.route("**/api/**", async route => {
    harness.unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await fulfillJson(route, { error: "Unmocked browser fixture request" }, 501);
  });
});

test.afterEach(async ({ page }) => {
  const harness = harnesses.get(page)!;
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(harness.unexpected, "Unexpected API requests").toEqual([]);
  expect(harness.errors, "Uncaught browser errors").toEqual([]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const human: Agent = {
  id: "human",
  name: "Human",
  role: "human",
  seniority: null,
  focus: null,
  online: true,
  lastSeenAt: 1,
  createdAt: 1,
  projectId: null,
  project: null,
};

function project(slug: string, name: string): Project {
  return { id: `project-${slug}`, slug, name, worktree: null, createdAt: 1 };
}

function channel(id: string, name: string, p: Project): Channel {
  return {
    id,
    name,
    type: "public",
    topic: null,
    createdBy: "human",
    createdAt: 1,
    memberIds: ["human"],
    projectId: p.id,
    project: p.slug,
  };
}

function message(
  id: string,
  seq: number,
  channelId: string,
  body: string,
  threadId: string | null = null,
  patch: Partial<Message> = {},
): Message {
  return {
    id,
    seq,
    channelId,
    threadId,
    authorId: "human",
    authorName: "Human",
    authorRole: "human",
    body,
    kind: "chat",
    control: null,
    mentions: [],
    createdAt: 1_780_000_000_000 + seq,
    ...patch,
  };
}

function payload(ch: Channel, messages: Message[], threads: Thread[] = [], replyCounts: Record<string, number> = {}): ChannelPayload {
  return { channel: ch, threadId: messages.find(message => message.threadId)?.threadId ?? null,
    messages, hasOlder: false, hasNewer: false, threads, replyCounts,
    snapshotSeq: Math.max(0, ...messages.map(message => message.seq)),
    cursors: { before: messages[0]?.seq, after: messages.at(-1)?.seq } };
}

function snapshot(projects: Project[], channels: Channel[]): Snapshot {
  return {
    readInstance: "browser-fixture", readRevision: 0, readSeq: 0, mentionCounts: {},
    you: human,
    projects,
    agents: [human],
    channels,
    unread: {},
    mentions: [],
    mentionsHasMore: false,
    queued: {},
    telegram: { running: false, configured: false },
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  const harness = harnesses.get(route.request().frame().page());
  if (harness && body && typeof body === "object") {
    const data = body as { messages?: Message[]; message?: Message };
    for (const message of [...(data.messages ?? []), ...(data.message ? [data.message] : [])])
      harness.seq = Math.max(harness.seq, message.seq);
  }
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installSnapshot(page: Page, current: () => Snapshot) {
  const harness = harnesses.get(page)!;
  const reads = () => ({ ...current(), readSeq: harness.seq, readRevision: harness.revision });
  await page.route("**/api/ui/session", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-hivemind-ui"]).toBe("1");
    await fulfillJson(route, { ok: true });
  });
  await page.route("**/api/ui/snapshot", async route => fulfillJson(route, reads()));
  await page.route("**/api/ui/read-state", async route => fulfillJson(route, reads()));
  await page.route("**/api/ui/read", async route => {
    const receipt = route.request().postDataJSON() as { messageSeqs: number[] };
    harness.receipts.push(receipt.messageSeqs);
    harness.revision++;
    await fulfillJson(route, reads());
  });
  await page.route("**/api/ui/mentions?*", async route => fulfillJson(route, {
    readInstance: "browser-fixture", readRevision: harness.revision, readSeq: harness.seq,
    messages: [], hasMore: false,
  }));
  const room: RoomView = { room: null, tasks: [], activeTaskCount: 0, tasksHasMore: false,
    nextTaskCursor: null, links: [], unmanagedBots: [] };
  await page.route("**/api/ui/channels/*/room", async route => fulfillJson(route, room));
}

async function installMessages(
  page: Page,
  handler: (route: Route, channelId: string, threadId: string | null) => Promise<void>,
) {
  await page.route("**/api/ui/channels/*/messages*", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    const channelId = decodeURIComponent(parts.at(-2) ?? "");
    await handler(route, channelId, url.searchParams.get("threadId"));
  });
}

type FixtureSocket = Pick<WebSocketRoute, "close"> & { send: (data: string) => void };

async function installSocketHarness(page: Page) {
  const sockets: FixtureSocket[] = [];
  const harness = harnesses.get(page)!;
  let sequence = 0;
  await page.routeWebSocket("**/ws", socket => {
    const wrapped: FixtureSocket = {
      close: options => socket.close(options),
      send: data => {
        const event = JSON.parse(data) as { type: string; payload?: Message | { message?: Message } };
        if (event.payload && "seq" in event.payload) harness.seq = Math.max(harness.seq, event.payload.seq);
        if (event.payload && "message" in event.payload && event.payload.message)
          harness.seq = Math.max(harness.seq, event.payload.message.seq);
        socket.send(JSON.stringify({ ...event, streamId: "browser-stream", sequence: ++sequence }));
      },
    };
    sockets.push(wrapped);
    wrapped.send(JSON.stringify({ type: "hello", payload: null }));
  });
  return sockets;
}

test("slow channel A cannot overwrite channel B after navigation", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive");
  const a = channel("a", "Alpha", alpha);
  const b = channel("b", "Beta", alpha);
  let snap = snapshot([alpha], [a, b]);
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);

  const aRequested = deferred();
  const releaseA = deferred();
  await installMessages(page, async (route, channelId, threadId) => {
    expect(threadId).toBeNull();
    if (channelId === "a") {
      aRequested.resolve();
      await releaseA.promise;
      try {
        await fulfillJson(route, payload(a, [message("a1", 1, "a", "stale alpha body")]));
      } catch {
        // Navigation is expected to abort this request.
      }
      return;
    }
    if (channelId === "b") {
      await fulfillJson(route, payload(b, [message("b1", 2, "b", "current beta body")]));
      return;
    }
    await fulfillJson(route, { error: "missing" }, 404);
  });

  await page.goto("/#/c/a");
  await aRequested.promise;
  await page.getByRole("button", { name: "# Beta" }).click();
  await expect(page.getByRole("heading", { name: "#Beta" })).toBeVisible();
  await expect(page.getByText("current beta body", { exact: true })).toBeVisible();

  releaseA.resolve();
  await expect(page.getByRole("heading", { name: "#Beta" })).toBeVisible();
  await expect(page.getByText("stale alpha body", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "# Beta" })).toHaveClass(/active/);
});

test("slow thread response cannot overwrite a newer thread selection", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive");
  const a = channel("a", "Alpha", alpha);
  const root1 = message("root-1", 1, "a", "root one");
  const root2 = message("root-2", 2, "a", "root two");
  let snap = snapshot([alpha], [a]);
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);

  const firstThreadRequested = deferred();
  const releaseFirstThread = deferred();
  await installMessages(page, async (route, channelId, threadId) => {
    expect(channelId).toBe("a");
    if (!threadId) {
      await fulfillJson(
        route,
        payload(
          a,
          [root1, root2],
          [
            { id: root1.id, channelId: "a", status: "open" },
            { id: root2.id, channelId: "a", status: "open" },
          ],
        ),
      );
      return;
    }
    if (threadId === root1.id) {
      firstThreadRequested.resolve();
      await releaseFirstThread.promise;
      try {
        await fulfillJson(
          route,
          payload(a, [root1, message("reply-1", 3, "a", "stale thread one reply", root1.id)], [
            { id: root1.id, channelId: "a", status: "open" },
          ]),
        );
      } catch {
        // Switching threads aborts the first request.
      }
      return;
    }
    if (threadId === root2.id) {
      await fulfillJson(
        route,
        payload(a, [root2, message("reply-2", 4, "a", "current thread two reply", root2.id)], [
          { id: root2.id, channelId: "a", status: "in_progress" },
        ]),
      );
      return;
    }
    await fulfillJson(route, { error: "missing" }, 404);
  });

  await page.goto("/#/c/a/t/root-1");
  await firstThreadRequested.promise;
  await page.evaluate(() => {
    location.hash = "#/c/a/t/root-2";
  });
  await expect(page.getByText("current thread two reply", { exact: true })).toBeVisible();

  releaseFirstThread.resolve();
  await expect(page.getByText("current thread two reply", { exact: true })).toBeVisible();
  await expect(page.getByText("stale thread one reply", { exact: true })).toHaveCount(0);
  await expect(page.locator("aside.thread select")).toHaveValue("in_progress");
});

test("reconnect converges open channel and thread after missed message reaction and status events", async ({ page }) => {
  await page.clock.install();
  const alpha = project("alpha", "Alpha Hive");
  const a = channel("a", "Alpha", alpha);
  const root = message("root", 1, "a", "root message");
  const reply1 = message("reply-1", 2, "a", "reply before disconnect", root.id);
  let snap = snapshot([alpha], [a]);
  let channelData = payload(a, [root], [{ id: root.id, channelId: "a", status: "open" }], { [root.id]: 1 });
  let threadData = payload(a, [root, reply1], [{ id: root.id, channelId: "a", status: "open" }]);
  let delayReconnectChannel = false;
  const reconnectChannelRequested = deferred();
  const releaseReconnectChannel = deferred();

  await installSnapshot(page, () => snap);
  await installMessages(page, async (route, channelId, threadId) => {
    expect(channelId).toBe("a");
    if (!threadId && delayReconnectChannel) {
      const stale = channelData;
      reconnectChannelRequested.resolve();
      await releaseReconnectChannel.promise;
      await fulfillJson(route, stale);
      return;
    }
    await fulfillJson(route, threadId ? threadData : channelData);
  });
  const sockets = await installSocketHarness(page);

  await page.goto("/#/c/a/t/root");
  await expect(page.getByText("reply before disconnect", { exact: true })).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);

  sockets[0]!.send(
    JSON.stringify({
      type: "thread",
      payload: { id: root.id, channelId: "a", status: "blocked" },
    }),
  );
  await expect(page.locator("aside.thread select")).toHaveValue("blocked");

  const updatedRoot = { ...root, reactions: [{ emoji: "✅", count: 1 }] };
  const missed = message("missed", 3, "a", "missed while websocket was down");
  const reply2 = message("reply-2", 4, "a", "thread reply missed while disconnected", root.id);
  channelData = payload(
    a,
    [updatedRoot, missed],
    [{ id: root.id, channelId: "a", status: "done" }],
    { [root.id]: 2 },
  );
  threadData = payload(
    a,
    [updatedRoot, reply1, reply2],
    [{ id: root.id, channelId: "a", status: "done" }],
  );

  delayReconnectChannel = true;
  await sockets[0]!.close({ code: 1013, reason: "client too slow; reconnect to resync" });
  await page.clock.runFor(1_600);
  await expect.poll(() => sockets.length).toBe(2);
  await reconnectChannelRequested.promise;

  // Interleave a live event after reconnect but before the stale channel
  // reconciliation response is released. The late snapshot must replay it
  // instead of overwriting the event.
  const liveDuringRefresh = message("live-during-refresh", 5, "a", "live during reconnect refresh");
  channelData = payload(
    a,
    [updatedRoot, missed, liveDuringRefresh],
    [{ id: root.id, channelId: "a", status: "done" }],
    { [root.id]: 2 },
  );
  sockets[1]!.send(JSON.stringify({ type: "message", payload: liveDuringRefresh }));
  await expect(page.getByText("live during reconnect refresh", { exact: true })).toBeVisible();
  releaseReconnectChannel.resolve();

  await expect(page.getByText("missed while websocket was down", { exact: true })).toBeVisible();
  await expect(page.getByText("live during reconnect refresh", { exact: true })).toBeVisible();
  await expect(page.getByText("thread reply missed while disconnected", { exact: true })).toBeVisible();
  await expect(page.locator("aside.thread select")).toHaveValue("done");
  await expect(page.locator("aside.thread .react").filter({ hasText: "✅" })).toHaveCount(1);
});

test("HTTP-confirmed send appears without WebSocket echo and stays single after echo plus reconnect", async ({ page }) => {
  await page.clock.install();
  const alpha = project("alpha", "Alpha Hive");
  const a = channel("a", "Alpha", alpha);
  let snap = snapshot([alpha], [a]);
  let messages: Message[] = [];
  await installSnapshot(page, () => snap);

  await page.route("**/api/ui/channels/a/messages*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { body: string };
      const sent = message("sent-1", 10, "a", body.body);
      messages = [sent];
      await fulfillJson(route, { message: sent });
      return;
    }
    await fulfillJson(route, payload(a, messages));
  });

  const sockets = await installSocketHarness(page);

  await page.goto("/#/c/a");
  await expect.poll(() => sockets.length).toBe(1);
  const composer = page.getByPlaceholder("Message #Alpha");
  await composer.fill("sent without websocket echo");
  await composer.press("Enter");

  await expect(page.getByText("sent without websocket echo", { exact: true })).toHaveCount(1);
  sockets[0]!.send(JSON.stringify({ type: "message", payload: messages[0] }));
  await expect(page.getByText("sent without websocket echo", { exact: true })).toHaveCount(1);

  await sockets[0]!.close({ code: 1001, reason: "replay reconnect" });
  await page.clock.runFor(1_600);
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.getByText("sent without websocket echo", { exact: true })).toHaveCount(1);
});

test("selected channel is discarded when its project disappears during an in-flight load", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive");
  const beta = project("beta", "Beta Hive");
  const a = channel("a", "Alpha", alpha);
  const b = channel("b", "Beta", beta);
  let snap = snapshot([alpha, beta], [a, b]);
  await installSnapshot(page, () => snap);

  const aRequested = deferred();
  const releaseA = deferred();
  await installMessages(page, async (route, channelId, threadId) => {
    expect(threadId).toBeNull();
    if (channelId === "a") {
      aRequested.resolve();
      await releaseA.promise;
      try {
        await fulfillJson(route, payload(a, [message("stale", 1, "a", "stale deleted-project content")]));
      } catch {
        // Project removal aborts the selected conversation request.
      }
      return;
    }
    if (channelId === "b") {
      await fulfillJson(route, payload(b, [message("b", 2, "b", "beta content")]));
      return;
    }
    await fulfillJson(route, { error: "missing" }, 404);
  });
  const sockets = await installSocketHarness(page);

  await page.goto("/#/c/a");
  await aRequested.promise;
  await expect.poll(() => sockets.length).toBe(1);

  snap = snapshot([beta], [b]);
  sockets[0]!.send(JSON.stringify({ type: "project", payload: { deleted: "alpha" } }));
  await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
  await expect(page).toHaveURL(/#\/inbox\/beta$/);

  releaseA.resolve();
  await expect(page.getByText("stale deleted-project content", { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Message #Alpha")).toHaveCount(0);
});


test("selected channel removal repairs to a valid state without stale content", async ({ page }) => {
  await page.clock.install();
  const alpha = project("alpha", "Alpha Hive");
  const a = channel("a", "Alpha", alpha);
  const b = channel("b", "Beta", alpha);
  let snap = snapshot([alpha], [a, b]);
  await installSnapshot(page, () => snap);
  await installMessages(page, async (route, channelId, threadId) => {
    expect(threadId).toBeNull();
    if (channelId === "a") {
      await fulfillJson(route, payload(a, [message("a1", 1, "a", "channel that will disappear")]));
      return;
    }
    if (channelId === "b") {
      await fulfillJson(route, payload(b, [message("b1", 2, "b", "surviving channel")]));
      return;
    }
    await fulfillJson(route, { error: "missing" }, 404);
  });
  const sockets = await installSocketHarness(page);

  await page.goto("/#/c/a");
  await expect(page.getByText("channel that will disappear", { exact: true })).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);

  snap = snapshot([alpha], [b]);
  await sockets[0]!.close({ code: 1013, reason: "controlled resync" });
  await page.clock.runFor(1_600);
  await expect.poll(() => sockets.length).toBe(2);

  await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
  await expect(page).toHaveURL(/#\/inbox\/alpha$/);
  await expect(page.getByText("channel that will disappear", { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Message #Alpha")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "# Beta" })).toBeVisible();
});

test("live status survives a delayed first thread snapshot and ignores another thread", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive"), a = channel("a", "Alpha", alpha);
  const root = message("root", 1, "a", "thread root");
  const reply = message("reply", 2, "a", "loaded thread reply", root.id);
  const threads: Thread[] = [{ id: root.id, channelId: a.id, status: "open" }];
  await installSnapshot(page, () => snapshot([alpha], [a]));
  const requested = deferred(), release = deferred();
  await installMessages(page, async (route, _channelId, threadId) => {
    if (!threadId) return fulfillJson(route, payload(a, [root], threads));
    requested.resolve();
    await release.promise;
    await fulfillJson(route, payload(a, [root, reply], threads));
  });
  const sockets = await installSocketHarness(page);
  await page.goto("/#/c/a/t/root");
  await requested.promise;
  await expect.poll(() => sockets.length).toBe(1);
  await expect(page.locator("main .st")).toHaveText("open");
  sockets[0]!.send(JSON.stringify({ type: "thread", payload: { ...threads[0], status: "blocked" } }));
  sockets[0]!.send(JSON.stringify({ type: "thread", payload: { id: "other", channelId: "a", status: "done" } }));
  // A visible root badge acknowledges processing before the delayed HTTP result.
  await expect(page.locator("main .st")).toHaveText("blocked");
  release.resolve();
  await expect(page.getByText("loaded thread reply", { exact: true })).toBeVisible();
  await expect(page.locator("aside.thread select")).toHaveValue("blocked");
});

for (const inThread of [false, true]) {
  test(`older history preserves a real scroll anchor and text selection under live arrivals (thread=${inThread})`, async ({ page }) => {
    await page.clock.install();
    const alpha = project("alpha", "Alpha Hive"), a = channel("a", "Alpha", alpha);
    const root = message("root", 1, "a", "history root");
    const threadId = inThread ? root.id : null;
    const row = (seq: number) => message(`history-${seq}`, seq, a.id, `reading-anchor-${seq}`, threadId, {
      authorId: "reader-agent", authorName: "Reader", authorRole: "brain",
    });
    let through = 580;
    const full = () => Array.from({ length: through }, (_, i) => row(i + 1));
    const threads: Thread[] = [{ id: root.id, channelId: a.id, status: "open" }];
    await installSnapshot(page, () => snapshot([alpha], [a]));
    await installMessages(page, async (route, _channelId, requestedThread) => {
      if (inThread && !requestedThread) return fulfillJson(route, payload(a, [root], threads));
      const before = Number(new URL(route.request().url()).searchParams.get("beforeSeq"));
      const messages = before ? full().filter(m => m.seq < before) : full().slice(-500);
      await fulfillJson(route, { ...payload(a, messages, threads), threadId,
        hasOlder: !before, snapshotSeq: through, cursors: { before: messages[0]?.seq, after: through } });
    });
    const sockets = await installSocketHarness(page);
    await page.goto(inThread ? "/#/c/a/t/root" : "/#/c/a");
    const scope = page.locator(inThread ? "aside.thread" : "main");
    await expect(scope.locator(".msg-b")).toHaveCount(500);
    await scope.getByRole("button", { name: inThread ? "Load earlier replies" : "Load older", exact: true }).click();
    await expect(scope.locator(".msg-b")).toHaveCount(580);
    const anchor = scope.getByText("reading-anchor-40", { exact: true });
    await anchor.scrollIntoViewIfNeeded();
    const handle = await anchor.elementHandle();
    expect(handle).not.toBeNull();
    await anchor.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
    });
    const before = await anchor.evaluate(el => el.getBoundingClientRect().top);
    await page.clock.runFor(20);
    through = 582;
    for (const seq of [581, 581, 582]) sockets[0]!.send(JSON.stringify({ type: "message", payload: row(seq) }));
    const refresh = scope.getByRole("button", { name: inThread ? "New replies — refresh thread" : "New messages — return to live", exact: true });
    await expect(refresh).toBeVisible();
    await expect(scope.locator(".msg-b")).toHaveCount(580);
    expect(await handle!.evaluate(el => el.isConnected && window.getSelection()?.toString() === el.textContent)).toBe(true);
    expect(Math.abs(await anchor.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1);
    await page.clock.runFor(20);
    const seen = harnesses.get(page)!.receipts.flat();
    expect(seen).not.toContain(581); expect(seen).not.toContain(582);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await refresh.click();
    await expect(scope.getByText("reading-anchor-582", { exact: true })).toBeVisible();
    await expect(scope.locator(".msg-b")).toHaveCount(500);
  });
}

test("agent roster stays readable in a narrow sidebar and keeps actions scoped", async ({ page }, testInfo) => {
  const alpha = project("alpha", "Example Hive");
  const a = channel("a", "General", alpha);
  const snap = snapshot([alpha], [a]);
  const agent = (id: string, name: string, role: Agent["role"], patch: Partial<Agent> = {}): Agent => ({
    ...human, id, name, role, projectId: alpha.id, project: alpha.slug, ...patch,
  });
  snap.agents.push(agent("brain", "Beacon", "brain"),
    agent("worker", "LongWorkerNameForLayout", "worker", { seniority: "senior", focus: "Frontend and accessibility" }),
    agent("bot", "BuildFeed", "bot"));
  snap.inbox = { brain: { awaitingReceipt: 0, acknowledgedMessages: 7, lastAcknowledgedAt: 1 },
    worker: { awaitingReceipt: 12, acknowledgedMessages: 24, lastAcknowledgedAt: 1, queued: { atLeast: 120, exact: false } } };
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);
  await installMessages(page, async route => fulfillJson(route, payload(a, [])));
  await page.goto("/#/c/a");
  const row = page.locator(".person").filter({ has: page.getByRole("button", { name: "Actions for LongWorkerNameForLayout", exact: true }) });
  await expect(row).toBeVisible();
  await expect(page.getByText("Credentials", { exact: true })).toHaveCount(0);
  for (const width of [260, 300]) {
    await page.addStyleTag({ content: `.shell { grid-template-columns: ${width}px minmax(0, 1fr); }` });
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
      const issues = await page.locator(".agents").evaluate(container => {
        const failures: string[] = [];
        for (const item of container.querySelectorAll<HTMLElement>(".person")) {
          const main = item.querySelector<HTMLElement>(".person-main")!;
          const action = item.querySelector<HTMLElement>(".kebab");
          if (item.scrollWidth > item.clientWidth + 1) failures.push("row overflows");
          if (main.scrollWidth > main.clientWidth + 1) failures.push("content overflows");
          if (action && main.getBoundingClientRect().right > action.getBoundingClientRect().left + 1) failures.push("action overlaps");
          const label = item.querySelector<HTMLElement>(".person-label")!;
          for (const detail of item.querySelectorAll<HTMLElement>(".person-meta, .inbox-receipt:not(:empty)")) {
            if (detail.getBoundingClientRect().top < label.getBoundingClientRect().bottom - 1) failures.push("details overlap name");
          }
        }
        return failures;
      });
      expect(issues).toEqual([]);
      await page.locator(".agents").screenshot({ path: testInfo.outputPath(`roster-${width}-${dark ? "dark" : "light"}.png`) });
    }
  }
  const action = row.getByRole("button", { name: "Actions for LongWorkerNameForLayout", exact: true });
  await action.click();
  const menu = row.getByRole("menu");
  // Workers have no credentials to manage: the menu starts at Clear context.
  await expect(menu.getByRole("menuitem", { name: "Manage credentials for LongWorkerNameForLayout" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Clear context", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Remove", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(action).toBeFocused();
  await action.click();
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remove LongWorkerNameForLayout", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toBeVisible();
});

test("settings stay inside the viewport and backdrop dismissal requires a complete click", async ({ page }, testInfo) => {
  const alpha = project("alpha", "Example Hive"), a = channel("a", "General", alpha);
  const snap = snapshot([alpha, project("beta", "Second Hive")], [a]);
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);
  await installMessages(page, async route => fulfillJson(route, payload(a, [])));
  await page.route("**/api/ui/adaptive-routing", route => fulfillJson(route, {
    enabled: false, apiKeySet: false, apiKeyHint: null, model: "jev-latest", fallback: "orchestrated", topologyFallback: "brain_one_worker",
  }));
  await page.route("**/api/ui/telegram", route => fulfillJson(route, {
    configured: false, running: false, tokenSet: false, tokenHint: null, allowUserIds: [], projects: {},
  }));
  await page.route("**/api/ui/launch-context?*", route => fulfillJson(route, {
    project: { id: alpha.id, slug: alpha.slug }, plugins: [], pluginInstructions: "",
    hivemindMcp: { command: "hivemind", args: ["mcp"], env: {} },
  }));
  await page.setViewportSize({ width: 1180, height: 700 });
  await page.goto("/#/c/a");
  for (const title of ["Adaptive routing", "Telegram", "Launch agent"]) {
    await page.locator(".tools-menu > summary").click();
    await page.getByTitle(title, { exact: true }).click();
    const modal = page.locator(".modal"), sheet = modal.locator(".sheet");
    await expect(sheet).toBeVisible();
    const bounds = await sheet.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${title.replaceAll(" ", "-")}.png`) });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const mobile = await sheet.boundingBox();
    expect(mobile!.x).toBeGreaterThanOrEqual(0);
    expect(mobile!.x + mobile!.width).toBeLessThanOrEqual(390);
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${title.replaceAll(" ", "-")}-mobile.png`) });
    await page.setViewportSize({ width: 1180, height: 700 });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    const heading = await sheet.locator("h2").boundingBox();
    await page.mouse.move(heading!.x + 12, heading!.y + 10);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 8 });
    await page.mouse.up();
    await expect(sheet).toBeVisible();
    // Dragging on the backdrop is not a tap either.
    await page.mouse.move(5, 5); await page.mouse.down();
    await page.mouse.move(5, 80, { steps: 4 }); await page.mouse.up();
    await expect(sheet).toBeVisible();
    await page.mouse.click(6, 6);
    await expect(modal).toHaveCount(0);
  }
});

test("direct conversations, inbox receipts and compact routing remain independent", async ({ page }, testInfo) => {
  const alpha = project("alpha", "Example Hive");
  const dm = { ...channel("dm", "Human · Beacon", alpha), type: "dm" as const, memberIds: ["human", "brain"] };
  const peers = { ...channel("peers", "Beacon · Helper", alpha), type: "dm" as const, memberIds: ["brain", "worker"] };
  const snap = snapshot([alpha], [dm, peers]);
  snap.agents.push({ ...human, id: "brain", name: "Beacon", role: "brain", project: alpha.slug, projectId: alpha.id });
  const direct = message("direct", 1, dm.id, "A direct update. ".repeat(50), null, { authorId: "brain", authorName: "Beacon", authorRole: "brain", mentions: ["human"] });
  const mentioned = message("mention", 2, peers.id, "An update mentioning @Human.", null, { authorId: "brain", authorName: "Beacon", authorRole: "brain", mentions: ["human"] });
  snap.mentions = [mentioned, direct]; snap.mentionCounts = { alpha: 2 }; snap.unread = { dm: 1, peers: 1 };
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);
  await installMessages(page, async (route, id) => fulfillJson(route, payload(id === "dm" ? dm : peers, [id === "dm" ? direct : mentioned])));
  await page.route("**/api/ui/mentions?*", route => fulfillJson(route, {
    readInstance: "browser-fixture", readRevision: harnesses.get(page)!.revision, readSeq: 2,
    messages: [mentioned, direct].filter(m => !harnesses.get(page)!.receipts.flat().includes(m.seq)), hasMore: false,
  }));
  await page.route("**/api/ui/channels/*/adaptive-routing", route => fulfillJson(route, { state: null, events: [] }));
  await page.goto("/#/c/dm");
  await expect(page.locator(".with-human")).toBeVisible();
  await expect(page.locator(".between-agents")).not.toBeVisible();
  const routing = page.getByLabel("Message routing options");
  await expect(routing).toHaveText("Auto · Jev");
  await page.locator(".composer").screenshot({ path: testInfo.outputPath("composer-auto.png") });
  const pill = await routing.boundingBox(); expect(pill!.height).toBeLessThan(40);
  await routing.click();
  await page.getByLabel("Execution mode", { exact: true }).selectOption("brain_one_worker");
  await page.getByLabel("Routing lock scope", { exact: true }).selectOption("task");
  await routing.click();
  await expect(routing).toContainText("Brain + 1");
  await expect(routing).toContainText("task lock");
  await page.locator(".composer").screenshot({ path: testInfo.outputPath("composer.png") });
  await page.getByRole("button", { name: /^For you/ }).click();
  // Channel reading already acknowledged the direct message; test only the remaining mention.
  await expect(page.locator(".inbox-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Mentions elsewhere", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveClass(/expanded/);
  await page.screenshot({ path: testInfo.outputPath("for-you.png") });
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(0);
  expect(harnesses.get(page)!.receipts.some(receipt => receipt.length === 1 && receipt[0] === 2)).toBe(true);
});

for (const inThread of [false, true]) {
  test(`sending while reading history returns to the confirmed message without websocket echo (thread=${inThread})`, async ({ page }) => {
    const alpha = project("alpha", "Alpha Hive"), a = channel("a", "Alpha", alpha);
    const root = message("root", 1, a.id, "A root for the conversation");
    const threadId = inThread ? root.id : null;
    let messages = Array.from({ length: 40 }, (_, index) => message(`old-${index}`, index + 2, a.id,
      `History ${index}: ${"A longer message for scrolling. ".repeat(8)}`, threadId));
    const threads: Thread[] = [{ id: root.id, channelId: a.id, status: "open" }];
    await installSnapshot(page, () => snapshot([alpha], [a]));
    await installSocketHarness(page);
    await page.route("**/api/ui/channels/a/messages*", async route => {
      const requestedThread = new URL(route.request().url()).searchParams.get("threadId");
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { body: string; threadId: string | null };
        expect(body.threadId).toBe(threadId);
        const missed = message("missed-before-send", 100, a.id, "Previously unseen message", threadId);
        const sent = message("confirmed", 101, a.id, body.body, threadId);
        messages = [...messages, missed, sent];
        return fulfillJson(route, { message: sent });
      }
      if (inThread && !requestedThread) return fulfillJson(route, payload(a, [root], threads));
      return fulfillJson(route, { ...payload(a, messages, threads), threadId });
    });
    await page.goto(inThread ? "/#/c/a/t/root" : "/#/c/a");
    const scope = page.locator(inThread ? "aside.thread" : "main");
    await expect(scope.locator(".msg")).toHaveCount(40);
    const stream = scope.locator(".stream");
    await stream.evaluate(element => { element.scrollTop = 0; });
    await expect(scope.getByRole("button", { name: inThread ? "Refresh thread" : "Return to live", exact: true })).toBeVisible();
    const composer = scope.locator(".composer textarea");
    await composer.fill("My confirmed message");
    await composer.press("Enter");
    await expect(scope.getByText("My confirmed message", { exact: true })).toHaveCount(1);
    await expect(scope.getByText("My confirmed message", { exact: true })).toBeInViewport();
    await expect(scope.getByText("Previously unseen message", { exact: true })).toHaveCount(1);
    await expect.poll(() => stream.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
    await expect(composer).toHaveValue("");
  });
}

for (const reading of ["live", "held-bottom", "held-middle"] as const) {
  test(`opening a side thread preserves the main chat position after reflow (${reading})`, async ({ page }) => {
    const alpha = project("alpha", "Alpha Hive"), a = channel("a", "Alpha", alpha);
    const messages = Array.from({ length: 20 }, (_, index) => message(`root-${index}`, index + 1, a.id,
      `Message ${index}. ${"Text that wraps into more lines when the side thread opens. ".repeat(12)}`));
    const last = reading === "held-middle" ? messages[10]! : messages.at(-1)!;
    const threads: Thread[] = [{ id: last.id, channelId: a.id, status: "open" }];
    await installSnapshot(page, () => snapshot([alpha], [a]));
    await installSocketHarness(page);
    await installMessages(page, async (route, _id, threadId) => fulfillJson(route,
      { ...payload(a, threadId ? [last] : messages, threads), threadId, replyCounts: { [last.id]: 1 } }));
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto("/#/c/a");
    const stream = page.locator("main .stream");
    await expect(page.locator("main .msg")).toHaveCount(20);
    await expect.poll(() => stream.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
    if (reading !== "live") {
      await stream.evaluate(el => { el.scrollTop = 0; });
      await expect(page.locator("main").getByRole("button", { name: "Return to live", exact: true })).toBeVisible();
      if (reading === "held-bottom") await stream.evaluate(el => { el.scrollTop = el.scrollHeight; });
    }
    const reply = page.locator("main .msg").filter({ has: page.getByText(last.body, { exact: true }) }).getByRole("button", { name: "1 reply", exact: true });
    if (reading === "held-middle") await reply.evaluate(el => el.scrollIntoView({ block: "center" }));
    const replyBottom = await reply.evaluate(el => el.getBoundingClientRect().bottom);
    const before = await stream.evaluate(el => el.scrollWidth);
    await reply.click();
    await expect(page.locator("aside.thread")).toBeVisible();
    expect(await stream.evaluate(el => el.scrollWidth)).toBeLessThan(before);
    await expect(reply).toBeInViewport();
    if (reading === "held-middle") {
      await expect.poll(async () => Math.abs(await reply.evaluate(el => el.getBoundingClientRect().bottom) - replyBottom)).toBeLessThan(3);
    } else {
      await expect.poll(() => stream.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
    }
    await expect(page.locator("main").getByRole("button", { name: "Return to live", exact: true })).toHaveCount(reading === "live" ? 0 : 1);
  });
}

test("opening a side thread keeps the main chat anchored when web fonts swap in late", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive"), a = channel("a", "Alpha", alpha);
  const messages = Array.from({ length: 20 }, (_, index) => message(`root-${index}`, index + 1, a.id,
    `Message ${index}. ${"Text that wraps into more lines when the side thread opens. ".repeat(12)}`));
  const last = messages[10]!;
  const threads: Thread[] = [{ id: last.id, channelId: a.id, status: "open" }];
  const fonts = deferred();
  await page.route("**/*.woff2", async route => {
    await fonts.promise;
    await route.continue();
  });
  await installSnapshot(page, () => snapshot([alpha], [a]));
  await installSocketHarness(page);
  await installMessages(page, async (route, _id, threadId) => fulfillJson(route,
    { ...payload(a, threadId ? [last] : messages, threads), threadId, replyCounts: { [last.id]: 1 } }));
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/#/c/a");
  const stream = page.locator("main .stream");
  await expect(page.locator("main .msg")).toHaveCount(20);
  await stream.evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator("main").getByRole("button", { name: "Return to live", exact: true })).toBeVisible();
  const reply = page.locator("main .msg").filter({ has: page.getByText(last.body, { exact: true }) }).getByRole("button", { name: "1 reply", exact: true });
  await reply.evaluate(el => el.scrollIntoView({ block: "center" }));
  const replyBottom = await reply.evaluate(el => el.getBoundingClientRect().bottom);
  await reply.click();
  await expect(page.locator("aside.thread")).toBeVisible();
  await expect.poll(async () => Math.abs(await reply.evaluate(el => el.getBoundingClientRect().bottom) - replyBottom)).toBeLessThan(3);
  expect(await page.evaluate(() => document.fonts.check('16px "Figtree"'))).toBe(false);
  const fallbackHeight = await stream.evaluate(el => el.scrollHeight);

  // The swap re-wraps every message after the first anchor correction.
  fonts.resolve();
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Figtree"'))).toBe(true);
  await expect.poll(() => stream.evaluate(el => el.scrollHeight)).not.toBe(fallbackHeight);
  await expect.poll(async () => Math.abs(await reply.evaluate(el => el.getBoundingClientRect().bottom) - replyBottom)).toBeLessThan(3);
});
