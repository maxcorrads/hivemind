/** Synthetic README fixtures and an isolated browser. No Hivemind backend or native bridge is started. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist/web');
export const now = Date.parse('2026-09-28T10:24:00Z');
export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const project = { id: id(1), slug: 'paperplane', name: 'Paperplane', worktree: null, createdAt: now - 86400000 };
const projects = [project, { ...project, id: id(2), slug: 'design-system', name: 'Design system' },
  { ...project, id: id(3), slug: 'documentation', name: 'Documentation' }];
function agent(n, name, role, seniority, focus) {
  return { id: role === 'human' ? 'human' : id(n), name, role, seniority, focus, online: true,
    lastSeenAt: now, createdAt: now - 86400000, projectId: role === 'human' ? null : project.id,
    project: role === 'human' ? null : project.slug };
}
export const human = agent(0, 'Human', 'human', null, null);
export const atlas = agent(10, 'Atlas', 'brain', null, 'coordination');
export const forge = agent(11, 'Forge', 'worker', 'senior', 'implementation');
export const prism = agent(12, 'Prism', 'worker', 'senior', 'review');
export const scout = agent(13, 'Scout', 'worker', 'mid', 'verification');
export const agents = [human, atlas, forge, prism, scout];
function channel(n, name, topic) {
  return { id: id(n), name, topic, type: 'public', createdBy: 'human', createdAt: now - 86400000,
    memberIds: agents.map(a => a.id), projectId: project.id, project: project.slug };
}
const general = channel(20, 'general', 'Product decisions, progress, and handoffs.');
export const shipping = channel(21, 'reading-lists', 'One release. Three focused workstreams.');
const brains = channel(22, 'brains', 'Coordination across the project.');
const channels = [general, shipping, brains];
export function message(n, author, body, threadId = null) {
  return { id: id(n), seq: n, channelId: shipping.id, threadId, authorId: author.id, authorName: author.name,
    authorRole: author.role, body, kind: 'chat', control: null, mentions: [], createdAt: now - (120 - n) * 60000 };
}
export const conversation = [
  message(100, human, "Let's ship **saved reading lists**. Readers should be able to collect books, reorder them, and pick up where they left off.\n\nKeep the first version focused: private lists, keyboard access, and reliable sync."),
  message(103, atlas, '**Three workstreams, one release**\n\n1. **Forge** — list creation, ordering, and persistence.\n2. **Prism** — independent review of the data model and UI.\n3. **Scout** — keyboard, empty-state, and sync checks.\n\nEach worker has its own task and branch. I will bring the results together before asking for release approval.'),
  message(107, forge, 'List creation and reordering are ready for review. The empty state and keyboard controls are included.\n\nBranch: `feat/reading-lists` · Relevant checks passed.'),
  message(110, prism, 'The review found one edge case: reordering during a sync retry. I have left a focused note in the implementation thread.'),
  message(116, atlas, '**Release checkpoint**\n\nImplementation and independent review are complete. Scout is finishing the final interaction checks.\n\nNext: accept the verification result, then prepare a short demo for Human.'),
];
export const replies = [
  message(108, atlas, 'Thanks, Forge. Please keep the ordering stable when a sync request is retried. Prism will review the updated result.', id(107)),
  message(111, forge, 'The retry now uses the existing operation ID. Replaying it preserves the same list order.\n\nAdded a regression check for an interrupted reorder.', id(107)),
  message(113, prism, '**Review complete**\n\n- Retry behavior is consistent.\n- Keyboard focus stays on the moved book.\n- Empty lists have a clear next action.\n\nNo remaining findings in this patch.', id(107)),
  message(115, atlas, 'Accepted. The implementation task is complete; the release still waits for the final interaction checks.', id(107)),
];
export const threads = [{ id: id(107), channelId: shipping.id, status: 'open', updatedAt: now - 300000 }];
const snapshot = { readInstance: 'readme-demo', readRevision: 1, readSeq: 120, mentionCounts: {},
  you: human, projects, agents, channels, unread: {}, mentions: [], mentionsHasMore: false, queued: {},
  telegram: { running: false, configured: false } };
const templates = [
  ['implementation', 'Implementation', 'codex', 'gpt-6-sol', 'xhigh', 'senior', 2, 'Build scoped features and fix bugs. Work on an isolated branch, verify the changed paths, and report a reviewable result.'],
  ['review', 'Independent review', 'claude', 'claude-opus-5-5', 'xhigh', 'senior', 1, 'Review a completed change independently. Report concrete correctness and regression risks with evidence.'],
  ['verification', 'Focused verification', 'claude', 'claude-sonnet-5-5', 'medium', 'mid', 2, 'Check a well-defined set of acceptance criteria. Record outcomes and flag any gaps before the task is closed.'],
].map(([slug, label, software, model, effort, seniority, maxConcurrent, description], i) => ({
  id: id(40 + i), projectId: project.id, slug, revision: 1, createdAt: now, updatedAt: now,
  spec: { label, description, software, model, effort, extraFlags: '', environment: {}, secretNames: [], seniority,
    focus: slug, maxConcurrent, enabled: true },
}));
const jobId = id(50);
const taskRows = [
  [forge, 'accepted_complete', 'Build saved reading lists and stable ordering', 0],
  [prism, 'result_submitted', 'Review the reading-list experience', 1],
  [scout, 'accepted', 'Verify keyboard access and sync recovery', 2],
];
const taskItems = taskRows.map(([worker, state, objective, templateIndex], i) => ({
  task: { id: id(60 + i), channelId: shipping.id, assignerId: atlas.id, assignerName: atlas.name,
    workerId: worker.id, workerName: worker.name, revision: 3, contractVersion: 1, state,
    contract: { objective, scope: ['Reading lists'], nonGoals: ['Public sharing'], acceptanceCriteria: ['Keyboard accessible', 'Stable ordering after retries'], dependencies: [], evidenceSeqs: [] },
    dispatchSeq: 80 + i, receivedAt: now - 1200000, lastEventSeq: 110 + i, updatedAt: now - (i + 1) * 120000,
    result: state === 'accepted' ? null : { summary: 'Completed the scoped demo work.', artifacts: [], checks: [], gaps: [] },
    review: state === 'accepted_complete' ? { decision: 'accept', summary: 'Scoped changes reviewed and accepted.' } : null, jobId },
  projectId: project.id, project: project.slug, worker, brain: atlas,
  template: { id: templates[templateIndex].id, label: templates[templateIndex].spec.label },
  traffic: { since: now - 3600000, bytes: 16000 + i * 4200, calls: 12 + i * 3, routes: {} },
  controls: { retryClose: false, resume: false },
}));
const taskPage = { items: taskItems, jobs: [{ id: jobId, projectId: project.id, brainId: atlas.id,
  originMessageId: id(100), title: 'Ship saved reading lists', state: 'active', revision: 1, createdAt: now - 3600000,
  updatedAt: now - 120000, closedAt: null, counts: { total: 3, completed: 1, cancelled: 0, paused: 0, active: 2 } }],
  hasMore: false, nextCursor: null };

/** The channel page the UI reads; `snapshotSeq` fences live replies at or below it. */
export function channelPage(threadId, messages, replyCounts, snapshotSeq) {
  return { channel: shipping, threadId, messages, hasOlder: false, hasNewer: false, threads, replyCounts, snapshotSeq,
    cursors: { before: messages[0]?.seq ?? null, after: messages.at(-1)?.seq ?? null } };
}

