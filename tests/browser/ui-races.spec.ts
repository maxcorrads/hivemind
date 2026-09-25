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
  await page.route("**/api/ui/nav-status", async route => fulfillJson(route, { awaitingDecisions: {}, agentWork: {} }));
  await page.route("**/api/ui/read", async route => {
    const receipt = route.request().postDataJSON() as { messageSeqs: number[] };
    harness.receipts.push(receipt.messageSeqs);
    harness.revision++;
    await fulfillJson(route, reads());
  });
  await page.route("**/api/ui/activity?*", async route => fulfillJson(route, {
    readInstance: "browser-fixture", readRevision: harness.revision, readSeq: harness.seq,
    items: [], hasMore: false,
  }));
  const room: RoomView = { room: null, tasks: [], activeTaskCount: 0, tasksHasMore: false,
    nextTaskCursor: null, links: [], unmanagedBots: [] };
  await page.route("**/api/ui/channels/*/room", async route => fulfillJson(route, room));
  // The channel tabs count the channel's tasks and decisions.
  await page.route("**/api/ui/channels/*/tasks", async route => fulfillJson(route, { items: [], hasMore: false }));
  await page.route("**/api/ui/decisions?*", async route => fulfillJson(route, { items: [], awaiting: 0, warning: "" }));
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

for (const inThread of [false, true]) for (const alreadyOpen of [false, true]) {
  test(`unread badge jumps to the exact latest unread page (thread=${inThread}, open=${alreadyOpen})`, async ({ page }, testInfo) => {
    const p = project('alpha', 'Alpha Hive');
    const a = { ...channel('a', 'Anvil · Human', p), type: 'dm' as const }, b = channel('b', 'Beta', p);
    const snap = { ...snapshot([p], [a, b]), unread: { a: 3 } };
    const root = message('root', 1, a.id, 'An old thread root');
    const thread = inThread ? root.id : null;
    const target = message('target', 240, a.id, 'The latest unread message', thread,
      { authorId: 'anvil', authorName: 'Anvil', authorRole: 'worker' });
    const context = Array.from({ length: 20 }, (_, i) => message(`context-${i}`, 220 + i, a.id, `Context ${i}. ${'Older content. '.repeat(80)}`, thread));
    const requests: string[] = [];
    await installSnapshot(page, () => snap); await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId: thread, seq: target.seq } }));
    await installMessages(page, async (route, id, threadId) => {
      const url = new URL(route.request().url()); requests.push(url.search);
      if (id === b.id) return fulfillJson(route, payload(b, []));
      if (url.searchParams.get('beforeSeq') === '241') {
        expect(threadId).toBe(thread);
        return fulfillJson(route, { ...payload(a, [...context, target]), threadId: thread, hasOlder: true, hasNewer: true });
      }
      return fulfillJson(route, { ...payload(a, [message('latest', 1000, a.id, 'Ordinary channel view', threadId)]), threadId });
    });
    await page.goto(`/#/c/${alreadyOpen ? a.id : b.id}`);
    if (alreadyOpen) await expect(page.getByText('Ordinary channel view', { exact: true })).toBeVisible();
    const badge = page.getByRole('button', { name: 'Jump to last unread message in Anvil · Human (3 unread)', exact: true });
    await expect(badge).toBeVisible();
    expect(await page.locator('button button').count()).toBe(0);
    if (inThread) { await badge.focus(); await page.keyboard.press(alreadyOpen ? 'Space' : 'Enter'); } else await badge.click();
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    const row = scope.locator('[data-message-seq="240"]');
    await expect(row).toHaveClass(/unread-target/); await expect(row).toBeInViewport(); await expect(row).toBeFocused();
    expect(requests.some(q => q.includes('beforeSeq=241'))).toBe(true);
    await expect.poll(() => harnesses.get(page)!.receipts.flat().includes(240)).toBe(true);
    expect(harnesses.get(page)!.receipts.flat().includes(219)).toBe(false);
    if (inThread) await expect(page).toHaveURL(/\/t\/root$/);
    await page.screenshot({ path: testInfo.outputPath('unread-target.png') });
    // Repeated activation works even when the channel/thread selection is identical.
    await scope.locator('.stream').evaluate(el => { el.scrollTop = 0; });
    await badge.click(); await expect(row).toBeInViewport();
  });
}

for (const tab of ['Tasks', 'Contract', 'Decisions']) for (const inThread of [false, true]) {
  test(`unread badge reveals Messages from ${tab} (thread=${inThread})`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p);
    const snap = { ...snapshot([p], [a]), unread: { a: 1 } };
    const threadId = inThread ? 'root' : null;
    await installSnapshot(page, () => snap); await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route =>
      fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
    await installMessages(page, async (route, _, requestedThread) => {
      const targeted = new URL(route.request().url()).searchParams.get('beforeSeq') === '241';
      const messages = targeted ? [message('target', 240, a.id, 'Unread destination', requestedThread,
        { authorId: 'worker', authorName: 'Worker', authorRole: 'worker' })] : [];
      await fulfillJson(route, { ...payload(a, messages), threadId: requestedThread, hasNewer: targeted });
    });
    await page.goto('/#/c/a');
    await page.getByRole('textbox', { name: 'Message #Alpha', exact: true }).fill('Keep my draft');
    const view = page.getByRole('tab', { name: tab, exact: true });
    const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' });
    for (let repeat = 0; repeat < 2; repeat++) {
      await view.click();
      await expect(page.locator('#channel-panel-messages')).toBeHidden();
      await badge.click();
      await expect(page.getByRole('tab', { name: 'Messages', exact: true })).toHaveAttribute('aria-selected', 'true');
      const row = page.locator(inThread ? 'aside.thread' : 'main.desk').locator('[data-message-seq="240"]');
      await expect(row).toBeVisible(); await expect(row).toBeFocused();
      await expect(row).toHaveClass(/unread-target/);
      await expect(page.locator('main.desk').getByRole('textbox', { name: 'Message #Alpha', exact: true })).toHaveValue('Keep my draft');
    }
    await view.click();
    await expect(view).toHaveAttribute('aria-selected', 'true');
  });
}

