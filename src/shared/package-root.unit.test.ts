import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cliLaunchArgs, COMPILED_CLI, packageRoot, runningCompiled } from "./package-root.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("packageRoot finds the package from source and from nested build output", (t) => {
  assert.equal(packageRoot(), repo);
  assert.ok(existsSync(path.join(packageRoot(), "package.json")));
  const dir = mkdtempSync(path.join(os.tmpdir(), "hivemind-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chunks = path.join(dir, "dist/node/chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  assert.equal(packageRoot(chunks), dir);
});

test("cliLaunchArgs relaunches compiled JS without tsx, or source through tsx", () => {
  assert.equal(runningCompiled, false, "tests run the TypeScript source");
  assert.deepEqual(cliLaunchArgs(["mcp"], true, "/pkg"), [path.join("/pkg", COMPILED_CLI), "mcp"]);
  const source = cliLaunchArgs(["mcp"], false, "/pkg");
  assert.equal(source[0], "--import");
  assert.match(source[1]!, /tsx/);
  assert.deepEqual(source.slice(2), [path.join("/pkg", "src/cli.ts"), "mcp"]);
});
