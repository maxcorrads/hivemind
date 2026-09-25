import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../src/shared/types.ts";
import { LIVE_MESSAGE_WINDOW, retainNewest } from "../src/shared/realtime.ts";
import type { ChannelPayload } from "./api.ts";
import { boundLivePane, holdLivePane } from "./pane-window.ts";
import { beginThreadLoad, cancelThreadLoad, failThreadLoad, receiveThreadMessage, receiveThreadSnapshot } from "./thread-state.ts";

function message(seq: number, threadId: string | null = "root"): Message {
  return { id: seq === 1 ? "root" : `m-${seq}`, seq, channelId: "channel", threadId: seq === 1 ? null : threadId,
    authorId: "writer", authorName: "Writer", authorRole: "brain", body: `Message ${seq}`,
    kind: "chat", control: null, mentions: [], createdAt: seq };
}
function pane(messages: Message[], threadId: string | null = "root"): ChannelPayload {
  return { channel: { id: "channel" } as ChannelPayload["channel"], threadId, messages,
    threads: [], replyCounts: {}, hasOlder: false, hasNewer: true, cursors: { after: 2 } };
}

test('an unread reply jump survives a full live arrival window without acknowledging later replies', () => {
  let view = beginThreadLoad(null, 'channel', 'root', 1, true);
  for (let seq = 3; seq <= LIVE_MESSAGE_WINDOW + 2; seq++) view = receiveThreadMessage(view, message(seq));
  const next = receiveThreadSnapshot(view, 'root', pane([message(1), message(2)]), 1, 2)!;
  assert.deepEqual(next.pane!.messages.map(m => m.seq), [1, 2]);
  assert.equal(next.pane!.historyThrough, 2); assert.equal(next.pane!.deferredLive, true);
});

function unreadThreadView() {
  const target = { channelId: 'channel', threadId: 'root', seq: 2 };
  const view = receiveThreadSnapshot(beginThreadLoad(null, 'channel', 'root', 1, true, [], target),
    'root', pane([message(1), message(2)]), 1, 2)!;
  return { ...view, pane: { ...view.pane!, unreadTarget: target } };
}

test('thread refresh preserves committed unread identity but explicit live navigation discards it', () => {
  const current = unreadThreadView(), target = current.pane.unreadTarget;
  const refreshed = receiveThreadSnapshot(beginThreadLoad(current, 'channel', 'root', 2), 'root', pane([message(3)]), 2)!;
  assert.equal(refreshed.pane!.unreadTarget, target);
  assert.deepEqual(refreshed.pane!.messages.map(m => m.seq), [1, 2]);
  assert.equal(refreshed.unreadJump, undefined);
  const live = receiveThreadSnapshot(beginThreadLoad(refreshed, 'channel', 'root', 3, true), 'root', pane([message(3)]), 3)!;
  assert.equal(live.pane!.unreadTarget, undefined);
  assert.deepEqual(live.pane!.messages.map(m => m.seq), [3]);
  assert.equal(receiveThreadSnapshot(beginThreadLoad(live, 'channel', 'root', 4), 'root', pane([message(4)]), 4)!.pane!.unreadTarget, undefined);
});

for (const outcome of ['pending', 'replaced', 'failed'] as const) {
  test('cancelling an owned unread jump clears its live-navigation intent: ' + outcome, () => {
    const current = unreadThreadView(), target = { channelId: 'channel', threadId: 'root', seq: 1 };
    let next = beginThreadLoad(current, 'channel', 'root', 2, true, [], target);
    if (outcome === 'replaced') next = beginThreadLoad(next, 'channel', 'root', 3, true, [], target);
    if (outcome === 'failed') next = failThreadLoad(next, 2)!;
    const cancelled = cancelThreadLoad(next, target)!;
    assert.equal(cancelled.returnToLive, undefined);
    assert.equal(cancelled.unreadJump, undefined);
    assert.equal(cancelled.pendingLoad, undefined);
    assert.equal(cancelled.pane, current.pane);
    const refreshed = receiveThreadSnapshot(beginThreadLoad(cancelled, 'channel', 'root', 4), 'root', pane([message(3)]), 4)!;
    assert.deepEqual(refreshed.pane!.messages.map(m => m.seq), [1, 2]);
  });
}

