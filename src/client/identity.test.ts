import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { currentToken, identitiesDir, identityPath, loadIdentityByName, loadIdentityFile, saveIdentity } from "./identity.ts";

test("identities are private, atomic, origin/project scoped and never another terminal's last join", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-identity-"));
  const old = { home: process.env.HIVEMIND_HOME, url: process.env.HIVEMIND_URL, token: process.env.HIVEMIND_TOKEN };
  t.after(() => {
    for (const [key,value] of Object.entries({ HIVEMIND_HOME: old.home, HIVEMIND_URL: old.url, HIVEMIND_TOKEN: old.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HIVEMIND_HOME = home; process.env.HIVEMIND_URL = "http://127.0.0.1:7420"; delete process.env.HIVEMIND_TOKEN;
  const first = { id: randomUUID(), name: "Atlas", role: "brain" as const, focus: null, seniority: null, token: "private-first", project: "alpha" };
  saveIdentity(first);
  assert.equal(fs.statSync(identityPath("Atlas", "alpha")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(identitiesDir()).mode & 0o777, 0o700);
  assert.equal(loadIdentityByName("atlas", "alpha")!.token, first.token);
  assert.equal(currentToken(), undefined);
  fs.writeFileSync(path.join(home, "last-join.json"), JSON.stringify(first));
  assert.equal(currentToken(), undefined, "legacy last join must not select another terminal");
  assert.equal(currentToken("explicit-terminal"), "explicit-terminal");
  saveIdentity({ ...first, project: "beta", token: "private-beta" });
  assert.throws(() => loadIdentityByName("Atlas"), /Ambiguous/);
  assert.equal(loadIdentityByName("Atlas", "beta")!.token, "private-beta");
  const alphaPath = identityPath("Atlas", "alpha");
  process.env.HIVEMIND_URL = "http://127.0.0.1:7422";
  assert.equal(loadIdentityByName("Atlas", "alpha"), null);
  assert.throws(() => loadIdentityFile(alphaPath), /another server/);
  saveIdentity({ ...first, token: "other-server" });
  assert.equal(loadIdentityByName("Atlas", "alpha")!.token, "other-server");
  process.env.HIVEMIND_URL = "http://127.0.0.1:7420";
  assert.throws(() => identityPath("../Atlas", "alpha"));
  assert.throws(() => identityPath("Atlas", "../alpha"));
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("injected pre-rename interruption"); });
  syncBuiltinESMExports();
  try { assert.throws(() => saveIdentity({ ...first, token: "must-not-win" }), /interruption/); }
  finally { rename.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(loadIdentityByName("Atlas", "alpha")!.token, first.token);
  assert.equal(fs.readdirSync(path.dirname(alphaPath)).length, 1, "failed write leaked a credential temporary file");
  fs.chmodSync(alphaPath, 0o644);
  assert.throws(() => loadIdentityByName("Atlas", "alpha"), /private/);
  fs.chmodSync(alphaPath, 0o600);
  fs.writeFileSync(alphaPath, '{"token":"bad-shape"}');
  assert.throws(() => loadIdentityByName("Atlas", "alpha"), /Invalid identity/);
});
