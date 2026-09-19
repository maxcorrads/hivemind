import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

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
