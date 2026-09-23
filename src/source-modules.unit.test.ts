import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

// Node's coverage report only lists modules some test loaded; --test-coverage-include
// filters that list but never adds unloaded files. Loading every source module here
// keeps a new or type-only file from silently disappearing from the report.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOT_LOADABLE_IN_NODE = new Map([
  ["web/main.tsx", "Vite browser bootstrap: imports CSS and mounts the app into #root (covered by Playwright)"],
]);

function sources(relative: string): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return sources(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

const home = mkdtempSync(path.join(os.tmpdir(), "hivemind-modules-"));
const savedHome = process.env.HIVEMIND_HOME;
process.env.HIVEMIND_HOME = home;
after(() => {
  if (savedHome === undefined) delete process.env.HIVEMIND_HOME;
  else process.env.HIVEMIND_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

test("every src/ and web/ module loads without side effects so coverage reports it", async () => {
  const files = [...sources("src"), ...sources("web")].sort();
  assert.ok(files.length > 50, "source discovery found the tree");
  for (const file of NOT_LOADABLE_IN_NODE.keys()) assert.ok(files.includes(file), `stale exclusion ${file}`);
  for (const file of files) {
    if (NOT_LOADABLE_IN_NODE.has(file)) continue;
    await assert.doesNotReject(import(pathToFileURL(path.join(root, file)).href), file);
  }
  assert.deepEqual(readdirSync(home), [], "importing a module must not create hive state");
});
