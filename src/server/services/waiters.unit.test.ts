import assert from "node:assert/strict";
import { test } from "node:test";
import { Waiters, type Waiter } from "./waiters.ts";

function fixture() {
  const events: string[] = [], registry = new Waiters();
  const waiter = (agent: string, label: string): Waiter => {
    const finish = (kind: string) => { events.push(`${label}:${kind}`); registry.release(agent, value); };
    const value: Waiter = { wake: () => finish("wake"), supersede: () => finish("supersede"), interrupt: () => finish("interrupt") };
    return value;
  };
  return { events, registry, waiter };
}

test("shutdown interrupts every registered wait exactly once and forgets the drained entries", () => {
  const f = fixture();
  f.registry.install("a", f.waiter("a", "a")); f.registry.install("b", f.waiter("b", "b"));
  f.registry.interruptAll(); f.registry.interruptAll();
  assert.deepEqual(f.events, ["a:interrupt", "b:interrupt"]);
  assert.equal(f.registry.has("a"), false); assert.equal(f.registry.has("b"), false);
});

test("replacement and eviction remain distinct from shutdown and stale cleanup cannot release a new wait", () => {
  const f = fixture(), old = f.waiter("a", "old"), next = f.waiter("a", "next");
  f.registry.install("a", old); f.registry.install("a", next);
  f.registry.release("a", old); assert.equal(f.registry.get("a"), next);
  f.registry.evict("a"); f.registry.interruptAll();
  assert.deepEqual(f.events, ["old:supersede", "next:supersede"]);
});

test("a reused registry admits normal waits after the interrupted server has drained", () => {
  const f = fixture(); f.registry.install("a", f.waiter("a", "before")); f.registry.interruptAll();
  f.registry.install("a", f.waiter("a", "after")); f.registry.wake("a");
  assert.deepEqual(f.events, ["before:interrupt", "after:wake"]);
});