for (const delayed of ['lookup', 'page'] as const) {
  test(`unread badge discards delayed ${delayed} after navigation, including a later return`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    const snap = { ...snapshot([p], [a, b]), unread: { a: 1 } }, started = deferred(), release = deferred();
    let targeted = 0;
    await installSnapshot(page, () => snap); await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', async route => {
      if (delayed === 'lookup') { started.resolve(); await release.promise; }
      try { await fulfillJson(route, { target: { channelId: a.id, threadId: null, seq: 5 } }); } catch { /* request aborted */ }
    });
    await installMessages(page, async (route, id) => {
      if (new URL(route.request().url()).searchParams.has('beforeSeq')) {
        targeted++; started.resolve(); await release.promise;
        try { await fulfillJson(route, payload(a, [message('target', 5, a.id, 'stale unread target')])); } catch { /* request aborted */ }
      } else await fulfillJson(route, payload(id === a.id ? a : b, [message('current-' + id, 50, id, 'current ' + id)]));
    });
    await page.goto('/#/c/b');
    await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)', exact: true }).click();
    await started.promise; await page.getByRole('button', { name: '# Beta', exact: true }).click();
    release.resolve(); await expect(page.getByText('current b', { exact: true })).toBeVisible();
    await expect(page.getByText('stale unread target', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '# Alpha', exact: true }).click();
    await expect(page.getByText('current a', { exact: true })).toBeVisible();
    expect(targeted).toBe(delayed === 'page' ? 1 : 0);
    expect(harnesses.get(page)!.receipts.flat()).not.toContain(5);
  });
}

for (const [interruption, inThread] of [['hello', false], ['hello', true], ['room', true]] as const) {
  test(`unread jump survives an automatic ${interruption} refresh (thread=${inThread})`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    const root = message('root', 1, a.id, 'Thread root');
    const threadId = inThread ? root.id : null;
    const target = message('target', 240, a.id, 'Review unread destination', threadId, { authorId: 'worker' });
    const started = deferred(), release = deferred(), refreshed = deferred();
    let interrupted = false;
    await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 1 } }));
    const sockets = await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
    await installMessages(page, async (route, id, requestedThread) => {
      if (interrupted && id === a.id && requestedThread === threadId) refreshed.resolve();
      if (new URL(route.request().url()).searchParams.has('beforeSeq')) {
        started.resolve(); await release.promise;
        try { await fulfillJson(route, { ...payload(a, [target]), threadId, hasOlder: true }); } catch { /* aborted */ }
        return;
      }
      await fulfillJson(route, { ...payload(id === a.id ? a : b,
        [message('ordinary-' + id, 1000, id, 'Default page ' + id, requestedThread)]), threadId: requestedThread });
    });
    await page.goto('/#/c/b');
    await expect(page.getByText('Default page b', { exact: true })).toBeVisible();
    await expect.poll(() => sockets.length).toBe(1);
    await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
    await started.promise;
    interrupted = true;
    if (interruption === 'hello') await sockets[0]!.close({ code: 1013, reason: 'review reconnect' });
    else sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
    await refreshed.promise;
    release.resolve();
    const scope = page.locator(threadId ? 'aside.thread' : 'main.desk');
    await expect(scope.locator('[data-message-seq="240"]')).toBeVisible();
    await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    await expect.poll(() => harnesses.get(page)!.receipts.flat().includes(240)).toBe(true);
    expect(harnesses.get(page)!.receipts.flat()).not.toContain(1000);
  });
}

for (const inThread of [false, true]) for (const keyboard of [false, true]) {
test(`unread anchor releases on explicit live navigation (thread=${inThread}, keyboard=${keyboard})`, async ({ page }) => {
  const p = project('alpha', 'Alpha Hive');
  const a = { ...channel('a', 'Alpha', p), type: 'dm' as const }, b = channel('b', 'Beta', p);
  const threadId = inThread ? 'root' : null;
  const target = message('target', 240, a.id, 'Unread target', threadId, { authorId: 'worker' });
  const context = Array.from({ length: 20 }, (_, i) => message(`before-${i}`, 220 + i, a.id, `Before ${i}. ${'Long content. '.repeat(80)}`, threadId));
  const after = Array.from({ length: 20 }, (_, i) => message(`after-${i}`, 241 + i, a.id, `After ${i}. ${'Long content. '.repeat(80)}`, threadId));
  await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 1 } }));
  await installSocketHarness(page);
  await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
  await installMessages(page, async (route, id, requestedThread) => {
    if (id === b.id) return fulfillJson(route, payload(b, []));
    if (inThread && !requestedThread) return fulfillJson(route, payload(a, []));
    const historical = new URL(route.request().url()).searchParams.has('beforeSeq');
    await fulfillJson(route, { ...payload(a, [...context, target, ...(historical ? [] : after)]), hasOlder: historical, hasNewer: historical });
  });
  await page.goto('/#/c/b');
  await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
  const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
  await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
  const live = scope.getByRole('button', { name: inThread ? 'New replies — refresh thread' : 'New messages — jump to recent', exact: true });
  if (keyboard) { await live.focus(); await page.keyboard.press('Enter'); } else await live.click();
  await expect(scope.locator('[data-message-seq="260"]')).toBeInViewport();
});
}

