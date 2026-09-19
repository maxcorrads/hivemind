import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJoinArgs } from "./join-args.ts";

test("join accepts the worker seniority shortcuts", () => {
  assert.deepEqual(parseJoinArgs(["--as", "worker", "senior"]).role, "worker");
  assert.deepEqual(parseJoinArgs(["--as", "worker", "senior"]).seniority, "senior");
  assert.equal(parseJoinArgs(["--as", "junior"]).seniority, "junior");
  assert.equal(parseJoinArgs(["--as", "brain"]).role, "brain");
  assert.equal(parseJoinArgs(["--as", "worker", "--seniority", "mid"]).seniority, "mid");
  assert.throws(() => parseJoinArgs(["--as", "worker"]), /seniority/);
  assert.equal(parseJoinArgs(["--as", "brain", "--project", "chapter"]).project, "chapter");
});


test("brain flags reject invalid explicitly supplied seniority instead of discarding it", () => {
  assert.throws(() => parseJoinArgs(["--as", "brain", "--seniority", "administrator"]), /Invalid seniority/);
});
