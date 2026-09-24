import { expect, test, type Page, type Route, type WebSocketRoute } from './fixtures.ts';
import type { Agent, Channel, Message, Project } from '../../src/shared/types.ts';
import type { TaskSnapshot } from '../../src/shared/tasks.ts';
import type { TimelineView } from '../../src/shared/timeline.ts';
import type { ChannelPayload, Snapshot } from '../../web/api.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const human: Agent = { id: 'human', name: 'Human', role: 'human', seniority: null, focus: null,
  online: true, lastSeenAt: 1, createdAt: 1, projectId: null, project: null };
const project: Project = { id: 'project-alpha', slug: 'alpha', name: 'Alpha Hive', worktree: null, createdAt: 1 };
const a: Channel = { id: 'a', name: 'Alpha', type: 'public', topic: null, memberIds: ['human'],
  createdBy: 'human', createdAt: 1, projectId: project.id, project: project.slug };
const b: Channel = { ...a, id: 'b', name: 'Beta' };
function message(id: string, seq: number, threadId: string | null, body = id): Message {
  return { id, seq, channelId: a.id, threadId, body, authorId: 'human', authorName: 'Human',
    authorRole: 'human', kind: 'chat', control: null, mentions: [], createdAt: 1_780_000_000_000 + seq, reactions: [] };
}
const root = message('root', 1, null, 'Conversation root');
const thumbs = (count: number): Message['reactions'] => [{ emoji: '👍', count, mine: false }];
const diagnostics = new WeakMap<Page, { unexpected: string[]; errors: string[] }>();
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect(diagnostics.get(page)?.unexpected ?? []).toEqual([]);
  expect(diagnostics.get(page)?.errors ?? []).toEqual([]);
});

