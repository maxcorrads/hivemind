import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_ANNOTATIONS } from "./tool-annotations.ts";
import { TOOL_DESCRIPTIONS, type ToolName } from "./tool-text.ts";

const names = Object.keys(TOOL_DESCRIPTIONS) as ToolName[];
const where = (hint: "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint") =>
  names.filter(name => TOOL_ANNOTATIONS[name][hint] === true).sort();

test("every tool states each hint that applies to it, and nothing else", () => {
  assert.deepEqual(Object.keys(TOOL_ANNOTATIONS).sort(), [...names].sort());
  for (const name of names) {
    const hints = TOOL_ANNOTATIONS[name];
    // The protocol's defaults are the pessimistic ones, so nothing is left to them. The hints about a change mean
    // nothing on a tool that changes nothing, and a tool is known by its name: no title.
    const stated = hints.readOnlyHint
      ? ["openWorldHint", "readOnlyHint"]
      : ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"];
    assert.deepEqual(Object.keys(hints).sort(), stated, name);
    for (const [hint, value] of Object.entries(hints)) assert.equal(typeof value, "boolean", `${name}.${hint}`);
  }
});

test("the tools a client asks about before running are named here, so adding one is a decision", () => {
  // Codex asks the person before a call that is destructive or reaches outside, unless its configuration says otherwise.
  assert.deepEqual(where("destructiveHint"), ["call_bot_tool", "clear_context", "join", "release_worker", "room_event", "task_event"]);
  assert.deepEqual(where("openWorldHint"), ["call_bot_tool"]);
});

test("a description and its annotations say the same", () => {
  for (const name of names) {
    const text = TOOL_DESCRIPTIONS[name], hints = TOOL_ANNOTATIONS[name];
    if (/\bread-only\b/i.test(text) || /^(?:Read|List|Find)\b/.test(text))
      assert.equal(hints.readOnlyHint, true, `${name} is described as a read`);
    if (/\bsafe(?:ly)?\b/i.test(text))
      assert.ok(hints.readOnlyHint || hints.idempotentHint, `${name} is described as safe to repeat`);
  }
  // The phrasings above are the ones the descriptions use today.
  assert.deepEqual(names.filter(name => /\bread-only\b/i.test(TOOL_DESCRIPTIONS[name])).sort(),
    ["expand_digest", "preview_task_claim", "worker_match_suggest"]);
  assert.deepEqual(names.filter(name => /\bsafe(?:ly)?\b/i.test(TOOL_DESCRIPTIONS[name])).sort(),
    ["ack_delivery", "job_event", "react"]);
});
