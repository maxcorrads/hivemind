import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomDetails } from './RoomPanel.tsx';
import type { RoomView } from '../src/shared/rooms.ts';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import { TaskCard } from './TaskCard.tsx';
import { reconcileTask } from './thread-state.ts';
import { loadLatestRoomView } from './room-state.ts';

const view: RoomView = { room: { channelId: 'fixture', revision: 3, contractVersion: 2, state: 'archived', coordinatorId: 'brain', participantIds: ['worker'],
  contract: { mode: 'ongoing', purpose: '<script>not markup</script>', rules: ['Only inspect'], limits: ['Do not publish'], coordinator: 'FixtureBrain',
    participants: [{ name: 'FixtureWorker', boundary: 'Analysis' }], completion: ['Human ends monitoring'], originTaskId: null },
  updatedAt: 1, humanInstructionSeq: null, authoritySeq: 4, lastEventSeq: 4, summarySeq: null, archivedRunning: 'stop' },
  tasks: [], activeTaskCount: 0, tasksHasMore: false, nextTaskCursor: null,
  links: [{ id: 'source', botId: 'bot', label: 'Synthetic source', suspendSupported: true, desired: 'paused', generation: 2, observed: 'pending', detail: '', updatedAt: 1 }], unmanagedBots: ['LegacyFeed'] };
test('room UI separates archive from confirmed suspension and escapes untrusted text', () => {
  const html = renderToStaticMarkup(<RoomDetails view={view} />);
  assert.ok(html.includes('archived')); assert.ok(html.includes('reported pending')); assert.ok(html.includes('does not mean stopped'));
  assert.ok(html.includes('No lifecycle registration:')); assert.ok(html.includes('LegacyFeed'));
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('Do not publish'));
});
test('source errors and unsupported lifecycle remain visible, never relabelled stopped', () => {
  for (const state of ['failed', 'unsupported', 'paused'] as const) {
    const html = renderToStaticMarkup(<RoomDetails view={{ ...view, links: [{ ...view.links[0]!, observed: state, detail: 'Fixture explanation' }] }} />);
    assert.ok(html.includes(`reported ${state}`)); assert.ok(html.includes('Fixture explanation'));
  }
});
test('out-of-order task refresh cannot regress a newer room fence without changing task revision', () => {
  const task: TaskSnapshot = { id: 'task', channelId: 'fixture', assignerId: 'b', assignerName: 'Brain', workerId: 'w', workerName: 'Worker', revision: 2, contractVersion: 1,
    state: 'accepted', contract: { objective: 'Check', scope: [], nonGoals: [], acceptanceCriteria: ['Known value'], dependencies: [], evidenceSeqs: [] },
    dispatchSeq: 1, receivedAt: 1, lastEventSeq: 2, updatedAt: 1, result: null, review: null,
    room: { channelId: 'fixture', contractVersion: 1, currentVersion: 1, roomRevision: 1, actionKey: 'check', status: 'active', acknowledged: true } };
  const stopped = { ...task, room: { ...task.room!, status: 'stop_requested' as const, roomRevision: 3 } };
  assert.equal(reconcileTask(stopped, task)!.room!.status, 'stop_requested');
  const html = renderToStaticMarkup(<TaskCard task={stopped} />); assert.ok(html.includes('stop requested')); assert.ok(html.includes('not task completion'));
  const older = { ...task, room: { ...task.room!, status: 'needs_reconciliation' as const, roomRevision: 4 } };
  const rejected = { ...older, revision: 3, state: 'rejected' as const, room: { ...older.room, status: 'active' as const } };
  assert.equal(reconcileTask(rejected, older)!.room!.status, 'active', 'equal room revisions use the newest task state');
});

function deferredView() {
  let resolve!: (view: RoomView) => void, reject!: (error: Error) => void;
  const promise = new Promise<RoomView>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('post-save refresh preserves newer live state when earlier responses arrive late', async () => {
  const request = { current: 0 }, beforeSave = deferredView(), live = deferredView(), afterSave = deferredView();
  let shown: RoomView | null = null;
  const errors: unknown[] = [], receive = (v: RoomView) => { shown = v; }, fail = (e: unknown) => errors.push(e);
  const pendingBefore = loadLatestRoomView(request, () => beforeSave.promise, receive, fail);
  request.current++; // Starting a save invalidates reads predating it.
  const pendingLive = loadLatestRoomView(request, () => live.promise, receive, fail);
  live.resolve(view); await pendingLive;
  // The delayed POST does not apply its snapshot; it starts this fresh GET.
  const pendingAfter = loadLatestRoomView(request, () => afterSave.promise, receive, fail);
  const old = { ...view, room: { ...view.room!, revision: 2, state: 'active' as const } };
  beforeSave.resolve(old); await pendingBefore;
  assert.equal(shown, view);
  afterSave.resolve(view); await pendingAfter;
  assert.equal(shown, view); assert.deepEqual(errors, []);
});

test('latest read wins for source/task updates even when room revision is unchanged', async () => {
  const request = { current: 0 }, older = deferredView(), latest = deferredView();
  let shown: RoomView | null = null;
  const receive = (v: RoomView) => { shown = v; };
  const a = loadLatestRoomView(request, () => older.promise, receive, e => assert.fail(String(e)));
  const b = loadLatestRoomView(request, () => latest.promise, receive, e => assert.fail(String(e)));
  const reported: RoomView = { ...view, activeTaskCount: 1, links: [{ ...view.links[0]!, observed: 'paused' }] };
  latest.resolve(reported); await b;
  older.resolve(view); await a;
  assert.equal(shown, reported);
});

test('a newer live read is not invalidated by completion of an earlier post-save refresh', async () => {
  const request = { current: 0 }, afterSave = deferredView(), live = deferredView();
  let shown: RoomView | null = null;
  const receive = (v: RoomView) => { shown = v; };
  const a = loadLatestRoomView(request, () => afterSave.promise, receive, e => assert.fail(String(e)));
  const b = loadLatestRoomView(request, () => live.promise, receive, e => assert.fail(String(e)));
  afterSave.resolve(view); await a;
  assert.equal(shown, null);
  const reopened: RoomView = { ...view, room: { ...view.room!, revision: 4, state: 'active' } };
  live.resolve(reopened); await b;
  assert.equal(shown, reopened);
});

test('failed refresh preserves displayed state and stale or unmounted reads cannot report errors', async () => {
  const request = { current: 0 }, stale = deferredView(), current = deferredView();
  let shown: RoomView = view;
  const errors: unknown[] = [], receive = (v: RoomView) => { shown = v; }, fail = (e: unknown) => errors.push(e);
  const a = loadLatestRoomView(request, () => stale.promise, receive, fail);
  const b = loadLatestRoomView(request, () => current.promise, receive, fail);
  stale.reject(new Error('Obsolete failure')); await a;
  assert.deepEqual(errors, []);
  const currentError = new Error('Refresh unavailable'); current.reject(currentError); await b;
  assert.equal(shown, view); assert.deepEqual(errors, [currentError]);
  for (const rejects of [false, true]) {
    const unmounted = deferredView();
    const pending = loadLatestRoomView(request, () => unmounted.promise, receive, fail);
    request.current++; // Effect cleanup invalidates the pending read.
    if (rejects) unmounted.reject(new Error('Unmounted failure'));
    else unmounted.resolve({ ...view, room: null });
    await pending;
    assert.equal(shown, view); assert.deepEqual(errors, [currentError]);
  }
});
