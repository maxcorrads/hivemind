import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JevCallLogView, JevCallSummary } from '../src/shared/jev-calls.ts';
import { LIVE_MESSAGE_WINDOW } from '../src/shared/realtime.ts';
import type { Message } from '../src/shared/types.ts';
import type { ChannelPayload } from './api.ts';
import { createThrottle, createUpdateBatch, type Timers } from './coalesce.ts';
import { mergeLiveCall, mergeRefreshedPage } from './jev-log-view.ts';
import { boundLivePane, HELD_MESSAGE_WINDOW } from './pane-window.ts';

function fakeTimers() {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    set: (run, ms) => { const id = next++; pending.set(id, { at: now + ms, run }); return id; },
    clear: handle => { pending.delete(handle as number); },
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

test('a throttle runs the first request at once and a burst once at the end of the window', () => {
  const clock = fakeTimers();
  let runs = 0;
  const throttle = createThrottle(() => { runs++; }, 250, clock.timers);
  throttle.request();
  assert.equal(runs, 1, 'leading edge');
  for (let i = 0; i < 50; i++) throttle.request();
  assert.equal(runs, 1);
  clock.advance(249);
  assert.equal(runs, 1);
  clock.advance(1);
  assert.equal(runs, 2, 'one trailing run for the whole burst');
  clock.advance(250);
  assert.equal(runs, 2, 'no run without a request');
  assert.equal(clock.pending(), 0, 'an idle throttle holds no timer');
  throttle.request();
  assert.equal(runs, 3, 'after a quiet window the next request is immediate again');
  throttle.request();
  throttle.cancel();
  clock.advance(1_000);
  assert.equal(runs, 3, 'cancel drops the pending trailing run');
});

test('an update batch applies a burst of updaters in order with one setState', () => {
  const clock = fakeTimers();
  let state = { agents: [] as string[], queued: 0 };
  let commits = 0;
  const batch = createUpdateBatch<typeof state>(update => { commits++; state = update(state); }, 50, clock.timers);
  batch.push(s => ({ ...s, agents: [...s.agents, 'a'] }));
  assert.equal(commits, 1);
  for (let i = 0; i < 100; i++) batch.push(s => ({ ...s, queued: s.queued + 1 }));
  batch.push(s => ({ ...s, agents: [...s.agents, 'b'] }));
  assert.equal(commits, 1);
  clock.advance(50);
  assert.equal(commits, 2);
  assert.deepEqual(state, { agents: ['a', 'b'], queued: 100 });
  clock.advance(50); // The window after the trailing run closes with nothing queued.
  batch.push(s => ({ ...s, queued: -1 }));
  batch.push(s => ({ ...s, queued: -2 }));
  batch.cancel();
  clock.advance(100);
  assert.equal(state.queued, -1, 'cancel drops queued updates superseded by a fresh snapshot');
});

function call(id: string, executionId: string, createdAt: number, patch: Partial<JevCallSummary> = {}): JevCallSummary {
  return { id, routeId: `route-${id}`, projectId: 'p', channelId: 'dm', executionId, brainId: 'brain', createdAt,
    phase: 'initial', trigger: { kind: 'human_request', eventType: null }, request: `Request ${executionId}`, status: 'ok',
    targetTopology: 'single', targetWorkers: 0, confidence: 0.9, reason: 'single_sufficient', error: null,
    model: 'jev', latencyMs: 1, inputTokens: 1, outputTokens: 1, outcome: null, ...patch };
}
function group(executionId: string, calls: JevCallSummary[]) {
  return { executionId, channelId: 'dm', brainId: 'brain', request: `Request ${executionId}`, firstAt: calls[0]!.createdAt,
    lastAt: calls.at(-1)!.createdAt, callCount: calls.length, calls };
}

test('a live Jev call joins, settles or opens its request group in page order without a refetch', () => {
  const older = group('exec-old', [call('o1', 'exec-old', 100)]);
  const recent = group('exec-recent', [call('r1', 'exec-recent', 200)]);
  const view: JevCallLogView = { requests: [recent, older], hasMore: true, nextCursor: 'cursor' };
  const joined = mergeLiveCall(view, call('o2', 'exec-old', 300));
  assert.deepEqual(joined.requests.map(g => g.executionId), ['exec-old', 'exec-recent'], 'new activity moves the request first');
  assert.equal(joined.requests[0]!.callCount, 2);
  assert.equal(joined.requests[0]!.lastAt, 300);
  assert.deepEqual(joined.requests[0]!.calls.map(c => c.id), ['o1', 'o2']);
  assert.equal(joined.nextCursor, 'cursor', 'the older-page cursor is untouched');
  const settled = mergeLiveCall(joined, call('o2', 'exec-old', 300, { status: 'unavailable', error: 'timeout' }));
  assert.equal(settled.requests[0]!.callCount, 2, 'a settled call replaces its entry');
  assert.equal(settled.requests[0]!.calls[1]!.status, 'unavailable');
  const opened = mergeLiveCall(settled, call('n1', 'exec-new', 400));
  assert.deepEqual(opened.requests.map(g => g.executionId), ['exec-new', 'exec-old', 'exec-recent']);
  assert.deepEqual(opened.requests[0], group('exec-new', [call('n1', 'exec-new', 400)]));
  // A later refetch of the newest page reconciles with the merged view without duplicates.
  const refreshed = mergeRefreshedPage(opened, { requests: [opened.requests[0]!, opened.requests[1]!], hasMore: true, nextCursor: 'c2' });
  assert.deepEqual(refreshed.requests.map(g => g.executionId), ['exec-new', 'exec-old', 'exec-recent']);
});

function row(seq: number): Message {
  return { id: `m-${seq}`, seq, channelId: 'c', threadId: null, body: `${seq}`, authorId: 'h', authorName: 'H', authorRole: 'human',
    kind: 'chat', control: null, mentions: [], createdAt: seq };
}

test('a held pane stays bounded while paging back: the oldest rows are kept and returning to live recovers the rest', () => {
  const count = HELD_MESSAGE_WINDOW + 300;
  const pane: ChannelPayload = { channel: { id: 'c' } as ChannelPayload['channel'], threadId: null,
    messages: Array.from({ length: count }, (_, i) => row(i + 1)), historyThrough: count, hasOlder: true,
    threads: [{ id: 'm-1', channelId: 'c', status: 'open' }, { id: `m-${count}`, channelId: 'c', status: 'done' }],
    replyCounts: { 'm-1': 1, [`m-${count}`]: 4 } };
  const bounded = boundLivePane(pane);
  assert.equal(bounded.messages.length, HELD_MESSAGE_WINDOW);
  assert.equal(bounded.messages[0]!.seq, 1, 'the page being read is kept');
  assert.equal(bounded.historyThrough, HELD_MESSAGE_WINDOW);
  assert.equal(bounded.deferredLive, true, 'the dropped newest rows are offered through Return to live');
  assert.equal(bounded.hasOlder, true);
  assert.deepEqual(bounded.threads.map(t => t.id), ['m-1']);
  assert.deepEqual(bounded.replyCounts, { 'm-1': 1 });
  assert.ok(HELD_MESSAGE_WINDOW > LIVE_MESSAGE_WINDOW);
  const small = { ...pane, messages: pane.messages.slice(0, 10), historyThrough: 10 };
  assert.equal(boundLivePane(small), small, 'a held pane within bounds is unchanged');
});
