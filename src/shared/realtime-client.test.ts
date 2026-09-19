import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  connectRealtime, createPresenceBuffer, createRealtimeStream,
  type RealtimeEvent, type SocketCallbacks,
} from "./realtime-client.ts";

function scheduler() {
  let next = 0;
  const tasks = new Map<number, () => void>();
  return {
    tasks,
    defer: (run: () => void) => {
      const id = ++next;
      tasks.set(id, run);
      return () => { tasks.delete(id); };
    },
    flush: () => {
      const scheduled = [...tasks.values()];
      tasks.clear();
      for (const run of scheduled) run();
    },
  };
}

function agent(id: string, online = true, projectId = "A", lastSeenAt = 0): RealtimeEvent {
  return { type: "agent", payload: { id, online, projectId, lastSeenAt } };
}

function bufferFixture(t: TestContext, capacity = 256) {
  const events: RealtimeEvent[] = [];
  const clock = scheduler();
  const buffer = createPresenceBuffer((event) => events.push(event), clock.defer, capacity);
  t.after(buffer.dispose);
  return { events, clock, buffer };
}

function clientFixture(t: TestContext) {
  const events: RealtimeEvent[] = [];
  const live: boolean[] = [];
  const frames = scheduler();
  const retries = scheduler();
  const sockets: Array<{ callbacks: SocketCallbacks; closed: number }> = [];
  const stop = connectRealtime((event) => events.push(event), (value) => live.push(value), {
    open: (callbacks) => {
      const socket = { callbacks, closed: 0 };
      sockets.push(socket);
      return () => { socket.closed += 1; };
    },
    deferPresence: frames.defer,
    retry: retries.defer,
  });
  t.after(stop);
  const send = (event: RealtimeEvent, index = sockets.length - 1) =>
    sockets[index]!.callbacks.message(JSON.stringify(event));
  return { events, live, frames, retries, sockets, stop, send };
}

test("stream hello observes the current sequence without consuming an event", () => {
  const stream = createRealtimeStream("server-A");
  assert.equal(stream.hello().sequence, 0);
  assert.equal(stream.event("agent", {}).sequence, 1);
  assert.equal(stream.hello().sequence, 1);
  assert.equal(stream.event("message", {}).sequence, 2);
  assert.equal(stream.hello().streamId, "server-A");
  assert.throws(() => createRealtimeStream(""));
});

test("10,000 same-agent touches retain one update and schedule one callback", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  for (let n = 0; n < 10_000; n += 1) buffer.push(agent("a", true, "A", n));
  assert.equal(buffer.size(), 1);
  assert.equal(clock.tasks.size, 1);
  assert.equal(events.length, 0);
  clock.flush();
  assert.deepEqual(events, [agent("a", true, "A", 9_999)]);
  assert.equal(buffer.size(), 0);
  assert.equal(clock.tasks.size, 0);
});

test("multiple agents retain the last arrival independently and in arrival order", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("a", true, "A", 1));
  buffer.push(agent("b", true, "A", 2));
  buffer.push(agent("a", true, "A", 3));
  clock.flush();
  assert.deepEqual(events, [agent("b", true, "A", 2), agent("a", true, "A", 3)]);
});

test("identical agent IDs in different projects cannot overwrite each other", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("same", true, "A"));
  buffer.push(agent("same", false, "B"));
  assert.equal(buffer.size(), 2);
  clock.flush();
  assert.deepEqual(events, [agent("same", true, "A"), agent("same", false, "B")]);
});

test("online/offline oscillation flushes transitions without waiting for the timer", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  for (const online of [true, false, true, false]) buffer.push(agent("a", online));
  assert.deepEqual(events.map((event) => (event.payload as { online: boolean }).online), [true, false, true, false]);
  assert.equal(clock.tasks.size, 0);
});

test("wall-clock timestamps are not used as a surrogate event revision", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("a", true, "A", 100));
  buffer.push(agent("a", true, "A", 50));
  clock.flush();
  assert.deepEqual(events, [agent("a", true, "A", 50)]);
});

test("durable message/reaction/queued events are never coalesced or delayed", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("a"));
  const durable = ["message", "message", "reaction", "queued"].map((type, id) => ({ type, payload: { id } }));
  for (const event of durable) buffer.push(event);
  assert.deepEqual(events, [agent("a"), ...durable]);
  assert.equal(clock.tasks.size, 0);
});

