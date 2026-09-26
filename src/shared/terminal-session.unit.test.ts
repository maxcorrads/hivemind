import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMINAL_SESSION_ENV, TERMINAL_SESSION_PATTERN, terminalSessionFields, terminalSessionName } from "./terminal-session.ts";

test("only Hivemind tmux session names are accepted", () => {
  assert.equal(TERMINAL_SESSION_ENV, "HIVEMIND_TMUX_SESSION");
  for (const good of ["hm-a", "hm-acme-atlas", "hm-acme-new-1", `hm-${"a".repeat(79)}`]) {
    assert.equal(terminalSessionName(good), good);
  }
  for (const bad of ["", "hm-", "hm--a", "hm-A", "hm-a b", "hm-a\n", " hm-a", "hm-a;", `hm-${"a".repeat(80)}`, "hm-é", "=hm-a"]) {
    assert.equal(terminalSessionName(bad), null, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, 1, {}, ["hm-a"]]) assert.equal(terminalSessionName(bad), null);
  assert.equal(TERMINAL_SESSION_PATTERN.source, "^hm-[a-z0-9][a-z0-9-]{0,78}$", "kept equal to SessionName.pattern in Swift");
});

test("the join field is sent only from inside a Hivemind session", () => {
  assert.deepEqual(terminalSessionFields({ HIVEMIND_TMUX_SESSION: "hm-acme-atlas", TMUX: "/tmp/x" }), { terminalSession: "hm-acme-atlas" });
  for (const env of [{}, { HIVEMIND_TMUX_SESSION: "" }, { HIVEMIND_TMUX_SESSION: "main" }, { HIVEMIND_TMUX_SESSION: "hm-a;x" },
    { TMUX_PANE: "hm-acme-atlas" }]) assert.deepEqual(terminalSessionFields(env), {}, JSON.stringify(env));
});
