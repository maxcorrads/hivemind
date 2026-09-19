import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ReadSnapshot } from "./read-state.ts";
import { createReadFence, createReceiptQueue, createReadRefresh, createRequestGate, readFields, type ReadScope } from "./read-client.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function scheduler() {
  const tasks = new Set<() => void>();
  return {
    tasks,
    defer: (run: () => void) => { tasks.add(run); return () => { tasks.delete(run); }; },
    flush: () => { const current = [...tasks]; tasks.clear(); for (const run of current) run(); },
  };
}
const stamp = (readRevision = 1, readSeq = 10, readInstance = "server") => ({ readInstance, readRevision, readSeq });

test("read fence rejects older receipts/snapshots and responses captured before a live reply", () => {
  const fence = createReadFence();
  const ticket = fence.ticket();
  assert.equal(fence.accept(stamp(), ticket), true);
  assert.equal(fence.accept(stamp(2), ticket), true);
  assert.equal(fence.accept(stamp(1), ticket), false);
  fence.observe(11);
  assert.equal(fence.accept(stamp(3, 10), ticket), false);
  assert.equal(fence.accept(stamp(3, 11), ticket), true);
  assert.equal(fence.matches(stamp(2, 11), ticket), false);
  assert.equal(fence.matches(stamp(4, 11), ticket), true);
});

test("reconnect/deletion reset permits a new instance but rejects even a newer old-generation response", () => {
  const fence = createReadFence();
  const first = fence.ticket();
  fence.accept(stamp(40, 100), first);
  fence.reset();
  const next = fence.ticket();
  assert.equal(fence.current(first), false);
  assert.equal(fence.current(next), true);
  assert.equal(fence.accept(stamp(90, 900), first), false);
  assert.equal(fence.accept(stamp(1, 5, "restarted"), next), true);
  assert.equal(fence.accept(stamp(90, 900, "server"), next), false);
  fence.observe(2);
  assert.equal(fence.matches(stamp(1, 4, "restarted"), next), false);
});

test("read-state projection cannot overwrite roster, selection or messages in a global snapshot", () => {
  const snapshot = { ...stamp(), unread: { a: 2 }, mentions: [], mentionsHasMore: false, mentionCounts: { project: 1 }, agents: ["old"] };
  const fields = readFields(snapshot as ReadSnapshot);
  assert.equal("agents" in fields, false);
  assert.equal(fields.unread.a, 2);
  assert.deepEqual(Object.keys(fields).sort(), ["readInstance", "readRevision", "readSeq", "unread", "mentions", "mentionsHasMore", "mentionCounts"].sort());
});

test("request ownership guards A-to-B-to-A navigation and ignores an aborted old response", () => {
  const gate = createRequestGate();
  const a = gate.begin();
  const b = gate.begin();
  const anotherA = gate.begin();
  assert.equal(a.valid(), false);
  assert.equal(b.valid(), false);
  assert.equal(anotherA.valid(), true);
  assert.equal(a.signal.aborted, true);
  gate.cancel();
  gate.cancel();
  assert.equal(anotherA.valid(), false);
});

test("10,000 render updates coalesce into one exact receipt with no invisible sequence gaps", async (t) => {
  const clock = scheduler();
  const sent: number[][] = [];
  const queue = createReceiptQueue(async (_scope, seqs) => { sent.push(seqs); }, clock.defer, (error) => assert.fail(String(error)));
  t.after(queue.dispose);
  for (let n = 0; n < 10_000; n++) queue.update({ channelId: "A", threadId: null }, [10, 30, 10]);
  assert.equal(clock.tasks.size, 1);
  clock.flush();
  await setImmediate();
  assert.deepEqual(sent, [[10, 30]]);
  queue.update({ channelId: "A", threadId: null }, [10, 30]);
  assert.equal(clock.tasks.size, 0);
});

test("receipts are serial and capped at 200 while preserving every rendered row", async (t) => {
  const clock = scheduler();
  const calls: Array<{ scope: ReadScope; seqs: number[]; signal: AbortSignal; done: ReturnType<typeof deferred> }> = [];
  const queue = createReceiptQueue((scope, seqs, signal) => {
    const done = deferred(); calls.push({ scope, seqs, signal, done }); return done.promise;
  }, clock.defer, (error) => assert.fail(String(error)));
  t.after(queue.dispose);
  queue.update({ channelId: "A", threadId: "root" }, Array.from({ length: 405 }, (_, n) => n + 1));
  clock.flush(); await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.seqs.length, 200);
  for (let n = 0; n < 200; n++) queue.update({ channelId: "A", threadId: "root" }, Array.from({ length: 406 }, (_, i) => i + 1));
  assert.equal(clock.tasks.size, 0);
  for (let i = 0; i < 3; i++) {
    calls[i]!.done.resolve(); await setImmediate(); clock.flush(); await setImmediate();
  }
  assert.deepEqual(calls.map((c) => c.seqs.length), [200, 200, 6]);
  assert.equal(new Set(calls.flatMap((c) => c.seqs)).size, 406);
  assert.equal(clock.tasks.size, 0);
});

