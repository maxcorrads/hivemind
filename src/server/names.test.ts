import assert from "node:assert/strict";
import { test } from "node:test";
import { pickName } from "./names.ts";

test("agent names stay unique for the first 500 identities across mixed roles", () => {
  const taken = new Set<string>();

  for (let i = 0; i < 500; i += 1) {
    const role = i % 2 === 0 ? "brain" : "worker";
    const name = pickName(role, taken);
    const key = name.toLowerCase();

    assert.equal(taken.has(key), false, `duplicate name at agent ${i + 1}: ${name}`);
    assert.doesNotMatch(name, /^(?:Brain|Worker)\d+$/, "numbered fallback must not be used before 500 agents");
    taken.add(key);
  }

  assert.equal(taken.size, 500);
});

test("numbered fallbacks remain available after the 500-name pool is exhausted", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const name = pickName(i % 2 === 0 ? "brain" : "worker", taken);
    taken.add(name.toLowerCase());
  }

  assert.match(pickName("brain", taken), /^Brain\d+$/);
  assert.match(pickName("worker", taken), /^Worker\d+$/);
});
