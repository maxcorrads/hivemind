import assert from "node:assert/strict";
import { test } from "node:test";
import { currentToken, identityOrigin } from "./identity.ts";

test("a shell only uses its own session key and never another terminal's join", t => {
  const old = process.env.HIVEMIND_TOKEN;
  t.after(() => { if (old === undefined) delete process.env.HIVEMIND_TOKEN; else process.env.HIVEMIND_TOKEN = old; });
  delete process.env.HIVEMIND_TOKEN;
  assert.equal(currentToken(), undefined);
  assert.equal(currentToken("explicit-terminal"), "explicit-terminal");
  process.env.HIVEMIND_TOKEN = "shell-session";
  assert.equal(currentToken(), "shell-session");
});

test("server origins reject credentials, paths and queries", () => {
  assert.equal(identityOrigin("http://127.0.0.1:7420/"), "http://127.0.0.1:7420");
  for (const bad of ["http://user:pass@127.0.0.1:7420", "http://127.0.0.1:7420/api", "http://127.0.0.1:7420?x=1", "ftp://127.0.0.1"])
    assert.throws(() => identityOrigin(bad));
});
