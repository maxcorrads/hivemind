import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channel, Message } from '../src/shared/types.ts';
import { LIVE_MESSAGE_WINDOW } from '../src/shared/realtime.ts';
import type { ChannelPayload } from './api.ts';
import { holdLivePane } from './pane-window.ts';
import { mergeConfirmations } from './message-confirmations.ts';
import {
  beginChannelJournal, recordChannelConfirmation, recordChannelMessage,
  reconcileChannelSnapshot,
} from './channel-state.ts';
import {
  beginThreadLoad, cancelThreadLoad, failThreadLoad, receiveThreadConfirmation,
  receiveThreadMessage, receiveThreadSnapshot, selectThread, type ThreadView,
} from './thread-state.ts';

const channel: Channel = { id: 'a', name: 'Alpha', type: 'public', topic: null,
  memberIds: ['human'], projectId: 'project-a', project: 'alpha', createdBy: 'human', createdAt: 1 };
function message(id: string, seq: number, threadId: string | null = null): Message {
  return { id, seq, channelId: channel.id, threadId, body: id, authorId: 'human', authorName: 'Human',
    authorRole: 'human', kind: 'chat', control: null, mentions: [], createdAt: seq, reactions: [] };
}
const root = message('root', 1), old = message('old', 2, root.id), sent = message('sent', 3, root.id);
const reacted = (m: Message): Message => ({ ...m, reactions: [{ emoji: '👍', count: 1, mine: false }] });
function payload(messages: Message[], threadId: string | null = null): ChannelPayload {
  return { channel, threadId, messages, threads: [{ id: root.id, channelId: channel.id, status: 'open' }],
    replyCounts: {}, snapshotSeq: Math.max(0, ...messages.map(m => m.seq)), hasOlder: false, hasNewer: false };
}
function held(): ThreadView {
  return { channelId: channel.id, threadId: root.id, pane: holdLivePane(payload([root, old], root.id)), pendingMessages: [] };
}
function start(): ThreadView {
  return beginThreadLoad(held(), channel.id, root.id, 1, true, [sent]);
}

test('post-send navigation and missing-echo fallback survive repeated same-thread replacements', () => {
  let view = start();
  for (let id = 2; id <= 5; id++) view = beginThreadLoad(view, channel.id, root.id, id);
  assert.equal(view.returnToLive, true);
  assert.deepEqual(view.pendingLoad!.liveMessages, []);
  view = receiveThreadSnapshot(view, root.id, payload([root, old], root.id), 5)!;
  assert.equal(view.pane!.historyThrough, undefined);
  assert.deepEqual(view.pane!.messages.map(m => m.id), ['root', 'old', 'sent']);
  assert.equal(view.returnToLive, undefined);
  assert.equal(view.confirmations, undefined);
});

test('a stale snapshot or failure cannot finish a replacement post-send load', () => {
  const view = beginThreadLoad(start(), channel.id, root.id, 2);
  assert.equal(receiveThreadSnapshot(view, root.id, payload([root], root.id), 1), view);
  assert.equal(failThreadLoad(view, 1), view);
  assert.equal(view.returnToLive, true);
});

test('latest failed refresh keeps both held history and pending send intent for a retry', () => {
  const failed = failThreadLoad(start(), 1)!;
  assert.equal(failed.pendingLoad, undefined);
  assert.equal(failed.pane!.historyThrough, 2);
  assert.equal(failed.returnToLive, true);
  const retry = beginThreadLoad(failed, channel.id, root.id, 2);
  const view = receiveThreadSnapshot(retry, root.id, payload([root, old], root.id), 2)!;
  assert.equal(view.pane!.historyThrough, undefined);
  assert.equal(view.pane!.messages.at(-1)!.id, sent.id);
});

