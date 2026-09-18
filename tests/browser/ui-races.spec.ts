import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

type Project = {
  id: string;
  slug: string;
  name: string;
  worktree: string | null;
  createdAt: number;
};

type Agent = {
  id: string;
  name: string;
  role: "human" | "brain" | "worker";
  seniority: "junior" | "mid" | "senior" | null;
  focus: string | null;
  online: boolean;
  lastSeenAt: number;
  createdAt: number;
  projectId: string | null;
  project: string | null;
};

type Channel = {
  id: string;
  name: string;
  type: "public" | "brains" | "private" | "dm";
  topic: string | null;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
  projectId: string;
  project: string;
};

type Message = {
  id: string;
  seq: number;
  channelId: string;
  threadId: string | null;
  authorId: string;
  authorName: string;
  authorRole: "human" | "brain" | "worker";
  body: string;
  kind: "chat" | "system" | "control";
  control: null;
  mentions: string[];
  createdAt: number;
  reactions?: Array<{ emoji: string; count: number; mine?: boolean }>;
};

type Thread = {
  id: string;
  channelId: string;
  status: "open" | "in_progress" | "blocked" | "done" | null;
};

type ChannelPayload = {
  channel: Channel;
  messages: Message[];
  hasOlder: boolean;
  threads: Thread[];
  replyCounts: Record<string, number>;
};

type Snapshot = {
  you: Agent;
  projects: Project[];
  agents: Agent[];
  channels: Channel[];
  unread: Record<string, number>;
  mentions: Message[];
  mentionsHasMore: boolean;
  queued: Record<string, number>;
  telegram: { running: boolean; configured: boolean };
};

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
  return { channel: ch, messages, hasOlder: false, threads, replyCounts };
}

function snapshot(projects: Project[], channels: Channel[]): Snapshot {
  return {
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
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installSnapshot(page: Page, current: () => Snapshot) {
  await page.route("**/api/ui/snapshot", async (route) => fulfillJson(route, current()));
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

async function installSocketHarness(
  page: Page,
  onConnect?: (socket: WebSocketRoute, index: number) => void,
) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws", (socket) => {
    sockets.push(socket);
    onConnect?.(socket, sockets.length - 1);
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

  await installSnapshot(page, () => snap);
  await installMessages(page, async (route, channelId, threadId) => {
    expect(channelId).toBe("a");
    await fulfillJson(route, threadId ? threadData : channelData);
  });
  const sockets = await installSocketHarness(page, (socket, index) => {
    if (index > 0) socket.send(JSON.stringify({ type: "hello", at: Date.now() }));
  });

  await page.goto("/#/c/a/t/root");
  await expect(page.getByText("reply before disconnect", { exact: true })).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);

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

  await sockets[0]!.close({ code: 1001, reason: "controlled disconnect" });
  await page.clock.runFor(1_600);
  await expect.poll(() => sockets.length).toBe(2);

  await expect(page.getByText("missed while websocket was down", { exact: true })).toBeVisible();
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

  const sockets = await installSocketHarness(page, (socket, index) => {
    if (index > 0) socket.send(JSON.stringify({ type: "hello", at: Date.now() }));
  });

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
