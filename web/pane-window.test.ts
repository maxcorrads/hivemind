import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../src/shared/types.ts";
import { LIVE_MESSAGE_WINDOW, retainNewest } from "../src/shared/realtime.ts";
import type { ChannelPayload } from "./api.ts";
import { boundLivePane } from "./pane-window.ts";
import { beginThreadLoad, receiveThreadMessage, receiveThreadSnapshot } from "./thread-state.ts";

function message(seq: number, threadId: string | null = "root"): Message {
  return { id: seq === 1 ? "root" : `m-${seq}`, seq, channelId: "channel", threadId: seq === 1 ? null : threadId,
    authorId: "writer", authorName: "Writer", authorRole: "brain", body: `Message ${seq}`,
    kind: "chat", control: null, mentions: [], createdAt: seq };
}
function pane(messages: Message[], threadId: string | null = "root"): ChannelPayload {
  return { channel: { id: "channel" } as ChannelPayload["channel"], threadId, messages,
    threads: [], replyCounts: {}, hasOlder: false, hasNewer: true, cursors: { after: 2 } };
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

test("explicit earlier history is not discarded on a no-op page and next live event bounds growth", () => {
  let view = beginThreadLoad(null, "channel", "root", 1);
  view = receiveThreadSnapshot(view, "root", pane([message(1), message(2)]), 1)!;
  const original = view.pane!;
  assert.equal(boundLivePane(original), original);
  view = { ...view, pane: pane(Array.from({ length: 600 }, (_, i) => message(i + 1))) };
  view = receiveThreadMessage(view, message(601));
  assert.equal(view.pane?.messages.length, LIVE_MESSAGE_WINDOW);
  assert.equal(view.pane?.hasOlder, true);
});