test('a second unread jump replaces the first and survives a room refresh', async ({ page }) => {
  const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
  const blocked = deferred(), release = deferred(), second = deferred(), refreshed = deferred();
  let lookups = 0, secondLoads = 0;
  await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 2 } }));
  const sockets = await installSocketHarness(page);
  await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route,
    { target: { channelId: a.id, threadId: 'root', seq: ++lookups === 1 ? 240 : 120 } }));
  await installMessages(page, async (route, id, threadId) => {
    const before = new URL(route.request().url()).searchParams.get('beforeSeq');
    if (before) {
      if (before === '241') { blocked.resolve(); await release.promise; }
      else { if (++secondLoads === 1) { second.resolve(); await refreshed.promise; } }
      const seq = Number(before) - 1;
      try { await fulfillJson(route, payload(a, [message(`target-${seq}`, seq, a.id, `Target ${seq}`, 'root', { authorId: 'worker' })])); }
      catch { /* Superseded requests are expected to be aborted. */ }
      return;
    }
    await fulfillJson(route, { ...payload(id === a.id ? a : b, []), threadId });
  });
  await page.goto('/#/c/b');
  const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (2 unread)' });
  await badge.click(); await blocked.promise;
  await badge.click(); await second.promise;
  sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
  await expect.poll(() => secondLoads).toBe(2);
  refreshed.resolve(); release.resolve();
  await expect(page.locator('aside.thread [data-message-seq="120"]')).toHaveClass(/unread-target/);
  await expect(page.locator('[data-message-seq="240"]')).toHaveCount(0);
  expect(harnesses.get(page)!.receipts.flat()).not.toContain(240);
});

test('explicit thread refresh cancels a pending unread destination permanently', async ({ page }) => {
  const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
  const blocked = deferred(), release = deferred();
  let lookups = 0, targetLoads = 0, normalLoads = 0;
  await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 2 } }));
  const sockets = await installSocketHarness(page);
  await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route,
    { target: { channelId: a.id, threadId: 'root', seq: ++lookups === 1 ? 240 : 120 } }));
  await installMessages(page, async (route, id, threadId) => {
    const before = new URL(route.request().url()).searchParams.get('beforeSeq');
    if (before) {
      targetLoads++;
      if (before === '121') { blocked.resolve(); await release.promise; }
      const seq = Number(before) - 1;
      try { await fulfillJson(route, { ...payload(a, [message(`target-${seq}`, seq, a.id, `Target ${seq}`, 'root')]), hasNewer: true }); }
      catch { /* Explicit live navigation cancels the old target request. */ }
      return;
    }
    normalLoads++;
    await fulfillJson(route, { ...payload(id === a.id ? a : b,
      threadId ? [message('live', 1000, a.id, 'Live thread page', threadId)] : []), threadId });
  });
  await page.goto('/#/c/b');
  const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (2 unread)' });
  await badge.click();
  await expect(page.locator('aside.thread [data-message-seq="240"]')).toHaveClass(/unread-target/);
  await badge.click(); await blocked.promise;
  await page.getByRole('button', { name: 'New replies — refresh thread', exact: true }).click();
  await expect(page.getByText('Live thread page', { exact: true })).toBeVisible();
  release.resolve();
  const beforeRefresh = normalLoads;
  sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
  await expect.poll(() => normalLoads).toBeGreaterThan(beforeRefresh);
  await expect(page.locator('[data-message-seq="120"]')).toHaveCount(0);
  expect(targetLoads).toBe(2);
});