for (const replacement of ['jump', 'live', 'send', 'completed', 'selection'] as const) {
  test('late unread cleanup leaves newer thread navigation untouched: ' + replacement, () => {
    const current = unreadThreadView(), target = { channelId: 'channel', threadId: 'root', seq: 1 };
    const pending = beginThreadLoad(current, 'channel', 'root', 2, true, [], target);
    const next = replacement === 'completed'
      ? receiveThreadSnapshot(pending, 'root', pane([message(1)]), 2, 1)!
      : beginThreadLoad(pending, 'channel', replacement === 'selection' ? 'other' : 'root', 3, true,
        replacement === 'send' ? [message(3)] : [], replacement === 'jump' ? { ...target } : undefined);
    assert.equal(cancelThreadLoad(next, target), next);
    if (replacement === 'send') assert.deepEqual(next.confirmations, [message(3)]);
  });
}

test("live window is immutable, finite and preserves no-op references", () => {
  const items = [1, 2, 3];
  assert.equal(retainNewest(items).items, items);
  assert.deepEqual(retainNewest(items, 2), { items: [2, 3], truncated: true });
  assert.deepEqual(items, [1, 2, 3]);
  for (const cap of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => retainNewest(items, cap), RangeError);
});

test("trimmed channel metadata and backwards cursor match retained roots, preserving forward gaps", () => {
  const messages = Array.from({ length: 600 }, (_, i) => message(i + 1, null));
  const original = { ...pane(messages, null), replyCounts: { root: 9, "m-599": 4 },
    threads: [{ id: "root", channelId: "channel", status: "open" as const }, { id: "m-599", channelId: "channel", status: "done" as const }] };
  const bounded = boundLivePane(original);
  assert.equal(bounded.messages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(original.messages.length, 600);
  assert.equal(bounded.hasOlder, true);
  assert.equal(bounded.cursors?.before, 101);
  assert.equal(bounded.cursors?.after, 2);
  assert.equal(bounded.hasNewer, true);
  assert.deepEqual(bounded.replyCounts, { "m-599": 4 });
  assert.deepEqual(bounded.threads.map(t => t.id), ["m-599"]);
});

test("10,000 thread events during a blocked HTTP load have bounded pending/live windows and recoverable history", () => {
  let view = beginThreadLoad(null, "channel", "root", 1);
  for (let i = 2; i <= 10_001; i++) view = receiveThreadMessage(view, message(i));
  assert.equal(view.pendingMessages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.pendingLoad?.liveMessages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.historyTruncated, true);
  view = receiveThreadSnapshot(view, "root", pane([message(1), message(2)]), 1)!;
  assert.equal(view.pane?.messages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.pane?.messages[0]?.seq, 9502);
  assert.equal(view.pane?.cursors?.before, 9502);
  assert.equal(view.pane?.cursors?.after, 2);
  assert.equal(view.pane?.hasOlder, true);
  assert.equal(view.pendingMessages.length, 0);
  assert.equal(view.pendingLoad, undefined);
  assert.equal(receiveThreadMessage(view, { ...message(20_000), channelId: "other" }), view);
  for (let i = 10_002; i <= 11_000; i++) view = receiveThreadMessage(view, message(i));
  assert.equal(view.pane?.messages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.pane?.messages.at(-1)?.seq, 11_000);
});

test("explicit history keeps its reading anchor while live arrivals stay on the server", () => {
  let view = beginThreadLoad(null, "channel", "root", 1);
  view = receiveThreadSnapshot(view, "root", pane([message(1), message(2)]), 1)!;
  const original = view.pane!;
  assert.equal(boundLivePane(original), original);
  view = { ...view, pane: holdLivePane(pane(Array.from({ length: 600 }, (_, i) => message(i + 1)))) };
  const anchor = view.pane!.messages[39];
  for (let seq = 601; seq <= 10_600; seq++) view = receiveThreadMessage(view, message(seq));
  assert.equal(view.pane?.messages.length, 600);
  assert.equal(view.pane?.messages[39], anchor);
  assert.equal(view.pane?.deferredLive, true);
  assert.equal(view.pendingMessages.length, 0);
  view = beginThreadLoad(view, "channel", "root", 2);
  view = receiveThreadSnapshot(view, "root", pane([message(1), message(10_600)]), 2)!;
  assert.equal(view.pane?.messages.length, 600);
  assert.equal(view.pane?.messages[39], anchor);
  assert.equal(view.pane?.historyThrough, 600);
});

for (const threadId of [null, "root"]) {
  test(`reading 1..580 preserves seq 40 when 581 arrives (thread=${threadId})`, () => {
    const history = holdLivePane(pane(Array.from({ length: 580 }, (_, i) => message(i + 1, threadId)), threadId));
    const anchor = history.messages[39];
    const updated = boundLivePane({ ...history, messages: [...history.messages, message(581, threadId)] });
    assert.equal(updated.messages.length, 580);
    assert.equal(updated.messages[39], anchor);
    assert.equal(updated.deferredLive, true);
    assert.equal(updated.cursors?.after, history.cursors?.after);
  });
}
