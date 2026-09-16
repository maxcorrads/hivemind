import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCard } from './TaskCard.tsx';
import type { TaskSnapshot } from '../src/shared/tasks.ts';
import type { Message } from '../src/shared/types.ts';
import type { ChannelPayload } from './api.ts';
import { selectThread, beginThreadLoad, failThreadLoad, receiveThreadMessage, receiveThreadTask, receiveThreadSnapshot, reconcileTask } from './thread-state.ts';

const task: TaskSnapshot = { id: 'fixture', channelId: 'room', assignerId: 'b', assignerName: 'Brain', workerId: 'w', workerName: 'Worker',
  revision: 1, contractVersion: 1, state: 'sent', dispatchSeq: 1, receivedAt: null, lastEventSeq: 1, updatedAt: 0,
  contract: { objective: 'Parse <script>fixture</script>', scope: [], nonGoals: [], acceptanceCriteria: ['Valid result'], dependencies: [], evidenceSeqs: [] },
  result: null, review: null };
test('task UI distinguishes each lifecycle state without inferring completion from receipt', () => {
  for (const state of ['sent', 'delivered', 'accepted', 'rejected', 'blocked', 'result_submitted', 'changes_requested', 'accepted_complete'] as const) {
    const html = renderToStaticMarkup(<TaskCard task={{ ...task, state }} />);
    assert.ok(html.includes(state.replaceAll('_', ' ')));
    assert.ok(html.includes('receipt is not acceptance'));
  }
  assert.ok(renderToStaticMarkup(<TaskCard task={{ ...task, state: 'delivered', receivedAt: 1 }} />).includes('Worker confirmed receipt'));
});
test('task UI escapes contract data and labels check results as unverified reports', () => {
  const html = renderToStaticMarkup(<TaskCard task={{ ...task, state: 'result_submitted', result: {
    summary: 'Done', artifacts: ['out/report.txt'], checks: [{ name: 'unit', outcome: 'passed', evidenceSeqs: [] }], gaps: ['No runtime test'], evidenceSeqs: [] } }} />);
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('not independently verified')); assert.ok(html.includes('No runtime test'));
  assert.ok(html.includes('not accepted-complete'));
});
test('accepted completion identifies a separate assigning-brain review', () => {
  const html = renderToStaticMarkup(<TaskCard task={{ ...task, state: 'accepted_complete', review: {
    reviewerId: 'b', decision: 'accepted', summary: 'Reviewed the diff' } }} />);
  assert.ok(html.includes('Assigning brain review')); assert.ok(html.includes('Reviewed the diff'));
  assert.ok(!html.includes('No review decision'));
});

function message(seq: number, threadId: string | null = task.id): Message {
  return { id: `message-${seq}`, seq, channelId: task.channelId, threadId, authorId: 'w', authorName: 'Worker',
    authorRole: 'worker', body: `Event ${seq}`, kind: 'chat', control: null, mentions: [], createdAt: seq };
}
function snapshot(currentTask: TaskSnapshot | undefined = task, messages: Message[] = []): ChannelPayload {
  return { channel: { id: task.channelId, name: 'Room', type: 'private', topic: null, createdBy: 'b',
    createdAt: 0, memberIds: ['b', 'w'], projectId: 'project', project: 'project' },
    task: currentTask, messages, threads: [], replyCounts: {} };
}

function loaded(data: ChannelPayload) {
  return receiveThreadSnapshot(beginThreadLoad(null, task.channelId, task.id, 1), task.id, data, 1)!;
}

test('delayed reconnect response cannot undo a live review or remove its message', async () => {
  const submitted: TaskSnapshot = { ...task, revision: 3, state: 'result_submitted' };
  const complete: TaskSnapshot = { ...submitted, revision: 4, state: 'accepted_complete',
    review: { reviewerId: 'b', decision: 'accepted', summary: 'Reviewed' } };
  const oldResponse = snapshot(submitted, [message(1), message(2), message(3)]);
  let view = beginThreadLoad(loaded(oldResponse), task.channelId, task.id, 2);
  let respond!: (value: ChannelPayload) => void;
  const pending = new Promise<ChannelPayload>(resolve => { respond = resolve; }).then(data => {
    view = receiveThreadSnapshot(view, task.id, data, 2)!;
  });
  view = receiveThreadMessage(view, message(4));
  view = receiveThreadTask(view, complete);
  respond(oldResponse);
  await pending;
  assert.equal(view.pane!.task!.revision, 4);
  assert.equal(view.pane!.task!.state, 'accepted_complete');
  assert.deepEqual(view.pane!.task!.review, complete.review);
  assert.deepEqual(view.pane!.messages.map(m => m.seq), [1, 2, 3, 4]);
  assert.equal(receiveThreadTask(view, submitted).pane!.task!.revision, 4);
});