test("hello and project deletion cancel pre-snapshot presence, including late callbacks", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("deleted", true, "gone"));
  const late = [...clock.tasks.values()][0]!;
  const deleted = { type: "project", payload: { deleted: "gone" } };
  buffer.push(deleted);
  late();
  assert.deepEqual(events, [deleted]);
  buffer.push(agent("old"));
  buffer.push({ type: "hello", payload: null });
  clock.flush();
  assert.deepEqual(events, [deleted, { type: "hello", payload: null }]);
  assert.equal(buffer.size(), 0);
});

test("agent deletion is an ordering barrier rather than a presence upsert", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("a"));
  const deleted = { type: "agent_deleted", payload: { id: "a" } };
  buffer.push(deleted);
  clock.flush();
  assert.deepEqual(events, [agent("a"), deleted]);
});

test("capacity bounds pending storage without silently dropping distinct agents", (t) => {
  const { events, clock, buffer } = bufferFixture(t, 3);
  for (let n = 0; n < 10; n += 1) {
    buffer.push(agent(String(n)));
    assert.ok(buffer.size() <= 3);
    assert.ok(clock.tasks.size <= 1);
  }
  clock.flush();
  assert.deepEqual(events, Array.from({ length: 10 }, (_, n) => agent(String(n))));
});

test("invalid capacities are rejected before scheduling any work", () => {
  const clock = scheduler();
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createPresenceBuffer(() => {}, clock.defer, capacity), RangeError);
  }
  assert.equal(clock.tasks.size, 0);
});

test("dispose cancels work and suppresses callbacks even when already queued", (t) => {
  const { events, clock, buffer } = bufferFixture(t);
  buffer.push(agent("a"));
  const late = [...clock.tasks.values()][0]!;
  buffer.dispose();
  buffer.dispose();
  late();
  buffer.push(agent("b"));
  buffer.flush();
  assert.deepEqual(events, []);
  assert.equal(clock.tasks.size, 0);
});

test("malformed presence cannot share another agent's coalescing key", (t) => {
  const { events, buffer } = bufferFixture(t);
  const malformed = [null, {}, { id: "a" }, { id: "a", online: true, projectId: 3 }];
  for (const payload of malformed) buffer.push({ type: "agent", payload });
  assert.equal(events.length, malformed.length);
  assert.equal(buffer.size(), 0);
});

test("disposal during delivery prevents remaining callbacks", () => {
  const clock = scheduler();
  const events: RealtimeEvent[] = [];
  const buffer = createPresenceBuffer((event) => { events.push(event); buffer.dispose(); }, clock.defer);
  buffer.push(agent("a"));
  buffer.push(agent("b"));
  clock.flush();
  assert.deepEqual(events, [agent("a")]);
});

test("client rejects duplicate/out-of-order events within the same stream", (t) => {
  const f = clientFixture(t);
  const stream = createRealtimeStream("one");
  const hello = stream.hello();
  f.send(hello);
  const old = stream.event("agent", agent("a", true).payload);
  const newer = stream.event("agent", agent("a", false).payload);
  f.send(newer);
  f.send(old);
  f.send(newer);
  f.frames.flush();
  assert.deepEqual(f.events, [hello, newer]);
});

test("new stream hello resets ordering after reconnect and discards old pending presence", (t) => {
  const f = clientFixture(t);
  const first = createRealtimeStream("one");
  const second = createRealtimeStream("two");
  f.send(first.hello());
  f.send(first.event("agent", agent("old").payload));
  const lateFrame = [...f.frames.tasks.values()][0]!;
  f.sockets[0]!.callbacks.closed();
  assert.equal(f.frames.tasks.size, 0);
  f.retries.flush();
  f.send(second.hello());
  const fresh = second.event("agent", agent("fresh", false).payload);
  f.send(fresh);
  lateFrame();
  f.frames.flush();
  assert.deepEqual(f.events.map((event) => event.type), ["hello", "hello", "agent"]);
  assert.deepEqual(f.events.at(-1), fresh);
  assert.equal(f.sockets[0]!.closed, 1);
});

