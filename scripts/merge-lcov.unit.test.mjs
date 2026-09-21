import test from "node:test";
import assert from "node:assert/strict";
import { coverageSummary, mergeRecords, normalizeSource, parseLcov, serializeLcov } from "./merge-lcov.mjs";

const shardA = `TN:
SF:/Users/runner/work/hivemind/hivemind/src/example.ts
FN:1,foo
FNDA:1,foo
FNF:1
FNH:1
BRDA:2,0,0,1
BRDA:2,0,1,-
BRF:2
BRH:1
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
`;

const shardB = `TN:
SF:/Users/runner/work/hivemind/hivemind/src/example.ts
FN:1,foo
FNDA:2,foo
FNF:1
FNH:1
BRDA:2,0,0,1
BRDA:2,0,1,1
BRF:2
BRH:2
DA:1,2
DA:2,1
LF:2
LH:2
end_of_record
`;

test("normalizeSource removes runner-specific workspace prefixes", () => {
  assert.equal(normalizeSource("/Users/runner/work/hivemind/hivemind/src/example.ts"), "src/example.ts");
});

test("LCOV shards merge by source/entity instead of double-counting found totals", () => {
  const merged = mergeRecords([...parseLcov(shardA), ...parseLcov(shardB)]);
  assert.equal(merged.length, 1);
  assert.deepEqual(coverageSummary(merged), {
    lines: { found: 2, hit: 2, percent: 100 },
    functions: { found: 1, hit: 1, percent: 100 },
    branches: { found: 2, hit: 2, percent: 100 },
  });
  const output = serializeLcov(merged);
  assert.match(output, /FNDA:3,foo/);
  assert.match(output, /DA:2,1/);
  assert.match(output, /BRDA:2,0,1,1/);
  assert.match(output, /LF:2\nLH:2/);
});