for (const inThread of [false, true]) {
  for (const outcome of ['target', 'empty', 'failure'] as const) {
  test(`explicit live navigation cancels a delayed unread lookup (thread=${inThread}, outcome=${outcome})`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    const threadId = inThread ? 'root' : null;
    const blocked = deferred(), release = deferred(), lookupDone = deferred();
    let lookups = 0, targetLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 2 } }));
    await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', async route => {
      const request = ++lookups;
      if (request === 2) { blocked.resolve(); await release.promise; }
      try {
        if (request === 2 && outcome !== 'target') {
          await fulfillJson(route, outcome === 'empty' ? { target: null } : { error: 'Obsolete lookup failure' }, outcome === 'empty' ? 200 : 503);
        } else await fulfillJson(route, { target: { channelId: a.id, threadId, seq: request === 1 ? 240 : 120 } });
      }
      catch { /* Explicit navigation may already have aborted the lookup. */ }
      finally { if (request === 2) lookupDone.resolve(); }
    });
    await installMessages(page, async (route, id, requestedThread) => {
      const before = new URL(route.request().url()).searchParams.get('beforeSeq');
      if (before) targetLoads++;
      const seq = before ? Number(before) - 1 : 1000;
      await fulfillJson(route, { ...payload(id === a.id ? a : b,
        [message(`m-${id}-${requestedThread}-${seq}`, seq, id, before ? `Target ${seq}` : 'Live page ' + id, requestedThread)]),
        threadId: requestedThread, hasNewer: Boolean(before) });
    });
    await page.goto('/#/c/b');
    const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (2 unread)' });
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    await badge.click(); await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    await badge.click(); await blocked.promise;
    await scope.getByRole('button', { name: inThread ? 'New replies — refresh thread' : 'New messages — jump to recent', exact: true }).click();
    await expect(scope.locator('[data-message-seq="1000"]')).toBeVisible();
    release.resolve(); await lookupDone.promise;
    // Wait for any lookup callback's React/paint work without arbitrary wall time.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(scope.locator('[data-message-seq="120"]')).toHaveCount(0);
    expect(targetLoads).toBe(1);
    await expect(scope.locator('[data-message-seq="1000"]')).toBeVisible();
    await expect(page.locator('.err')).toHaveCount(0);
    // Cancellation is scoped to the old request; the next badge click still works.
    await badge.click();
    await expect(scope.locator('[data-message-seq="120"]')).toHaveClass(/unread-target/);
    expect(targetLoads).toBe(2);
  });
  }

  test(`failed unread target page recovers on an automatic refresh (thread=${inThread})`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    const threadId = inThread ? 'root' : null;
    let targetLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 1 } }));
    const sockets = await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
    await installMessages(page, async (route, id, requestedThread) => {
      const before = new URL(route.request().url()).searchParams.get('beforeSeq');
      if (before && ++targetLoads === 1) return fulfillJson(route, { error: 'Transient target page failure' }, 503);
      const seq = before ? 240 : 1000;
      await fulfillJson(route, { ...payload(id === a.id ? a : b, [message('m-' + seq, seq, id, 'Page ' + seq, requestedThread, { authorId: 'worker' })]), threadId: requestedThread });
    });
    await page.goto('/#/c/b');
    await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
    await expect(page.locator('.err')).toContainText('Transient target page failure');
    if (inThread) sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
    else await sockets[0]!.close({ code: 1013, reason: 'Review recovery' });
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    expect(targetLoads).toBe(2);
  });

  test(`cancelled unread jump stays cancelled after navigation and reconnect (thread=${inThread})`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    const threadId = inThread ? 'root' : null;
    const blocked = deferred(), release = deferred();
    let targetLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 1 } }));
    const sockets = await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
    await installMessages(page, async (route, id, requestedThread) => {
      const before = new URL(route.request().url()).searchParams.get('beforeSeq');
      if (before) { targetLoads++; blocked.resolve(); await release.promise; }
      const seq = before ? 240 : 1000;
      try { await fulfillJson(route, { ...payload(id === a.id ? a : b, [message('m-' + seq, seq, id, 'Page ' + id, requestedThread)]), threadId: requestedThread }); }
      catch { /* Navigation aborts the pending page. */ }
    });
    await page.goto('/#/c/b');
    await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
    await blocked.promise;
    await page.getByRole('button', { name: '# Beta', exact: true }).click();
    release.resolve();
    await page.goto('/#/c/a' + (inThread ? '/t/root' : ''));
    await expect(page.locator(inThread ? 'aside.thread' : 'main.desk').getByText('Page a', { exact: true })).toBeVisible();
    const connected = sockets.length;
    await sockets.at(-1)!.close({ code: 1013, reason: 'Review reconnect after cancelled jump' });
    await expect.poll(() => sockets.length).toBeGreaterThan(connected);
    expect(targetLoads).toBe(1);
    await expect(page.locator('[data-message-seq="240"]')).toHaveCount(0);
  });
}

for (const [interruption, inThread] of [['hello', false], ['hello', true], ['room', true]] as const) {
  test('delayed lookup survives automatic ' + interruption + ' thread=' + inThread, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p);
    const threadId = inThread ? 'root' : null;
    const blocked = deferred(), release = deferred();
    let normalLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a]), unread: { a: 1 } }));
    const sockets = await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', async route => {
      blocked.resolve(); await release.promise;
      await fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } });
    });
    await installMessages(page, async (route, id, requestedThread) => {
      const before = new URL(route.request().url()).searchParams.get('beforeSeq');
      if (!before) normalLoads++;
      const seq = before ? 240 : 1000;
      await fulfillJson(route, { ...payload(a, [message('row-' + seq, seq, id, 'Row ' + seq, requestedThread,
        before ? { authorId: 'worker' } : {})]), threadId: requestedThread, hasNewer: Boolean(before) });
    });
    await page.goto('/#/c/a' + (inThread ? '/t/root' : ''));
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    await expect(scope.locator('[data-message-seq="1000"]')).toBeVisible();
    await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
    await blocked.promise;
    const before = normalLoads;
    if (interruption === 'hello') await sockets[0]!.close({ code: 1013, reason: 'Review initial lookup' });
    else sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
    await expect.poll(() => normalLoads).toBeGreaterThan(before);
    release.resolve();
    await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    await expect.poll(() => harnesses.get(page)!.receipts.flat().includes(240)).toBe(true);
  });
}

for (const paging of ['channel-older', 'thread-earlier', 'thread-newer'] as const) {
  test('explicit ' + paging + ' cancels delayed lookup without a receipt', async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p);
    const inThread = paging !== 'channel-older', threadId = inThread ? 'root' : null;
    const blocked = deferred(), release = deferred(), done = deferred();
    let lookups = 0, staleLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a]), unread: { a: 2 } }));
    await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', async route => {
      const call = ++lookups;
      if (call === 2) { blocked.resolve(); await release.promise; }
      try { await fulfillJson(route, { target: { channelId: a.id, threadId, seq: call === 1 ? 240 : 120 } }); }
      catch { /* Explicit paging aborts the old lookup. */ }
      finally { if (call === 2) done.resolve(); }
    });
    await installMessages(page, async (route, id, requestedThread) => {
      const q = new URL(route.request().url()).searchParams, before = q.get('beforeSeq'), after = q.get('afterSeq');
      if (before === '121') staleLoads++;
      const seq = before === '241' ? 240 : before === '121' ? 120 : before ? 200 : after ? 260 : 1000;
      await fulfillJson(route, { ...payload(a, [message('row-' + seq, seq, id, 'Row ' + seq, requestedThread,
        seq === 120 ? { authorId: 'worker' } : {})]), threadId: requestedThread, hasOlder: true, hasNewer: seq === 240 });
    });
    await page.goto('/#/c/a');
    const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (2 unread)' });
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    await badge.click();
    await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    await badge.click(); await blocked.promise;
    await scope.getByRole('button', { name: paging === 'channel-older' ? 'Load older' : paging === 'thread-earlier' ? 'Load earlier replies' : 'Load more replies', exact: true }).click();
    const newSeq = paging === 'thread-newer' ? 260 : 200;
    await expect(scope.locator('[data-message-seq="' + newSeq + '"]')).toBeVisible();
    release.resolve(); await done.promise;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(staleLoads).toBe(0);
    expect(harnesses.get(page)!.receipts.flat()).not.toContain(120);
    await expect(page.locator('.err')).toHaveCount(0);
  });
}

