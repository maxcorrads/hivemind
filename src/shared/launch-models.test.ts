import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allLaunchModels,
  modelChoiceGroups,
  modelChoiceId,
  modelGroups,
  parseChoiceId,
  selectedChoiceId,
} from "./launch-models.ts";
import { sanitizeModel } from "./launch-prompt.ts";

test("launch model dropdown has Codex, Claude, and Cursor slugs", () => {
  const names = allLaunchModels();
  assert.ok(names.length > 80);
  assert.ok(names.includes("gpt-6-astra"));
  assert.ok(names.includes("gpt-5.3-codex"));
  assert.ok(names.includes("opus"));
  assert.ok(names.includes("claude-opus-5-thinking-high"));
  for (const slug of names) sanitizeModel(slug);
  const claudeFirst = modelGroups("claude-tw")[0]?.label;
  const codexFirst = modelGroups("codex2")[0]?.label;
  assert.equal(claudeFirst, "Claude");
  assert.equal(codexFirst, "Codex");
});

test("Codex and Claude choices fold effort into the model list", () => {
  const groups = modelChoiceGroups("codex");
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.label, "Codex");
  const codex = groups[0]?.choices ?? [];
  assert.ok(codex.some((c) => c.id === "codex:gpt-6-astra" && c.effort === ""));
  assert.ok(
    codex.some((c) => c.id === modelChoiceId("codex", "gpt-6-astra", "high") && c.label === "gpt-6-astra · high"),
  );
  const cursorGroups = modelChoiceGroups("agent");
  assert.equal(cursorGroups.length, 1);
  assert.equal(cursorGroups[0]?.label, "Cursor");
  const cursor = cursorGroups[0]?.choices ?? [];
  assert.ok(cursor.some((c) => c.id === "cursor:gpt-5.3-codex-high" && c.effort === ""));
  assert.equal(cursor.some((c) => c.id.includes("::")), false);
});

test("choice ids stay unique when every family is listed", () => {
  const ids = modelChoiceGroups("gemini").flatMap((g) => g.choices.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("codex:gpt-5.3-codex"));
  assert.ok(ids.includes("cursor:gpt-5.3-codex"));
});

test("Cursor offers all Grok 4.7 effort and speed variants without a cursor- prefix", () => {
  for (const software of ["agent", "cursor"]) {
    const choices = modelChoiceGroups(software).flatMap(group => group.choices);
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      for (const suffix of ["", "-fast"]) {
        const model = `grok-4.7-${effort}${suffix}`;
        const id = `cursor:${model}`;
        assert.deepEqual(choices.find(choice => choice.id === id), {
          id, label: model, model, effort: "",
        });
        assert.equal(selectedChoiceId(software, model, effort), id);
        assert.deepEqual(parseChoiceId(id), { model, effort: "" });
      }
    }
    assert.equal(choices.some(choice => choice.model.startsWith("cursor-grok-4.7")), false);
    assert.ok(choices.some(choice => choice.model === "cursor-grok-4.6-xhigh"));
  }
  for (const software of ["codex", "claude"]) {
    assert.equal(modelChoiceGroups(software).some(group =>
      group.choices.some(choice => choice.model.startsWith("grok-4.7-"))), false);
  }
});

test("selectedChoiceId follows the software family", () => {
  assert.equal(selectedChoiceId("codex", "gpt-6-astra", "high"), "codex:gpt-6-astra::high");
  assert.equal(selectedChoiceId("agent", "gpt-5.3-codex-high", ""), "cursor:gpt-5.3-codex-high");
  assert.equal(selectedChoiceId("codex", "composer-2.5", ""), "other:composer-2.5");
  assert.equal(selectedChoiceId("agent", "gpt-5.3-codex", "high"), "cursor:gpt-5.3-codex");
  assert.equal(selectedChoiceId("", "gpt-6-astra", "high"), "codex:gpt-6-astra::high");
  assert.equal(
    selectedChoiceId("opencode", "opencode/muse-spark-1.3-contributor-free", "xhigh"),
    "opencode:opencode/muse-spark-1.3-contributor-free::xhigh",
  );
  assert.deepEqual(parseChoiceId("codex:gpt-6-astra::high"), { model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(parseChoiceId("other:composer-2.5"), { model: "composer-2.5", effort: "" });
  assert.deepEqual(parseChoiceId("opencode:opencode/muse-spark-1.3-contributor-free::xhigh"), {
    model: "opencode/muse-spark-1.3-contributor-free",
    effort: "xhigh",
  });
  assert.ok(
    modelChoiceGroups("opencode")[0]?.choices.some(
      (c) => c.model === "opencode-go/muse-spark-1.3-contributor" && c.effort === "",
    ),
  );
});
