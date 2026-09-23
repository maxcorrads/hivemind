import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { removeLegacyIdentityDirs } from "./legacy-identities.ts";

// Every test uses its own temporary hive home; the real ~/.hivemind is never touched.
function tempHome(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-legacy-identities-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("startup removes legacy identity folders once and keeps other hive state", t => {
  const home = tempHome(t);
  mkdirSync(path.join(home, "identities"), { recursive: true });
  writeFileSync(path.join(home, "identities", "Ada.json"), "{}");
  mkdirSync(path.join(home, "identities-v2", "origin", "chapter"), { recursive: true });
  writeFileSync(path.join(home, "identities-v2", "origin", "chapter", "ada.json"), "{}");
  writeFileSync(path.join(home, "adaptive-routing.json"), "{}");

  const hive = new Hive(path.join(home, "hive.db"));
  hive.db.close();
  assert.equal(existsSync(path.join(home, "identities")), false);
  assert.equal(existsSync(path.join(home, "identities-v2")), false);
  assert.equal(existsSync(path.join(home, "adaptive-routing.json")), true);
  assert.equal(existsSync(path.join(home, "hive.db")), true);

  const again = new Hive(path.join(home, "hive.db"));
  again.db.close();
  assert.deepEqual(removeLegacyIdentityDirs(home), []);
});

test("legacy cleanup never follows symlinks outside the hive home", t => {
  const home = tempHome(t);
  const outside = tempHome(t);
  writeFileSync(path.join(outside, "keep.json"), "keep");
  symlinkSync(outside, path.join(home, "identities"), "dir");
  mkdirSync(path.join(home, "identities-v2"));
  symlinkSync(outside, path.join(home, "identities-v2", "link"), "dir");

  assert.deepEqual(removeLegacyIdentityDirs(home), [path.join(home, "identities-v2")]);
  assert.equal(readFileSync(path.join(outside, "keep.json"), "utf8"), "keep");
  assert.equal(existsSync(path.join(home, "identities")), true, "a symlinked legacy name is left alone");
  assert.equal(existsSync(path.join(home, "identities-v2")), false);
});

test("startup drops the unused agent_credentials table and no longer creates it", t => {
  const home = tempHome(t);
  const dbPath = path.join(home, "hive.db");
  const first = new Hive(dbPath);
  const table = (db: DatabaseSync) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_credentials'").get();
  assert.equal(table(first.db), undefined);
  first.db.exec("CREATE TABLE agent_credentials (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, revoked INTEGER NOT NULL)");
  first.db.close();

  const reopened = new Hive(dbPath);
  t.after(() => reopened.db.close());
  assert.equal(table(reopened.db), undefined);
});