for (const inThread of [false, true]) for (const outcome of ['empty', 'failure'] as const) for (const pageFailed of [false, true]) {
  test('replacement lookup preserves history: thread=' + inThread + ', outcome=' + outcome + ', pageFailed=' + pageFailed, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p);
    const threadId = inThread ? 'root' : null;
    const blocked = deferred(), release = deferred(), done = deferred();
    let lookups = 0, normalLoads = 0, targetLoads = 0;
    await installSnapshot(page, () => ({ ...snapshot([p], [a]), unread: { a: 2 } }));
    const sockets = await installSocketHarness(page);
    await page.route('**/api/ui/channels/a/last-unread', route => {
      const call = ++lookups;
      if (call > 2 && outcome === 'failure') return fulfillJson(route, { error: 'Replacement lookup failed' }, 503);
      return fulfillJson(route, { target: call > 2 ? null : { channelId: a.id, threadId, seq: call === 1 ? 240 : 120 } });
    });
    await installMessages(page, async (route, id, requestedThread) => {
      const before = new URL(route.request().url()).searchParams.get('beforeSeq');
      if (before) targetLoads++; else normalLoads++;
      if (before === '121') {
        blocked.resolve();
        if (pageFailed) {
          await fulfillJson(route, { error: 'Target page failed' }, 503);
          done.resolve(); return;
        }
        await release.promise;
      }
      const seq = before ? Number(before) - 1 : 1000;
      try { await fulfillJson(route, { ...payload(a, [message('row-' + seq, seq, id, 'Row ' + seq, requestedThread,
        seq === 120 || (seq === 1000 && lookups >= 3 && requestedThread === threadId) ? { authorId: 'worker' } : {})]), threadId: requestedThread, hasNewer: Boolean(before) }); }
      catch { /* The replacement lookup cancelled this page. */ }
      finally { if (before === '121') done.resolve(); }
    });
    await page.goto('/#/c/a');
    const badge = page.getByRole('button', { name: 'Jump to last unread message in Alpha (2 unread)' });
    const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
    await badge.click(); await expect(scope.locator('[data-message-seq="240"]')).toHaveClass(/unread-target/);
    await badge.click(); await blocked.promise;
    if (pageFailed) await expect(page.locator('.err')).toContainText('Target page failed');
    await badge.click(); await expect(page.locator('.err')).toContainText(outcome === 'empty' ? 'No unread messages remain' : 'Replacement lookup failed');
    release.resolve(); await done.promise;
    await expect(scope.locator('[data-message-seq="240"]')).toBeVisible();
    const before = normalLoads;
    if (inThread) sockets[0]!.send(JSON.stringify({ type: 'room', payload: { channelId: a.id } }));
    else await sockets[0]!.close({ code: 1013, reason: 'Review cancelled replacement' });
    await expect.poll(() => normalLoads).toBeGreaterThan(before);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(scope.locator('[data-message-seq="240"]')).toBeVisible();
    await expect(scope.locator('[data-message-seq="1000"]')).toHaveCount(0);
    expect(targetLoads).toBe(2);
    expect(harnesses.get(page)!.receipts.flat()).not.toContain(120);
    expect(harnesses.get(page)!.receipts.flat()).not.toContain(1000);
  });
}

for (const inThread of [false, true]) {
test('automatic refresh retains target highlight and late-reflow anchor: thread=' + inThread, async ({ page }) => {
  const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p);
  const threadId = inThread ? 'root' : null;
  const target = message('target', 240, a.id, 'Target unread', threadId);
  const context = Array.from({ length: 10 }, (_, i) => message('before-' + i, 220 + i, a.id, 'Context ' + i + '. ' + 'Long row. '.repeat(40), threadId));
  await installSnapshot(page, () => ({ ...snapshot([p], [a]), unread: { a: 1 } }));
  const sockets = await installSocketHarness(page);
  await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route, { target: { channelId: a.id, threadId, seq: 240 } }));
  await installMessages(page, async (route, id, requestedThread) => {
    await fulfillJson(route, { ...payload(a, requestedThread === threadId ? [...context, target] : []), threadId: requestedThread, hasOlder: true, hasNewer: true });
  });
  await page.goto('/#/c/a');
  await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)' }).click();
  const scope = page.locator(inThread ? 'aside.thread' : 'main.desk');
  const row = scope.locator('[data-message-seq="240"]');
  await expect(row).toHaveClass(/unread-target/);
  const start = Date.now();
  const refreshed = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/messages') && url.searchParams.get('threadId') === threadId && !url.searchParams.has('beforeSeq');
  });
  sockets[0]!.send(JSON.stringify({ type: inThread ? 'room' : 'project', payload: { channelId: a.id } }));
  await refreshed;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(Date.now() - start).toBeLessThan(2000);
  expect(await row.getAttribute('class')).toMatch(/unread-target/);
  await scope.locator('[data-message-seq="229"]').evaluate(el => { (el as HTMLElement).style.minHeight = '1600px'; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(row).toBeInViewport();
});
}