test('live events arriving before the first HTTP response are retained and deduplicated', () => {
  let view = beginThreadLoad(null, task.channelId, task.id, 1);
  view = receiveThreadMessage(view, message(3));
  view = receiveThreadMessage(view, message(2));
  view = receiveThreadMessage(view, message(3));
  view = receiveThreadTask(view, { ...task, revision: 2, state: 'accepted' });
  assert.equal(view.pane, null);
  view = receiveThreadSnapshot(view, task.id, snapshot(task, [message(1), message(2)]), 1)!;
  assert.equal(view.pane!.task!.state, 'accepted');
  assert.deepEqual(view.pane!.messages.map(m => m.seq), [1, 2, 3]);
  assert.deepEqual(view.pendingMessages, []);
  assert.equal(view.pendingTask, undefined);
});

test('receipt survives an older snapshot without increasing revision or accepting work', () => {
  const received: TaskSnapshot = { ...task, receivedAt: 123, state: 'delivered' };
  for (const [current, incoming] of [[received, task], [task, received]]) {
    const merged = reconcileTask(current, incoming)!;
    assert.equal(merged.receivedAt, 123);
    assert.equal(merged.state, 'delivered');
    assert.equal(merged.revision, 1);
  }
  const accepted: TaskSnapshot = { ...task, revision: 2, state: 'accepted' };
  for (const [current, incoming] of [[received, accepted], [accepted, received]]) {
    const merged = reconcileTask(current, incoming)!;
    assert.equal(merged.receivedAt, 123);
    assert.equal(merged.state, 'accepted');
    assert.equal(merged.revision, 2);
  }
});

test('a newer contract resets receipt and completion even when an old ACK arrives later', () => {
  const completed: TaskSnapshot = { ...task, revision: 4, receivedAt: 123, state: 'accepted_complete',
    review: { reviewerId: 'b', decision: 'accepted', summary: 'Reviewed' } };
  const revised: TaskSnapshot = { ...task, revision: 5, contractVersion: 2, dispatchSeq: 5 };
  for (const [current, incoming] of [[completed, revised], [revised, completed]]) {
    assert.deepEqual(reconcileTask(current, incoming), revised);
  }
});

test('responses and events from another thread or channel cannot overwrite the selection', () => {
  const original = selectThread(null, task.channelId, task.id);
  assert.equal(selectThread(original, task.channelId, task.id), original);
  const other = beginThreadLoad(original, task.channelId, 'other-root', 2);
  assert.equal(receiveThreadSnapshot(other, task.id, snapshot(), 2), other);
  assert.equal(receiveThreadMessage(other, message(2)), other);
  assert.equal(receiveThreadTask(other, task), other);
  const otherChannel = beginThreadLoad(original, 'other-room', task.id, 2);
  assert.equal(receiveThreadSnapshot(otherChannel, task.id, snapshot(), 2), otherChannel);
  assert.equal(receiveThreadMessage(otherChannel, message(2)), otherChannel);
  assert.equal(receiveThreadTask(otherChannel, task), otherChannel);
  assert.equal(receiveThreadSnapshot(null, task.id, snapshot(), 1), null);
  assert.equal(other.pane, null);
  assert.deepEqual(other.pendingMessages, []);
});

test('ordinary thread refresh still updates metadata and retains live replies', () => {
  const original = snapshot();
  delete original.task;
  original.messages = [message(1)];
  let view = loaded(original);
  view = receiveThreadMessage(view, message(2));
  view = beginThreadLoad(view, task.channelId, task.id, 2);
  const refreshed = { ...original, messages: [{ ...message(1), reactions: [{ emoji: '👍', count: 1 }] }] };
  view = receiveThreadSnapshot(view, task.id, refreshed, 2)!;
  assert.equal(view.pane!.task, undefined);
  assert.deepEqual(view.pane!.messages.map(m => m.seq), [1, 2]);
  assert.equal(view.pane!.messages[0].reactions![0].count, 1);
});