test("late old-socket open/message/close callbacks cannot mutate a new connection", (t) => {
  const f = clientFixture(t);
  const old = f.sockets[0]!.callbacks;
  old.opened();
  old.closed();
  old.closed();
  assert.equal(f.retries.tasks.size, 1);
  f.retries.flush();
  f.sockets[1]!.callbacks.opened();
  old.opened();
  f.send({ type: "message", payload: "stale" }, 0);
  old.closed();
  assert.deepEqual(f.live, [true, false, true]);
  assert.deepEqual(f.events, []);
  assert.equal(f.retries.tasks.size, 0);
});

test("foreign stream, incomplete envelopes and unversioned events cannot pollute a versioned stream", (t) => {
  const f = clientFixture(t);
  const stream = createRealtimeStream("one");
  f.send(stream.hello());
  const bad = [
    { type: "message", payload: null, streamId: "two", sequence: 1 },
    { type: "message", payload: null, streamId: "one" },
    { type: "message", payload: null, sequence: 1 },
    { type: "message", payload: null, streamId: "one", sequence: 1.5 },
    { type: "message", payload: null, streamId: "one", sequence: -1 },
    { type: "message", payload: null, streamId: "", sequence: 1 },
    { type: "message", payload: null },
  ];
  for (const event of bad) f.send(event);
  assert.deepEqual(f.events, [stream.hello()]);
});

test("a sequenced event before hello is rejected without preventing the valid hello", (t) => {
  const f = clientFixture(t);
  const stream = createRealtimeStream("one");
  f.send(stream.event("message", "before-hello"));
  f.send(stream.hello());
  assert.deepEqual(f.events, [stream.hello()]);
});

test("legacy servers remain supported, but duplicate hello cannot reset state", (t) => {
  const f = clientFixture(t);
  f.send({ type: "hello", payload: null });
  f.send({ type: "message", payload: "first" });
  f.send({ type: "hello", payload: null });
  f.send({ type: "message", payload: "second" });
  assert.deepEqual(f.events.map((event) => event.type), ["hello", "message", "message"]);
});

test("malformed JSON and binary/non-event frames are ignored", (t) => {
  const f = clientFixture(t);
  for (const data of ["{", "null", "[]", "3", "{}", '{"type":1}', new Uint8Array([1])]) {
    f.sockets[0]!.callbacks.message(data);
  }
  assert.deepEqual(f.events, []);
});

test("stop cancels reconnect and presence work, closes once and ignores late callbacks", (t) => {
  const f = clientFixture(t);
  f.send(agent("a"));
  const lateFrame = [...f.frames.tasks.values()][0]!;
  f.stop();
  f.stop();
  lateFrame();
  f.sockets[0]!.callbacks.opened();
  f.sockets[0]!.callbacks.closed();
  f.send({ type: "message", payload: null });
  f.frames.flush();
  f.retries.flush();
  assert.equal(f.sockets[0]!.closed, 1);
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.live, []);
});

test("stop also suppresses a cancelled reconnect callback that was already queued", (t) => {
  const f = clientFixture(t);
  f.sockets[0]!.callbacks.closed();
  const lateRetry = [...f.retries.tasks.values()][0]!;
  f.stop();
  lateRetry();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.retries.tasks.size, 0);
});

test("constructor failure schedules a cancellable retry rather than leaking a timer", () => {
  const frames = scheduler();
  const retries = scheduler();
  let attempts = 0;
  const live: boolean[] = [];
  const stop = connectRealtime(() => {}, (value) => live.push(value), {
    open: () => { attempts += 1; throw new Error("offline"); },
    deferPresence: frames.defer,
    retry: retries.defer,
  });
  assert.equal(attempts, 1);
  assert.deepEqual(live, [false]);
  retries.flush();
  assert.equal(attempts, 2);
  stop();
  assert.equal(retries.tasks.size, 0);
  assert.equal(frames.tasks.size, 0);
});

test("stopping inside an onLive(false) callback does not schedule reconnect", () => {
  const frames = scheduler();
  const retries = scheduler();
  let callbacks: SocketCallbacks;
  const stop = connectRealtime(() => {}, (value) => { if (!value) stop(); }, {
    open: (value) => { callbacks = value; return () => {}; },
    deferPresence: frames.defer,
    retry: retries.defer,
  });
  callbacks!.closed();
  assert.equal(retries.tasks.size, 0);
});