test('explicit history navigation cancels post-send intent without losing ACK fallback', () => {
  const cancelled = cancelThreadLoad(start())!;
  assert.equal(cancelled.pendingLoad, undefined);
  assert.equal(cancelled.returnToLive, undefined);
  assert.equal(cancelThreadLoad(null), null);
  const reading = beginThreadLoad(cancelled, channel.id, root.id, 2);
  const view = receiveThreadSnapshot(reading, root.id, payload([root, old, sent], root.id), 2)!;
  assert.equal(view.pane!.historyThrough, 2);
  assert.deepEqual(view.pane!.messages.map(m => m.id), ['root', 'old']);
});

for (const [channelId, threadId] of [['b', root.id], [channel.id, 'other-root']]) {
  test(`selection change clears pending send state (${channelId}/${threadId})`, () => {
    const view = beginThreadLoad(start(), channelId!, threadId!, 2);
    assert.equal(view.returnToLive, undefined);
    assert.equal(view.confirmations, undefined);
    assert.equal(view.pane, null);
    assert.equal(receiveThreadConfirmation(view, sent), view);
  });
}

test('successful return-to-live does not affect later intentional history reading', () => {
  const completed = receiveThreadSnapshot(start(), root.id, payload([root, old, sent], root.id), 1)!;
  const reading = { ...completed, pane: holdLivePane(completed.pane!) };
  const view = beginThreadLoad(reading, channel.id, root.id, 2);
  const next = receiveThreadSnapshot(view, root.id, payload([sent, message('new', 4, root.id)], root.id), 2)!;
  assert.equal(next.pane!.historyThrough, 3);
  assert.equal(next.pane!.messages.some(m => m.id === 'new'), false);
});

for (const replacement of [false, true]) {
  test(`thread snapshot metadata beats pre-request ACK (replacement=${replacement})`, () => {
    const view = replacement ? beginThreadLoad(start(), channel.id, root.id, 2) : start();
    const fresh = reacted(sent);
    const next = receiveThreadSnapshot(view, root.id, payload([root, old, fresh], root.id), replacement ? 2 : 1)!;
    assert.deepEqual(next.pane!.messages.at(-1)!.reactions, fresh.reactions);
  });
}

test('thread in-flight live updates beat snapshot metadata, ACK duplicates cannot undo them', () => {
  const live = reacted(sent);
  let view = receiveThreadMessage(start(), live);
  view = receiveThreadConfirmation(view, sent);
  const next = receiveThreadSnapshot(view, root.id, payload([root, old, sent], root.id), 1)!;
  assert.deepEqual(next.pane!.messages.at(-1)!.reactions, live.reactions);
});

test('thread ACK received during a GET is still only a fallback', () => {
  const view = receiveThreadConfirmation(beginThreadLoad(held(), channel.id, root.id, 1, true), sent);
  const next = receiveThreadSnapshot(view, root.id, payload([root, old, reacted(sent)], root.id), 1)!;
  assert.deepEqual(next.pane!.messages.at(-1)!.reactions, reacted(sent).reactions);
});

test('thread late ACK cannot erase a reaction already displayed', () => {
  const view: ThreadView = { ...held(), pane: payload([root, old, reacted(sent)], root.id) };
  const next = receiveThreadConfirmation(view, sent);
  assert.deepEqual(next.pane!.messages.at(-1)!.reactions, reacted(sent).reactions);
});

test('thread ACK before first snapshot is bounded, deduplicated and refreshed by HTTP', () => {
  let view = selectThread(null, channel.id, root.id);
  for (let n = 3; n < LIVE_MESSAGE_WINDOW + 13; n++) {
    view = receiveThreadConfirmation(view, message(`ack-${n}`, n, root.id));
  }
  const ack = view.confirmations!.at(-1)!;
  view = receiveThreadConfirmation(view, ack);
  assert.equal(view.confirmations!.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.pendingMessages.length, LIVE_MESSAGE_WINDOW);
  view = beginThreadLoad(view, channel.id, root.id, 1, true);
  const next = receiveThreadSnapshot(view, root.id, payload([reacted(ack)], root.id), 1)!;
  assert.deepEqual(next.pane!.messages.at(-1)!.reactions, reacted(ack).reactions);
});

