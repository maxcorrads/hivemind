import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Thread } from "../src/shared/types.ts";
import type { ChannelPayload } from "./api.ts";
import { LIVE_MESSAGE_WINDOW } from "../src/shared/realtime.ts";
import { holdLivePane } from "./pane-window.ts";
import { beginChannelJournal, recordChannelMessage, recordChannelThread, applyChannelMessage, reconcileChannelSnapshot } from "./channel-state.ts";

const message = (seq: number, threadId: string | null = null): Message => ({
  id: `m${seq}`, seq, channelId: "c", threadId, authorId: "a", authorName: "Agent", authorRole: "brain",
  body: `Message ${seq}`, kind: "chat", control: null, mentions: [], createdAt: seq,
});
const pane = (messages = [message(1)], snapshotSeq = 1): ChannelPayload => ({
  channel: { id: "c" } as ChannelPayload["channel"], messages, threadId: null,
  threads: [], replyCounts: {}, snapshotSeq, hasOlder: false, hasNewer: false, cursors: { before: 1, after: snapshotSeq },
});
const thread = (id: string, status: Thread["status"] = "blocked"): Thread => ({ id, channelId: "c", status });

test("late channel snapshots preserve pending roots, reactions, status and exactly counted replies", () => {
  const snapshot = { ...pane([message(1)], 2), replyCounts: { m1: 1 }, threads: [thread("m1", "open")] };
  const journal = beginChannelJournal("c");
  const reaction = { ...message(1), body: "newer reaction payload" };
  recordChannelMessage(journal, message(3));
  recordChannelMessage(journal, message(4, "m1"));
  recordChannelMessage(journal, message(4, "m1"));
  recordChannelMessage(journal, reaction, false);
  recordChannelThread(journal, thread("m1"));
  // Late HTTP send acknowledgement must not overwrite a received reaction.
  recordChannelMessage(journal, message(1));
  const next = reconcileChannelSnapshot(null, snapshot, journal)!;
  assert.deepEqual(next.messages, [reaction, message(3)]);
  assert.equal(next.threads[0]?.status, "blocked");
  assert.equal(next.replyCounts.m1, 2);
  assert.equal(applyChannelMessage(next, message(4, "m1")), next);
  assert.equal(applyChannelMessage(next, message(2, "m1")), next);
  const after = applyChannelMessage(next, message(5, "m1"))!;
  assert.equal(after.replyCounts.m1, 3);
  assert.equal(applyChannelMessage(after, message(5, "m1")), after);
});

test("a server fence includes replies absent from the root page and prevents snapshot double counting", () => {
  const snapshot = { ...pane([message(1)], 99), replyCounts: { m1: 7 } };
  const journal = beginChannelJournal("c");
  recordChannelMessage(journal, message(90, "m1"));
  const next = reconcileChannelSnapshot(null, snapshot, journal)!;
  assert.equal(next.replyCounts.m1, 7);
  assert.equal(applyChannelMessage(next, message(95, "m1")), next);
  assert.equal(applyChannelMessage(next, message(100, "m1"))!.replyCounts.m1, 8);
});

test("message delivery is idempotent, reactions cannot resurrect old roots and unrelated panes stay unchanged", () => {
  const original = pane();
  assert.equal(applyChannelMessage(null, message(2)), null);
  assert.equal(applyChannelMessage(original, { ...message(2), channelId: "other" }), original);
  const threadPane = { ...original, threadId: "m1" };
  assert.equal(applyChannelMessage(threadPane, message(2)), threadPane);
  assert.equal(applyChannelMessage(original, message(2, "absent")), original);
  assert.equal(applyChannelMessage(original, message(2, "m1"), false), original);
  assert.equal(applyChannelMessage(original, message(2), false), original);
  const reaction = { ...message(1), body: "updated" };
  const updated = applyChannelMessage(original, reaction, false)!;
  assert.equal(updated.messages[0], reaction);
  assert.equal(applyChannelMessage(updated, message(1)), updated);
  assert.deepEqual(applyChannelMessage(updated, message(3))!.messages, [reaction, message(3)]);
});

test("held history preserves the seq 40 anchor and backwards cursor while deferring new live rows", () => {
  const original = holdLivePane(pane(Array.from({ length: 600 }, (_, i) => message(i + 1)), 600));
  const anchor = original.messages[39];
  const journal = beginChannelJournal("c");
  recordChannelMessage(journal, message(602));
  const next = reconcileChannelSnapshot(original, { ...pane([message(601)], 601), hasOlder: true }, journal)!;
  assert.equal(next.messages.length, 600);
  assert.equal(next.messages[39], anchor);
  assert.equal(next.historyThrough, 600);
  assert.equal(next.deferredLive, true);
  assert.deepEqual(next.cursors, original.cursors);
  const older = reconcileChannelSnapshot(next, { ...pane([message(0)], 602), cursors: { before: 0 }, hasOlder: false }, beginChannelJournal("c"), true)!;
  assert.equal(older.messages.length, 601);
  assert.equal(older.messages[40], anchor);
  assert.equal(older.cursors?.before, 0);
  assert.equal(older.hasOlder, false);
});

test("only events belonging to one active request are journaled, with bounded overflow rather than silent loss", () => {
  const journal = beginChannelJournal("c");
  recordChannelMessage(null, message(1)); recordChannelThread(null, thread("m1"));
  recordChannelMessage(journal, { ...message(1), channelId: "other" });
  recordChannelThread(journal, { ...thread("m1"), channelId: "other" });
  assert.equal(journal.messages.size, 0); assert.equal(journal.threads.size, 0);
  for (let i = 1; i <= 10_000; i++) {
    recordChannelMessage(journal, message(i)); recordChannelThread(journal, thread(`m${i}`));
  }
  assert.equal(journal.messages.size, LIVE_MESSAGE_WINDOW);
  assert.equal(journal.threads.size, LIVE_MESSAGE_WINDOW);
  assert.equal(journal.overflow, true);
  assert.throws(() => reconcileChannelSnapshot(pane(), pane(), journal), /live event window/);
  const next = beginChannelJournal("c");
  for (let i = 0; i < 10_000; i++) recordChannelMessage(next, message(1));
  assert.equal(next.messages.size, 1); assert.equal(next.overflow, false);
});

test("refresh prunes invisible root metadata, restores server truth and isolates mismatched snapshots", () => {
  const current = { ...pane([message(1)], 1), replyCounts: { m1: 9 } };
  const journal = beginChannelJournal("c");
  assert.equal(reconcileChannelSnapshot(current, { ...pane(), channel: { id: "other" } as ChannelPayload["channel"] }, journal), current);
  assert.equal(reconcileChannelSnapshot(current, { ...pane(), threadId: "m1" }, journal), current);
  const roots = Array.from({ length: 600 }, (_, i) => message(i + 1));
  recordChannelMessage(journal, message(601, "m600"));
  const next = reconcileChannelSnapshot(current, { ...pane(roots, 600),
    threads: [thread("m1"), thread("m600")], replyCounts: { m1: 9, m600: 2 } }, journal)!;
  assert.equal(next.messages.length, 500);
  assert.deepEqual(next.replyCounts, { m600: 3 });
  assert.deepEqual(next.replySeqs, { m600: 601 });
  assert.deepEqual(next.threads.map(t => t.id), ["m600"]);
  const legacy = { ...pane(), snapshotSeq: undefined, replyCounts: { m1: 3 } };
  recordChannelMessage(journal, message(3, "m1"));
  assert.equal(reconcileChannelSnapshot(current, legacy, journal)!.replyCounts.m1, 9);
});