/** All HTTP/WS traffic is intercepted. No test can reach a running hive/provider. */
async function fixture(page: Page, inThread: boolean) {
  const log = { unexpected: [] as string[], errors: [] as string[] };
  diagnostics.set(page, log);
  page.on('pageerror', error => log.errors.push(error.message));
  const threadId = inThread ? root.id : null;
  const history = Array.from({ length: 40 }, (_, n) => message(`old-${n}`, n + 2, threadId,
    `History ${n}: ${'A long message to make reading history scrollable. '.repeat(8)}`));
  let seq = 41, revision = 0, posts = 0, reads = 0, sent: Message | null = null;
  let task: TaskSnapshot | undefined;
  let socket: WebSocketRoute | undefined, eventSequence = 0;
  const snap = (): Snapshot => ({ you: human, projects: [project], agents: [human], channels: [a, b],
    readInstance: 'post-send-fixture', readSeq: seq, readRevision: revision, unread: {}, mentionCounts: {},
    mentions: [], mentionsHasMore: false, queued: {}, telegram: { configured: false, running: false } });
  const data = (messages: Message[], tid = threadId, ch = a): ChannelPayload => ({ channel: ch, threadId: tid, messages,
    threads: [{ id: root.id, channelId: a.id, status: 'open' }], replyCounts: {},
    snapshotSeq: Math.max(0, ...messages.map(m => m.seq)), hasOlder: false, hasNewer: false,
    ...(tid === root.id && task ? { task } : {}) });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const scope = page.locator(inThread ? 'aside.thread' : 'main');
  const h = {
    scope, history, data, json,
    onRead: null as null | ((route: Route, index: number) => Promise<void>),
    get posts() { return posts; },
    get sent(): Message { if (!sent) throw new Error('No committed send yet'); return sent; },
    latest(reactions: Message['reactions'] = [], omitSent = false): ChannelPayload {
      return data([...history, message('missed', 100, threadId, 'Previously unseen message'),
        ...(omitSent ? [] : [{ ...h.sent, reactions }])]);
    },
    emit(type: string, payload: unknown) {
      if (!socket) throw new Error('Fixture WebSocket not ready');
      socket.send(JSON.stringify({ type, payload, streamId: 'post-send-stream', sequence: ++eventSequence }));
    },
    trigger(kind: 'task' | 'decision' | 'room' | 'project') {
      if (kind === 'task') {
        task = { id: root.id, channelId: a.id, assignerId: 'brain', assignerName: 'Brain', workerId: 'worker', workerName: 'Worker',
          revision: 2, contractVersion: 1, state: 'accepted', dispatchSeq: 1, receivedAt: 1, lastEventSeq: 90, updatedAt: 90,
          result: null, review: null, contract: { objective: 'Keep the confirmed reply visible', scope: [], nonGoals: [],
            acceptanceCriteria: ['Confirmed reply visible'], dependencies: [], evidenceSeqs: [] } };
        h.emit(kind, task);
      } else h.emit(kind, kind === 'decision' ? { id: 'decision', taskId: root.id, channelId: a.id } : { channelId: a.id });
    },
    async sendFromHistory() {
      await scope.locator('.stream').evaluate(el => { el.scrollTop = 0; });
      await expect(scope.getByRole('button', { name: inThread ? 'Refresh thread' : 'Jump to recent', exact: true })).toBeVisible();
      await scope.locator('.composer textarea').fill('My confirmed message');
      await scope.locator('.composer textarea').press('Enter');
    },
    async expectConfirmed() {
      await expect(scope.getByText('My confirmed message', { exact: true })).toHaveCount(1);
      await expect(scope.getByText('My confirmed message', { exact: true })).toBeInViewport();
      await expect(scope.getByText('Previously unseen message', { exact: true })).toHaveCount(1);
      await expect(scope.locator('.composer textarea')).toHaveValue('');
      await expect(scope.getByRole('button', { name: /jump to recent|refresh thread/i })).toHaveCount(0);
      await expect.poll(() => scope.locator('.stream').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
      expect(posts).toBe(1);
    },
  };
  await page.route('**/api/**', route => {
    log.unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return json(route, { error: 'Unmocked fixture request' }, 501);
  });
  await page.route('**/api/ui/session', route => json(route, { ok: true }));
  await page.route('**/api/ui/snapshot', route => json(route, snap()));
  await page.route('**/api/ui/read-state', route => json(route, snap()));
  await page.route('**/api/ui/nav-status', route => json(route, { awaitingDecisions: {}, agentWork: {} }));
  await page.route('**/api/ui/read', route => { revision++; return json(route, snap()); });
  await page.route('**/api/ui/activity?*', route => json(route, { ...snap(), items: [], hasMore: false }));
  await page.route('**/api/ui/channels/*/room', route => json(route, { room: null, tasks: [], activeTaskCount: 0,
    tasksHasMore: false, nextTaskCursor: null, links: [], unmanagedBots: [] }));
  await page.route('**/api/ui/channels/*/tasks', route => json(route, { items: [], hasMore: false }));
  await page.route('**/api/ui/decisions?*', route => json(route, { items: [], awaiting: 0, warning: '' }));
  // Mounting TaskCard also mounts its timeline. Keep this expected read local;
  // the catch-all above must still fail any genuinely unexpected API request.
  const timeline: TimelineView = { traceId: root.id, taskId: root.id,
    truncated: false, warning: 'Synthetic fixture timeline', events: [] };
  await page.route('**/api/ui/tasks/root/timeline', route => json(route, { timeline }));
  await page.route('**/api/ui/channels/*/messages*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/channels/b/')) return json(route, data([{ ...message('beta', 200, null, 'Other conversation'), channelId: b.id }], null, b));
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { body: string; threadId: string | null };
      expect(body.threadId).toBe(threadId);
      posts++;
      sent = message('confirmed', 101, threadId, body.body);
      seq = 101;
      return json(route, { message: sent }); // Deliberately no WebSocket echo.
    }
    if (inThread && !url.searchParams.get('threadId')) return json(route, data([root], null));
    if (sent) {
      reads++;
      if (h.onRead) return h.onRead(route, reads);
      return json(route, h.latest());
    }
    return json(route, data(history));
  });
  await page.routeWebSocket('**/ws', current => { socket = current; h.emit('hello', null); });
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(inThread ? '/#/c/a/t/root' : '/#/c/a');
  await expect(scope.locator('.msg')).toHaveCount(40);
  await expect(page.locator('.pulse')).toHaveClass(/on/);
  await expect.poll(() => scope.locator('.stream').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
  return h;
}

