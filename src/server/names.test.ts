import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES, pickName } from "./names.ts";

type AgentRole = "brain" | "worker";

function occupiedPool(): Set<string> {
  return new Set(AGENT_NAMES.map((name) => name.toLowerCase()));
}

test("the production pool has 500 safe, case-insensitively unique non-Human names", () => {
  assert.equal(AGENT_NAMES.length, 500);
  assert.equal(occupiedPool().size, 500);
  assert.ok(Object.isFrozen(AGENT_NAMES));
  for (const name of AGENT_NAMES) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/);
    assert.notEqual(name.toLowerCase(), "human");
    assert.doesNotMatch(name, /^(?:Brain|Worker)\d+$/i);
  }
});

const scenarios: Array<[string, (index: number) => AgentRole]> = [
  ["all brains", () => "brain"],
  ["all workers", () => "worker"],
  ["alternating roles", (index) => index % 2 === 0 ? "brain" : "worker"],
];

for (const [label, roleAt] of scenarios) {
  test(`500 production allocations stay unique with ${label}`, () => {
    const taken = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const name = pickName(roleAt(index), taken);
      assert.ok(AGENT_NAMES.includes(name), `premature fallback: ${name}`);
      assert.ok(!taken.has(name.toLowerCase()), `duplicate: ${name}`);
      taken.add(name.toLowerCase());
    }
    assert.deepEqual(taken, occupiedPool());
    assert.equal(pickName("brain", taken), "Brain1");
    assert.equal(pickName("worker", taken), "Worker1");
  });
}

test("preferred role names are selected before the remaining shared pool", () => {
  const taken = occupiedPool();
  taken.delete("atlas");
  taken.delete("anvil");
  assert.equal(pickName("brain", taken), "Atlas");
  assert.equal(pickName("worker", taken), "Anvil");
});

test("either role can consume a remaining name from the other preferred pool", () => {
  const taken = occupiedPool();
  taken.delete("atlas");
  assert.equal(pickName("worker", taken), "Atlas");
  taken.add("atlas");
  taken.delete("anvil");
  assert.equal(pickName("brain", taken), "Anvil");
});

test("preoccupied names are excluded without prematurely exhausting the pool", () => {
  const taken = new Set(
    AGENT_NAMES.filter((_, index) => index % 3 === 0).map((name) => name.toLowerCase()),
  );
  taken.add("human");
  taken.add("brain1");
  taken.add("worker1");
  const remaining = 500 - (taken.size - 3);
  for (let index = 0; index < remaining; index += 1) {
    const name = pickName(index % 2 === 0 ? "brain" : "worker", taken);
    assert.ok(AGENT_NAMES.includes(name));
    assert.ok(!taken.has(name.toLowerCase()), `reused persisted name: ${name}`);
    taken.add(name.toLowerCase());
  }
  assert.equal(taken.size, 503);
  assert.equal(pickName("brain", taken), "Brain2");
  assert.equal(pickName("worker", taken), "Worker2");
});

test("numbered exhaustion picks the first free suffix regardless of insertion order", () => {
  const taken = occupiedPool();
  for (const name of ["brain3", "worker3", "human", "worker1", "brain1"]) taken.add(name);
  assert.equal(pickName("brain", taken), "Brain2");
  assert.equal(pickName("worker", taken), "Worker2");
  taken.add("brain2");
  taken.add("worker2");
  assert.equal(pickName("brain", taken), "Brain4");
  assert.equal(pickName("worker", taken), "Worker4");
});

test("selection preserves the caller-owned reservation set and production pool", () => {
  const taken = occupiedPool();
  const last = AGENT_NAMES[AGENT_NAMES.length - 1]!;
  taken.delete(last.toLowerCase());
  const before = new Set(taken);
  const poolBefore = [...AGENT_NAMES];
  assert.equal(pickName("brain", taken), last);
  assert.equal(pickName("worker", taken), last);
  assert.deepEqual(taken, before);
  assert.deepEqual(AGENT_NAMES, poolBefore);
});