test("changing channel/thread cancels pending/in-flight reads and fences late completions", async (t) => {
  const clock = scheduler();
  const calls: Array<{ scope: ReadScope; signal: AbortSignal; done: ReturnType<typeof deferred> }> = [];
  const errors: unknown[] = [];
  const queue = createReceiptQueue((scope, _seqs, signal) => {
    const done = deferred(); calls.push({ scope, signal, done }); return done.promise;
  }, clock.defer, (error) => errors.push(error));
  t.after(queue.dispose);
  queue.update({ channelId: "A", threadId: null }, [1]);
  const lateTimer = [...clock.tasks][0]!;
  queue.update({ channelId: "B", threadId: "thread" }, [20]);
  lateTimer();
  assert.equal(clock.tasks.size, 1);
  clock.flush(); await setImmediate();
  assert.deepEqual(calls[0]!.scope, { channelId: "B", threadId: "thread" });
  queue.update({ channelId: "A", threadId: null }, [1]);
  assert.equal(calls[0]!.signal.aborted, true);
  calls[0]!.done.reject(new Error("late"));
  clock.flush(); await setImmediate();
  assert.equal(calls.length, 2);
  assert.deepEqual(errors, []);
  calls[1]!.done.resolve(); await setImmediate();
  assert.equal(clock.tasks.size, 0);
});

test("read errors are surfaced once, no timer retry loop, and a new render can retry", async (t) => {
  const clock = scheduler();
  const errors: unknown[] = [];
  let attempts = 0;
  const queue = createReceiptQueue(async () => { attempts++; if (attempts === 1) throw new Error("response lost"); }, clock.defer, (error) => errors.push(error));
  t.after(queue.dispose);
  queue.update({ channelId: "A", threadId: null }, [1]); clock.flush(); await setImmediate();
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(clock.tasks.size, 0);
  queue.update({ channelId: "A", threadId: null }, [1]); clock.flush(); await setImmediate();
  assert.equal(attempts, 2);
  assert.equal(clock.tasks.size, 0);
});

test("reset/dispose cancel timers and already-queued promises before sending unseen content", async () => {
  const clock = scheduler();
  let sent = 0;
  const queue = createReceiptQueue(async () => { sent++; }, clock.defer, (error) => assert.fail(String(error)));
  queue.update({ channelId: "A", threadId: null }, [1]);
  clock.flush();
  queue.reset();
  await setImmediate();
  assert.equal(sent, 0);
  queue.update({ channelId: "A", threadId: "new" }, [5]);
  const late = [...clock.tasks][0]!;
  queue.dispose(); queue.dispose(); late();
  queue.update({ channelId: "B", threadId: null }, [10]);
  await setImmediate();
  assert.equal(sent, 0);
  assert.equal(clock.tasks.size, 0);
});

test("read refresh coalesces bursts and keeps only one active and one trailing request", async (t) => {
  const clock = scheduler();
  const calls: ReturnType<typeof deferred>[] = [];
  const refresh = createReadRefresh(async () => { const done = deferred(); calls.push(done); await done.promise; }, clock.defer, (error) => assert.fail(String(error)));
  t.after(refresh.dispose);
  for (let i = 0; i < 10_000; i++) refresh.request();
  assert.equal(clock.tasks.size, 1);
  clock.flush(); await setImmediate();
  for (let i = 0; i < 10_000; i++) refresh.request();
  assert.equal(calls.length, 1);
  assert.equal(clock.tasks.size, 0);
  calls[0]!.resolve(); await setImmediate();
  assert.equal(clock.tasks.size, 1);
  clock.flush(); await setImmediate();
  assert.equal(calls.length, 2);
  calls[1]!.resolve(); await setImmediate();
  assert.equal(clock.tasks.size, 0);
});

test("refresh failure/cleanup does not leak timers or update after disposal", async () => {
  const clock = scheduler();
  let attempts = 0;
  const errors: unknown[] = [];
  const refresh = createReadRefresh(async () => { attempts++; throw new Error("offline"); }, clock.defer, (error) => errors.push(error));
  refresh.request(); clock.flush(); await setImmediate();
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(clock.tasks.size, 0);
  refresh.request(); const late = [...clock.tasks][0]!;
  refresh.dispose(); late(); refresh.request(); await setImmediate();
  assert.equal(attempts, 1);
  assert.equal(clock.tasks.size, 0);
});
