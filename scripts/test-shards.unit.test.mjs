import test from "node:test";
import assert from "node:assert/strict";
import { parseShardSpec, planShards } from "./test-shards.mjs";

test("parseShardSpec validates the one-based shard contract", () => {
  assert.deepEqual(parseShardSpec("1/4"), { index: 1, count: 4 });
  assert.deepEqual(parseShardSpec("4/4"), { index: 4, count: 4 });
  for (const value of ["0/4", "5/4", "1/0", "x/4", "1/33"]) {
    assert.throws(() => parseShardSpec(value), /Shard/);
  }
});

test("planShards uses historical weight before file count and stays deterministic", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
  const weights = {
    "a.test.ts": 10_000,
    "b.test.ts": 9_000,
    "c.test.ts": 1_000,
    "d.test.ts": 1_000,
  };
  assert.deepEqual(planShards(files, 2, weights, 100), [
    { index: 1, totalWeightMs: 11_000, files: ["a.test.ts", "d.test.ts"] },
    { index: 2, totalWeightMs: 10_000, files: ["b.test.ts", "c.test.ts"] },
  ]);
  assert.deepEqual(planShards([...files].reverse(), 2, weights, 100), planShards(files, 2, weights, 100));
});

test("unmeasured files receive a bounded fallback and cannot disappear", () => {
  const plan = planShards(["slow.test.ts", "new-a.test.ts", "new-b.test.ts"], 2, { "slow.test.ts": 1_000 }, 250);
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), ["new-a.test.ts", "new-b.test.ts", "slow.test.ts"]);
  assert.equal(plan.reduce((sum, shard) => sum + shard.totalWeightMs, 0), 1_500);
});