for (const trigger of ['task', 'decision', 'room'] as const) {
  test(`post-send thread refresh survives a competing ${trigger} read`, async ({ page }) => {
    const h = await fixture(page, true), requested = deferred(), release = deferred(), settled = deferred();
    h.onRead = async (route, index) => {
      if (index === 1) {
        requested.resolve();
        await release.promise;
        try { await h.json(route, h.data(h.history)); } finally { settled.resolve(); }
      } else await h.json(route, h.latest(thumbs(1)));
    };
    try {
      await h.sendFromHistory();
      await requested.promise;
      h.trigger(trigger);
      await h.expectConfirmed();
      await expect(h.scope.locator('.msg').filter({ hasText: 'My confirmed message' }).locator('.reacts .react')).toHaveText('👍1');
      release.resolve();
      await settled.promise;
      await h.expectConfirmed();
    } finally { release.resolve(); }
  });
}

for (const inThread of [false, true]) {
  for (const source of ['snapshot', 'live', 'missing'] as const) {
    test(`post-send metadata precedence ${source} (thread=${inThread})`, async ({ page }) => {
      const h = await fixture(page, inThread), requested = deferred(), release = deferred();
      h.onRead = async route => {
        const snapshot = h.latest(thumbs(1), source === 'missing');
        requested.resolve();
        await release.promise;
        await h.json(route, snapshot);
      };
      try {
        await h.sendFromHistory();
        await requested.promise;
        if (source === 'live') {
          h.emit('reaction', { message: { ...h.sent, reactions: thumbs(2) } });
          // The second event is an observable delivery barrier for the first.
          h.emit('reaction', { message: { ...h.history[0]!, reactions: thumbs(9) } });
          await expect(h.scope.locator('.msg').first().locator('.reacts .react')).toHaveText('👍9');
        }
        release.resolve();
        await h.expectConfirmed();
        const reactions = h.scope.locator('.msg').filter({ hasText: 'My confirmed message' }).locator('.reacts .react');
        if (source === 'missing') await expect(reactions).toHaveCount(0);
        else await expect(reactions).toHaveText(source === 'live' ? '👍2' : '👍1');
      } finally { release.resolve(); }
    });
  }

  test(`failed replacement refresh is recoverable without another send (thread=${inThread})`, async ({ page }) => {
    const h = await fixture(page, inThread), requested = deferred(), release = deferred();
    h.onRead = async (route, index) => {
      if (index === 1) { requested.resolve(); await release.promise; await h.json(route, h.data(h.history)); }
      else if (index === 2) await h.json(route, { error: 'Fixture refresh failure' }, 503);
      else await h.json(route, h.latest());
    };
    try {
      await h.sendFromHistory();
      await requested.promise;
      h.trigger(inThread ? 'room' : 'project');
      await expect(page.locator('main .err')).toContainText(inThread ? 'could not refresh' : 'Fixture refresh failure');
      await expect(h.scope.locator('.msg')).toHaveCount(40);
      await h.scope.getByRole('button', { name: /jump to recent|refresh thread/i }).click();
      await h.expectConfirmed();
    } finally { release.resolve(); }
  });

  test(`navigation fences a delayed post-send response (thread=${inThread})`, async ({ page }) => {
    const h = await fixture(page, inThread), requested = deferred(), release = deferred(), settled = deferred();
    h.onRead = async route => {
      requested.resolve();
      await release.promise;
      try { await h.json(route, h.latest()); } finally { settled.resolve(); }
    };
    try {
      await h.sendFromHistory();
      await requested.promise;
      await page.getByRole('button', { name: '# Beta', exact: true }).click();
      await expect(page.getByText('Other conversation', { exact: true })).toBeVisible();
      release.resolve();
      await settled.promise;
      await expect(page.locator('aside.thread')).toHaveCount(0);
      await expect(page.getByText('My confirmed message', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Other conversation', { exact: true })).toBeVisible();
      expect(h.posts).toBe(1);
    } finally { release.resolve(); }
  });
}

test('reconnect replacement preserves channel post-send return-to-live', async ({ page }) => {
  const h = await fixture(page, false), requested = deferred(), release = deferred();
  h.onRead = async (route, index) => {
    if (index === 1) { requested.resolve(); await release.promise; await h.json(route, h.data(h.history)); }
    else await h.json(route, h.latest(thumbs(1)));
  };
  try {
    await h.sendFromHistory();
    await requested.promise;
    h.trigger('project'); // Uses the same resetReadConnection path as reconnect.
    await h.expectConfirmed();
    await expect(h.scope.locator('.msg').filter({ hasText: 'My confirmed message' }).locator('.reacts .react')).toHaveText('👍1');
  } finally { release.resolve(); }
});
