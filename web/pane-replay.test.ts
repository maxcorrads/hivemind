import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../src/shared/types.ts";
import type { ChannelPayload } from "./api.ts";
import { createPaneReplay, replayPane } from "./pane-replay.ts";
const message = (seq: number, threadId: string | null = null): Message => ({
  id: `m${seq}`, seq, channelId: "a", threadId, authorId: "brain", authorName: "Brain", authorRole: "brain",
  body: `body${seq}`, kind: "chat", control: null, mentions: [], createdAt: seq,
});
const snapshot = (): ChannelPayload => ({ channel: { id: "a" } as ChannelPayload["channel"], threadId: null,
  messages: [message(1)], threads: [{ id: "m1", channelId: "a", status: "open" }], replyCounts: { m1: 2 }, snapshotSeq: 3 });

test("late snapshot replays live roots, reactions and thread status without counting a reply twice", () => {
  const journal = createPaneReplay(), ticket = journal.begin("a", null);
  journal.record({ type: "message", message: message(3, "m1") }); // Already in the HTTP reply count.
  journal.record({ type: "message", message: message(4, "m1") });
  journal.record({ type: "message", message: message(4, "m1") });
  journal.record({ type: "message", message: message(5) });
  journal.record({ type: "message", message: message(5) });
  journal.record({ type: "reaction", message: { ...message(1), reactions: [{ emoji: "✅", count: 1 }] } });
  journal.record({ type: "thread", thread: { id: "m1", channelId: "a", status: "done" } });
  const result = journal.finish(ticket, snapshot())!;
  assert.deepEqual(result.messages.map(m => m.seq), [1, 5]);
  assert.equal(result.messages[0]!.reactions?.[0]?.emoji, "✅");
  assert.equal(result.threads[0]!.status, "done");
  assert.equal(result.replyCounts.m1, 3);
});

test("thread replay is scoped and does not insert foreign roots, replies or reactions", () => {
  const journal = createPaneReplay(), ticket = journal.begin("a", "m1");
  journal.record({ type: "message", message: message(4, "m1") });
  journal.record({ type: "message", message: message(5, "m2") });
  journal.record({ type: "reaction", message: { ...message(1), channelId: "other" } });
  journal.record({ type: "thread", thread: { id: "m1", channelId: "a", status: "blocked" } });
  const result = journal.finish(ticket, { ...snapshot(), threadId: "m1" })!;
  assert.deepEqual(result.messages.map(m => m.seq), [1, 4]);
  assert.equal(result.threads[0]!.status, "blocked");
  assert.equal(result.messages[0]!.channelId, "a");
});

test("overflow discards stale snapshot rather than silently losing journal events; next request recovers", () => {
  const journal = createPaneReplay(2), ticket = journal.begin("a", null);
  for (let i = 2; i < 10_000; i++) journal.record({ type: "message", message: message(i) });
  assert.equal(ticket.events.length, 0);
  assert.equal(journal.finish(ticket, snapshot()), null);
  const fresh = journal.begin("a", null);
  assert.deepEqual(journal.finish(fresh, snapshot()), snapshot());
});

test("cancelled/navigation tickets cannot commit even after A-to-B-to-A; irrelevant traffic has no budget cost", () => {
  const journal = createPaneReplay(1), stale = journal.begin("a", null);
  journal.begin("b", null);
  const current = journal.begin("a", null);
  for (let i = 0; i < 10_000; i++) journal.record({ type: "message", message: { ...message(i), channelId: "b" } });
  assert.equal(journal.finish(stale, snapshot()), null);
  assert.deepEqual(journal.finish(current, snapshot()), snapshot());
  const cancelled = journal.begin("a", null); journal.cancel();
  assert.equal(journal.finish(cancelled, snapshot()), null);
  for (const cap of [0, NaN, -1, 0.5]) assert.throws(() => createPaneReplay(cap), RangeError);
});

test("replay retains pinned historical windows and exposes deferred live mail", () => {
  const result = replayPane({ ...snapshot(), historyThrough: 1 }, [
    { type: "message", message: message(5) },
    { type: "reaction", message: { ...message(1), reactions: [{ emoji: "✅", count: 2 }] } },
  ]);
  assert.deepEqual(result.messages.map(m => m.seq), [1]);
  assert.equal(result.deferredLive, true);
  assert.equal(result.messages[0]!.reactions?.[0]?.count, 2);
});