test('late HTTP cannot erase an added reaction or resurrect a removed one', async () => {
  const withoutReaction: Message = { ...message(1), reactions: [] };
  const withReaction: Message = { ...message(1), reactions: [{ emoji: '👍', count: 1, mine: true }] };
  for (const initialLoad of [false, true]) {
    for (const [before, after] of [[withoutReaction, withReaction], [withReaction, withoutReaction]]) {
      const stale = snapshot(task, [before]);
      let view = beginThreadLoad(initialLoad ? null : loaded(stale), task.channelId, task.id, 2);
      let respond!: (data: ChannelPayload) => void;
      const request = new Promise<ChannelPayload>(resolve => { respond = resolve; }).then(data => {
        view = receiveThreadSnapshot(view, task.id, data, 2)!;
      });
      view = receiveThreadMessage(view, after);
      respond(stale);
      await request;
      assert.deepEqual(view.pane!.messages[0].reactions, after.reactions);
      assert.equal(view.pane!.messages.length, 1);
      assert.equal(view.pendingLoad, undefined);
    }
  }
});

test('a fresh load recovers reactions changed while disconnected, including before first render', () => {
  const before: Message = { ...message(1), reactions: [{ emoji: '👍', count: 1 }] };
  const after: Message = { ...message(1), reactions: [] };
  for (const initialLoad of [false, true]) {
    let view = initialLoad ? selectThread(null, task.channelId, task.id) : loaded(snapshot(task, [after]));
    view = receiveThreadMessage(view, before);
    view = beginThreadLoad(view, task.channelId, task.id, 2);
    view = receiveThreadSnapshot(view, task.id, snapshot(task, [after]), 2)!;
    assert.deepEqual(view.pane!.messages[0].reactions, []);
  }
});

test('overlapping loads accept only the latest request and overlay only its live updates', () => {
  const before: Message = { ...message(1), reactions: [] };
  const addition: Message = { ...message(1), reactions: [{ emoji: '👍', count: 1 }] };
  const removedAgain = snapshot(task, [before]);
  for (const oldArrivesFirst of [false, true]) {
    let view = beginThreadLoad(loaded(removedAgain), task.channelId, task.id, 2);
    view = receiveThreadMessage(view, addition);
    // A later reconnect must not preserve a pre-request reaction that its snapshot removed.
    view = beginThreadLoad(view, task.channelId, task.id, 3);
    view = receiveThreadMessage(view, message(2));
    const stale = snapshot(task, [addition]);
    if (oldArrivesFirst) assert.equal(receiveThreadSnapshot(view, task.id, stale, 2), view);
    view = receiveThreadSnapshot(view, task.id, removedAgain, 3)!;
    assert.equal(receiveThreadSnapshot(view, task.id, stale, 2), view);
    assert.deepEqual(view.pane!.messages[0].reactions, []);
    assert.deepEqual(view.pane!.messages.map(m => m.seq), [1, 2]);
  }
});

test('returning to a thread does not admit the previous visit\'s outstanding response', () => {
  let view = beginThreadLoad(null, task.channelId, task.id, 1);
  view = beginThreadLoad(view, task.channelId, 'different-thread', 2);
  view = beginThreadLoad(view, task.channelId, task.id, 3);
  assert.equal(receiveThreadSnapshot(view, task.id, snapshot(), 1), view);
  assert.equal(view.pane, null);
  view = receiveThreadSnapshot(view, task.id, snapshot(), 3)!;
  assert.equal(view.pane!.task!.id, task.id);
});

test('failed loads release their buffer without discarding live data or cancelling a newer load', () => {
  let view = beginThreadLoad(loaded(snapshot(task, [message(1)])), task.channelId, task.id, 2);
  view = receiveThreadMessage(view, message(2));
  view = failThreadLoad(view, 2)!;
  assert.equal(view.pendingLoad, undefined);
  assert.deepEqual(view.pane!.messages.map(m => m.seq), [1, 2]);
  view = beginThreadLoad(view, task.channelId, task.id, 3);
  assert.equal(failThreadLoad(view, 2), view);
  assert.equal(view.pendingLoad!.id, 3);
});
