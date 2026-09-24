import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachablePath } from "./attach-guard.ts";

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "attach-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), work = path.join(dir, "work"), hive = path.join(dir, "hive");
  for (const sub of [".ssh", ".aws", ".gnupg", ".config/gcloud", ".hivemind", "project"]) mkdirSync(path.join(home, sub), { recursive: true });
  mkdirSync(work); mkdirSync(hive);
  const file = (target: string, content = "x") => { writeFileSync(target, content); return target; };
  return { home, work, hive, file, roots: { home, hiveHome: hive } };
}

test("attach allows ordinary files and returns their real path", t => {
  const f = fixture(t);
  const report = f.file(path.join(f.work, "report.md"));
  assert.equal(attachablePath(report, f.roots), report);
  for (const name of ["id_rsa.pub", "environment.ts", "notes.env.md", "keys.txt", "identity.json"])
    assert.equal(attachablePath(f.file(path.join(f.work, name)), f.roots), path.join(f.work, name));
  const project = f.file(path.join(f.home, "project", "readme.txt"));
  assert.equal(attachablePath(project, f.roots), project);
  assert.throws(() => attachablePath(path.join(f.work, "missing.txt"), f.roots), /File not found/);
  assert.throws(() => attachablePath(f.work, f.roots), /Not a regular file/);
});

test("attach refuses credential stores, dotenv files and private keys", t => {
  const f = fixture(t);
  const blocked = [
    path.join(f.home, ".ssh", "config"), path.join(f.home, ".aws", "credentials"), path.join(f.home, ".gnupg", "pubring.kbx"),
    path.join(f.home, ".config", "gcloud", "credentials.db"), path.join(f.home, ".hivemind", "hive.db"), path.join(f.home, ".netrc"),
    path.join(f.hive, "hive.db"), path.join(f.work, ".env"), path.join(f.work, ".env.local"), path.join(f.work, "id_ed25519"),
    path.join(f.work, "server.pem"), path.join(f.work, "tls.key"), path.join(f.work, "cert.p12"),
  ];
  for (const target of blocked) {
    f.file(target);
    assert.throws(() => attachablePath(target, f.roots), /attach refused .*never uploaded/, target);
  }
  // Case variants of a protected directory are the same directory on case-insensitive file systems.
  assert.throws(() => attachablePath(path.join(f.home, ".ssh", "config").replace(".ssh", ".SSH"), f.roots), /attach refused|File not found/);
});

test("symlinks cannot bypass the denylist in either direction", t => {
  const f = fixture(t);
  const key = f.file(path.join(f.home, ".ssh", "deploy"), "PRIVATE");
  const fileLink = path.join(f.work, "notes.txt"); symlinkSync(key, fileLink);
  assert.throws(() => attachablePath(fileLink, f.roots), /inside ~\/\.ssh/);
  const dirLink = path.join(f.work, "innocent"); symlinkSync(path.join(f.home, ".aws"), dirLink);
  f.file(path.join(f.home, ".aws", "config"));
  assert.throws(() => attachablePath(path.join(dirLink, "config"), f.roots), /inside ~\/\.aws/);
  const dotenv = f.file(path.join(f.work, ".env"), "TOKEN=1");
  const renamed = path.join(f.work, "settings.txt"); symlinkSync(dotenv, renamed);
  assert.throws(() => attachablePath(renamed, f.roots), /looks like a secret/);
  // A key-looking name is refused even when it points at a harmless file.
  const harmless = f.file(path.join(f.work, "plain.txt"));
  const disguised = path.join(f.work, "id_rsa"); symlinkSync(harmless, disguised);
  assert.throws(() => attachablePath(disguised, f.roots), /looks like a secret/);
  // A harmless link to a harmless file resolves to the target.
  const link = path.join(f.work, "alias.txt"); symlinkSync(harmless, link);
  assert.equal(attachablePath(link, f.roots), harmless);
});