function fixture(url, request) {
  const endpoint = url.pathname;
  if (endpoint === '/api/ui/session') return { ok: true };
  if (['/api/ui/snapshot', '/api/ui/read-state', '/api/ui/read'].includes(endpoint)) return snapshot;
  if (endpoint === '/api/ui/nav-status') return { agentWork: {} };
  if (endpoint === '/api/ui/launch-requests') return { requests: [] };
  if (endpoint === '/api/ui/tasks') return taskPage;
  if (endpoint.endsWith('/adaptive-routing')) return { state: null, events: [] };
  if (endpoint.endsWith('/worker-templates')) return { templates };
  if (endpoint.endsWith('/tasks')) return { items: taskItems.map(item => item.task), hasMore: false };
  if (endpoint.endsWith('/room')) return { room: null, tasks: [], activeTaskCount: 3, tasksHasMore: false, nextTaskCursor: null, links: [], unmanagedBots: [] };
  if (endpoint.endsWith('/messages') && request.method() === 'GET') {
    const threadId = url.searchParams.get('threadId');
    return channelPage(threadId, threadId ? [conversation[2], ...replies] : conversation, { [id(107)]: 4 }, 120);
  }
}

/**
 * Open the built UI on a static loopback server with every API and WebSocket response
 * supplied in the browser. `api(url, request)` may answer first; `socket(send)`
 * receives a sender for well-formed realtime frames after the `hello`.
 */
export async function launchReadme({ viewport = { width: 1540, height: 960 }, recordVideo, api, socket: onSocket } = {}) {
  // This server only serves built files. It cannot proxy requests or open a hive database.
  const unexpected = [];
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
        unexpected.push(`Unmocked server request: ${url.pathname}`);
        response.writeHead(501).end(); return;
      }
      const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  let browser;
  const close = async () => {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, recordVideo,
      colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => unexpected.push(error.message));
    await page.clock.setFixedTime(now);
    await page.addInitScript(() => {
      localStorage.setItem('hivemind-theme', 'dark');
      localStorage.setItem('hivemind-sidebar-width', '270');
      localStorage.setItem('hivemind-thread-width', '420');
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(`Blocked network request: ${url.origin}`); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      const request = route.request();
      const data = api?.(url, request) ?? fixture(url, request);
      if (data === undefined) {
        unexpected.push(`Unmocked API request: ${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 501, body: '{}' }); return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.routeWebSocket('**/*', socket => {
      assert.equal(new URL(socket.url()).host, new URL(origin).host);
      let sequence = 1;
      socket.send(JSON.stringify({ type: 'hello', payload: null, streamId: 'readme-demo', sequence }));
      onSocket?.((type, payload) => socket.send(JSON.stringify({ type, payload, streamId: 'readme-demo', sequence: ++sequence })));
    });
    /** Settle the frame, then fail on any unexpected API, network, browser, or native operation. */
    const settle = async () => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(unexpected, [], 'Capture must have no unexpected API, network, or browser errors');
      assert.deepEqual(await page.evaluate(() => window.__readmeUnexpectedNative ?? []), [], 'Native operations must remain mocked');
    };
    return { origin, browser, context, page, unexpected, settle, close };
  } catch (error) {
    await close();
    throw error;
  }
}
