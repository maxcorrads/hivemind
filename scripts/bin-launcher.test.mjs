import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { childEnv } from "../src/test-support/child-process.ts";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Lays out a fake package around the real bin launcher: optional src/ and dist/node entries that report which ran. */
function layout(t, { source, compiled }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hivemind-bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "bin"));
  copyFileSync(path.join(repo, "bin/hivemind.mjs"), path.join(dir, "bin/hivemind.mjs"));
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "dir");
  if (source) {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src/cli.ts"), 'const ran: string = "source"; console.log(ran, process.argv.slice(2).join(" "));\n');
  }
  if (compiled) {
    mkdirSync(path.join(dir, "dist/node"), { recursive: true });
    writeFileSync(path.join(dir, "dist/node/cli.js"), 'export async function runCli(argv) { console.log("compiled", argv.join(" ")); }\n');
  }
  return (env = {}) => {
    const { HIVEMIND_FROM_DIST: _ignored, ...base } = process.env;
    const result = spawnSync(process.execPath, [path.join(dir, "bin/hivemind.mjs"), "doctor", "--x"], { encoding: "utf8", env: childEnv({ ...base, ...env }) });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
}

test("a source checkout runs src/ through tsx even when a compiled build exists", (t) => {
  const run = layout(t, { source: true, compiled: true });
  assert.equal(run(), "source doctor --x");
  assert.equal(run({ HIVEMIND_FROM_DIST: "1" }), "compiled doctor --x");
});

test("an installed package without src/ runs the compiled CLI in-process", (t) => {
  assert.equal(layout(t, { source: false, compiled: true })(), "compiled doctor --x");
});

test("a checkout without a build falls back to tsx even when HIVEMIND_FROM_DIST is set", (t) => {
  assert.equal(layout(t, { source: true, compiled: false })({ HIVEMIND_FROM_DIST: "1" }), "source doctor --x");
});