for (const outcome of ['empty', 'failure'] as const) {
  test(`unread badge ${outcome} leaves the current conversation intact`, async ({ page }) => {
    const p = project('alpha', 'Alpha Hive'), a = channel('a', 'Alpha', p), b = channel('b', 'Beta', p);
    await installSnapshot(page, () => ({ ...snapshot([p], [a, b]), unread: { a: 1 } })); await installSocketHarness(page);
    await installMessages(page, (route, id) => fulfillJson(route, payload(b, [message('b', 3, id, 'Keep my place')])));
    await page.route('**/api/ui/channels/a/last-unread', route => fulfillJson(route,
      outcome === 'empty' ? { target: null } : { error: 'fixture unavailable' }, outcome === 'empty' ? 200 : 503));
    await page.goto('/#/c/b'); await page.getByRole('button', { name: 'Jump to last unread message in Alpha (1 unread)', exact: true }).click();
    await expect(page.locator('.err')).toContainText(outcome === 'empty' ? 'No unread messages remain' : 'fixture unavailable');
    await expect(page).toHaveURL(/\/c\/b$/); await expect(page.getByText('Keep my place', { exact: true })).toBeVisible();
  });
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
  await expect(page.getByRole("button", { name: "# Beta" }).locator('..')).toHaveClass(/active/);
});