test('channel snapshot metadata beats ACK while genuinely live mutations still win', () => {
  const ack = message('sent', 3), fresh = reacted(ack);
  const journal = beginChannelJournal(channel.id, [ack]);
  const current = holdLivePane(payload([root]));
  const next = reconcileChannelSnapshot(current, payload([root, fresh]), journal, false, true)!;
  assert.equal(next.historyThrough, undefined);
  assert.deepEqual(next.messages.at(-1)!.reactions, fresh.reactions);
  recordChannelMessage(journal, ack, false); // A real, in-flight reaction removal.
  const removed = reconcileChannelSnapshot(current, payload([root, fresh]), journal, false, true)!;
  assert.deepEqual(removed.messages.at(-1)!.reactions, []);
});

test('channel keeps an ACK missing from HTTP without a WebSocket echo', () => {
  const ack = message('sent', 3), journal = beginChannelJournal(channel.id, [ack]);
  const next = reconcileChannelSnapshot(null, payload([root]), journal)!;
  assert.deepEqual(next.messages.map(m => m.id), [root.id, ack.id]);
});

test('channel ACK arriving during GET cannot undo newer snapshot metadata', () => {
  const ack = message('sent', 3), journal = beginChannelJournal(channel.id);
  recordChannelConfirmation(journal, ack);
  const next = reconcileChannelSnapshot(null, payload([reacted(ack)]), journal)!;
  assert.deepEqual(next.messages[0]!.reactions, reacted(ack).reactions);
});

test('channel actual in-flight insertion retains its live precedence over a stale snapshot', () => {
  const ack = message('sent', 3), journal = beginChannelJournal(channel.id, [ack]);
  recordChannelMessage(journal, reacted(ack));
  recordChannelConfirmation(journal, ack);
  const next = reconcileChannelSnapshot(null, payload([ack]), journal)!;
  assert.deepEqual(next.messages[0]!.reactions, reacted(ack).reactions);
});

for (const reactionOnly of [false, true]) {
  test(`channel reply ACK + live journal count once (reactionOnly=${reactionOnly})`, () => {
    const journal = beginChannelJournal(channel.id, [sent]);
    recordChannelMessage(journal, reacted(sent), !reactionOnly);
    const next = reconcileChannelSnapshot(null, payload([root]), journal)!;
    assert.equal(next.replyCounts[root.id], 1);
    const caughtUp = { ...payload([root]), snapshotSeq: sent.seq, replyCounts: { [root.id]: 1 } };
    assert.equal(reconcileChannelSnapshot(next, caughtUp, journal)!.replyCounts[root.id], 1);
  });
}

test('channel confirmations obey scope and the existing overflow failure policy', () => {
  const journal = beginChannelJournal(channel.id, [{ ...sent, channelId: 'b' }]);
  recordChannelConfirmation(null, sent);
  assert.equal(journal.confirmations.size, 0);
  for (let n = 1; n <= LIVE_MESSAGE_WINDOW + 1; n++) recordChannelConfirmation(journal, message(`ack-${n}`, n));
  assert.equal(journal.confirmations.size, LIVE_MESSAGE_WINDOW);
  assert.equal(journal.overflow, true);
  assert.throws(() => reconcileChannelSnapshot(null, payload([]), journal), /exceeded/);
});

test('pending channel confirmation merging is bounded, ordered and idempotent', () => {
  const input = Array.from({ length: LIVE_MESSAGE_WINDOW + 7 }, (_, n) => message(`ack-${n}`, n + 1)).reverse();
  const merged = mergeConfirmations([], input);
  assert.equal(merged.length, LIVE_MESSAGE_WINDOW);
  assert.equal(merged[0]!.seq, 8);
  assert.deepEqual(mergeConfirmations(merged, [merged.at(-1)!]), merged);
});