test("archived channels are consultable, reachable from the switcher and project-scoped without marking them read on expansion", async ({ page }, testInfo) => {
  const alpha = project("alpha", "Alpha Hive"), beta = project("beta", "Beta Hive");
  const a = channel("a", "General", alpha), old = channel("old", "review-closed", alpha);
  const other = channel("other", "other-closed", beta);
  const snap = { ...snapshot([alpha, beta], [a, old, other]), archivedChannelIds: [old.id, other.id], unread: { old: 7 } };
  await installSnapshot(page, () => snap);
  await installSocketHarness(page);
  await installMessages(page, async (route, id) => fulfillJson(route, payload(id === old.id ? old : a, [])));
  await page.route("**/api/ui/search?*", route => fulfillJson(route, { hits: [], hasMore: false }));
  await page.goto("/#/c/a");
  const section = page.locator(".project-sec").filter({ hasText: "Alpha Hive" });
  const archived = section.locator(".archived-channels");
  const oldRow = archived.getByRole("button", { name: "# review-closed", exact: true });
  await expect(archived).not.toHaveAttribute("open", "");
  await expect(oldRow).toBeHidden();
  await expect(section.locator(".group > .nav .nav-open")).toHaveText(["# General"]);
  const summary = archived.locator("summary");
  await expect(summary).toHaveText("Archived 1");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(oldRow).toBeVisible();
  await expect(archived.getByText("# other-closed", { exact: true })).toHaveCount(0);
  expect(harnesses.get(page)!.receipts).toEqual([]);
  await expect(page).toHaveURL(/#\/c\/a$/);
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
    await section.screenshot({ path: testInfo.outputPath(`archived-${dark ? "dark" : "light"}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 700 });
  // Phones show the channel full screen; its back arrow leads to Home, where the navigation lives.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#\/home\/alpha$/);
  await summary.scrollIntoViewIfNeeded();
  const bounds = await summary.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("archived-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await summary.click();
  await expect(oldRow).toBeHidden();
  // Message search opens its own view and leaves the sidebar untouched.
  await page.getByRole("textbox", { name: "Search messages" }).fill("review-closed");
  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
  await expect(oldRow).toBeHidden();
  await page.getByRole("textbox", { name: "Search messages" }).fill("");
  await page.keyboard.press("ControlOrMeta+k");
  const jump = page.getByRole("combobox", { name: "Jump to a channel, conversation, agent or project" });
  await jump.fill("review-closed");
  await expect(page.getByRole("option")).toHaveText([/# review-closed.*Alpha Hive · archived/]);
  await jump.press("Enter");
  await expect(page).toHaveURL(/#\/c\/old$/);
  await expect(oldRow).toBeVisible();
  await page.reload();
  await expect(oldRow).toBeVisible();
  await expect(oldRow.locator('..')).toHaveClass(/active/);
  expect(harnesses.get(page)!.receipts).toEqual([]);
});

for (const scenario of ["switcher", "direct-link", "remount"] as const) {
  test(`archived navigation reveals a new target after manual collapse (${scenario})`, async ({ page }) => {
    const alpha = project("alpha", "Alpha Hive"), beta = project("beta", "Beta Hive"), a = channel("a", "General", alpha);
    const first = channel("first", "review-one", alpha), second = channel("second", "review-two", alpha), b = channel("b", "Elsewhere", beta);
    const channels = [a, first, second, b];
    const snap = { ...snapshot([alpha, beta], channels), archivedChannelIds: [first.id, second.id], unread: { first: 7, second: 9 } };
    await installSnapshot(page, () => snap);
    const sockets = await installSocketHarness(page);
    await installMessages(page, (route, id) => fulfillJson(route, payload(channels.find(ch => ch.id === id)!, [])));
    await page.route("**/api/ui/search?*", route => fulfillJson(route, { hits: [], hasMore: false }));
    await page.goto("/#/c/first");
    const archived = page.locator(".archived-channels");
    await expect(archived).toHaveAttribute("open", "");
    const summary = archived.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(archived).not.toHaveAttribute("open", "");
    // Roster traffic must not override a deliberate collapse of this target.
    await expect.poll(() => sockets.length).toBe(1);
    sockets[0]!.send(JSON.stringify({ type: "agent", payload: { ...human, lastSeenAt: 2 } }));
    await expect(archived).not.toHaveAttribute("open", "");
    if (scenario === "direct-link") await page.evaluate(() => { location.hash = "#/c/second"; });
    else if (scenario === "remount") {
      // Switching project on the rail unmounts this sidebar; switching back returns to the last view.
      await page.getByRole("button", { name: /^Beta Hive/ }).click();
      await expect(archived).toHaveCount(0);
      await page.getByRole("button", { name: /^Alpha Hive/ }).click();
    } else {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox", { name: "Jump to a channel, conversation, agent or project" }).fill("review-two");
      await page.keyboard.press("Enter");
    }
    const target = scenario === "remount" ? "# review-one" : "# review-two";
    await expect(archived.getByRole("button", { name: target, exact: true })).toBeVisible();
    if (scenario === "direct-link") await expect(archived.getByRole("button", { name: target, exact: true }).locator('..')).toHaveClass(/active/);
    expect(harnesses.get(page)!.receipts).toEqual([]);
  });
}

test("archive and reopen update other channels live and preserve a selected channel thread", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive"), a = channel("a", "General", alpha), b = channel("b", "Review", alpha);
  let snap: Snapshot = { ...snapshot([alpha], [a, b]), archivedChannelIds: [] };
  const root = message("root", 1, b.id, "Review thread");
  await installSnapshot(page, () => snap);
  const sockets = await installSocketHarness(page);
  await installMessages(page, async (route, id, threadId) => {
    const ch = id === b.id ? b : a;
    const body = payload(ch, id === b.id ? [root] : []);
    await fulfillJson(route, { ...body, threadId, ...(threadId ? { root } : {}) });
  });
  await page.goto("/#/c/a");
  const rail = page.locator(".rail");
  const row = rail.getByRole("button", { name: "# Review", exact: true });
  await expect(row).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);
  snap = { ...snap, archivedChannelIds: [b.id] };
  sockets[0]!.send(JSON.stringify({ type: "room", payload: { channelId: b.id } }));
  await expect(rail.locator(".archived-channels")).toHaveCount(1);
  await expect(row).toBeHidden();
  await expect(page).toHaveURL(/#\/c\/a$/);
  // An incoming message cannot undo the room lifecycle state.
  sockets[0]!.send(JSON.stringify({ type: "message", payload: message("late", 2, b.id, "Late observation") }));
  await expect(row).toBeHidden();
  await page.goto("/#/c/b/t/root");
  await expect(row).toBeVisible();
  await expect(page.locator("aside.thread")).toBeVisible();
  snap = { ...snap, archivedChannelIds: [] };
  sockets.at(-1)!.send(JSON.stringify({ type: "room", payload: { channelId: b.id } }));
  await expect(rail.locator(".archived-channels")).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(page.locator("aside.thread")).toBeVisible();
  await expect(page).toHaveURL(/#\/c\/b\/t\/root$/);
  snap = { ...snap, archivedChannelIds: [b.id] };
  sockets.at(-1)!.send(JSON.stringify({ type: "room", payload: { channelId: b.id } }));
  await expect(rail.locator(".archived-channels[open]")).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(page.locator("aside.thread")).toBeVisible();
  await expect(page).toHaveURL(/#\/c\/b\/t\/root$/);
  // Reconnect reconciles changes missed while disconnected.
  snap = { ...snap, archivedChannelIds: [] };
  const connectionCount = sockets.length;
  await sockets.at(-1)!.close({ code: 1013, reason: "controlled archive resync" });
  await expect.poll(() => sockets.length).toBe(connectionCount + 1);
  await expect(rail.locator(".archived-channels")).toHaveCount(0);
});

test("snapshots without archive metadata keep ordinary channels visible", async ({ page }) => {
  const alpha = project("alpha", "Alpha Hive"), a = channel("a", "General", alpha);
  await installSnapshot(page, () => snapshot([alpha], [a]));
  await installSocketHarness(page);
  await installMessages(page, route => fulfillJson(route, payload(a, [])));
  await page.goto("/#/c/a");
  await expect(page.locator(".rail").getByRole("button", { name: "# General", exact: true })).toBeVisible();
  await expect(page.locator(".archived-channels")).toHaveCount(0);
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
  await expect(page.locator("aside.thread [data-thread-status]")).toHaveAttribute("data-thread-status", "in_progress");
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
  await expect(page.locator("aside.thread [data-thread-status]")).toHaveAttribute("data-thread-status", "blocked");

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
  await expect(page.locator("aside.thread [data-thread-status]")).toHaveAttribute("data-thread-status", "done");
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
  await expect(page.locator("aside.thread [data-thread-status]")).toHaveAttribute("data-thread-status", "blocked");
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
    const refresh = scope.getByRole("button", { name: inThread ? "New replies — refresh thread" : "New messages — jump to recent", exact: true });
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
    enabled: false, apiKeySet: false, apiKeyHint: null, model: "jev-latest", defaultModel: "jev-latest", modelPinned: false,
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

test("direct conversations, inbox receipts and the Jev advice strip remain independent", async ({ page }, testInfo) => {
  const alpha = project("alpha", "Example Hive");
  const dm = { ...channel("dm", "Human · Beacon", alpha), type: "dm" as const, memberIds: ["human", "brain"] };
  const peers = { ...channel("peers", "Beacon · Helper", alpha), type: "dm" as const, memberIds: ["brain", "worker"] };
  const snap = snapshot([alpha], [dm, peers]);
  snap.agents.push({ ...human, id: "brain", name: "Beacon", role: "brain", project: alpha.slug, projectId: alpha.id });
  const direct = message("direct", 1, dm.id, "A direct update. ".repeat(50), null, { authorId: "brain", authorName: "Beacon", authorRole: "brain", mentions: ["human"] });
  const mentioned = message("mention", 2, peers.id, "An update mentioning @Human.", null, { authorId: "brain", authorName: "Beacon", authorRole: "brain", mentions: ["human"] });
  snap.mentions = [mentioned, direct]; snap.mentionCounts = { alpha: 2 }; snap.unread = { dm: 1, peers: 1 };
  await installSnapshot(page, () => snap);
  const sockets = await installSocketHarness(page);
  await installMessages(page, async (route, id) => fulfillJson(route, payload(id === "dm" ? dm : peers, [id === "dm" ? direct : mentioned])));
  const activityRequests: string[] = [];
  await page.route("**/api/ui/activity?*", route => {
    const query = new URL(route.request().url()).searchParams, reasons = query.get("reason")?.split(",") ?? [];
    activityRequests.push(query.toString());
    const read = harnesses.get(page)!.receipts.flat();
    const items = ([[mentioned, "mention"], [direct, "direct"]] as const)
      .map(([m, reason]) => ({ message: m, reason, project: alpha.slug, read: read.includes(m.seq) }))
      .filter(item => (!reasons.length || reasons.includes(item.reason)) && (query.get("unread") !== "1" || !item.read));
    return fulfillJson(route, { readInstance: "browser-fixture", readRevision: harnesses.get(page)!.revision, readSeq: 2, items, hasMore: false });
  });
  const advised = { executionId: "run", channelId: dm.id, projectId: alpha.id, brainId: "brain", rootMessageId: "direct", updatedAt: 1,
    revision: 1, completedAt: null, monitoring: "active", recommendation: { routeId: "r", contractVersion: "adaptive-routing-v3",
      targetTopology: "brain_multi_dm", targetWorkers: 2, confidence: 0.72, reason: "parallel_workstreams", providerStatus: "ok",
      model: "fixture", latencyMs: 1, inputTokens: 1, outputTokens: 1, singleSufficient: false, needsOrchestration: true } };
  await page.route("**/api/ui/channels/*/adaptive-routing", route => fulfillJson(route,
    route.request().url().includes(`/channels/${dm.id}/`) ? { state: advised, executions: [advised], events: [] } : { state: null, events: [] }));
  await page.goto("/#/c/dm");
  await expect(page.locator(".with-human")).toBeVisible();
  await expect(page.locator(".between-agents")).not.toBeVisible();
  // #211: the composer has no mode or lock selector; an informational strip shows Jev's latest advice.
  await expect(page.locator(".routing-strip button")).toHaveText("Jev suggests: Multi-DM · 2 workers (72%)");
  await expect(page.locator(".routing-strip span")).toHaveText("Advisory only · the brain decides");
  await expect(page.getByLabel("Message routing options")).toHaveCount(0);
  await expect(page.locator(".composer select")).toHaveCount(0);
  const strip = await page.locator(".routing-strip").boundingBox(); expect(strip!.height).toBeLessThan(60);
  await page.locator(".composer").screenshot({ path: testInfo.outputPath("composer.png") });
  await page.getByRole("button", { name: /^For you/ }).click();
  // Channel reading already acknowledged the direct message; test only the remaining mention.
  await expect(page.locator(".inbox-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Direct messages", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Mentions", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveClass(/expanded/);
  await page.screenshot({ path: testInfo.outputPath("for-you.png") });
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(page.locator(".inbox-card")).toHaveCount(0);
  expect(harnesses.get(page)!.receipts.some(receipt => receipt.length === 1 && receipt[0] === 2)).toBe(true);
  // #225: Activity is served by the server with read state, and new entries arrive in realtime.
  await page.getByRole("button", { name: "Everything", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/#\/inbox\/alpha\/all$/);
  await expect(page.locator(".inbox-card")).toHaveCount(2);
  await expect(page.locator(".inbox-card.unread")).toHaveCount(0);
  expect(activityRequests.at(-1)).toBe("project=alpha&unread=0");
  const requests = activityRequests.length;
  const fresh = message("fresh", 3, dm.id, "A fresh direct update.", null, { authorId: "brain", authorName: "Beacon", authorRole: "brain", mentions: [] });
  sockets[0]!.send(JSON.stringify({ type: "activity", payload: { message: fresh, reason: "direct", project: alpha.slug, read: false } }));
  await expect(page.locator(".inbox-card")).toHaveCount(3);
  await expect(page.locator(".inbox-card").first()).toContainText("A fresh direct update.");
  await expect(page.locator(".inbox-card.unread")).toHaveCount(1);
  expect(activityRequests.length).toBe(requests);
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
    await expect(scope.getByRole("button", { name: inThread ? "Refresh thread" : "Jump to recent", exact: true })).toBeVisible();
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
      await expect(page.locator("main").getByRole("button", { name: "Jump to recent", exact: true })).toBeVisible();
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
    await expect(page.locator("main").getByRole("button", { name: "Jump to recent", exact: true })).toHaveCount(reading === "live" ? 0 : 1);
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
  await expect(page.locator("main").getByRole("button", { name: "Jump to recent", exact: true })).toBeVisible();
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
