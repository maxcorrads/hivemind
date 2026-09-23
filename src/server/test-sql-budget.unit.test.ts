import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Raw SQL budget for tests (issue #159). Tests should seed, inspect and inject
// faults through src/server/test-fixtures.ts so schema/storage refactors only
// touch that module. The remaining raw calls are mostly schema-level assertions
// (migrations, indexes, query plans), marked with `// schema-level assertion`.
//
// If this test fails, use a fixture helper instead of raw `.db.prepare` / `.db.exec` calls
// (add one to test-fixtures.ts if needed). When you remove raw SQL from tests,
// lower RAW_SQL_BUDGET to the new count printed by the failure message so the
// budget keeps ratcheting down. Never raise it.
const RAW_SQL_BUDGET = 26; // was 372 before #159

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RAW_SQL = /\.db\.(?:prepare|exec)\(/g;

function files(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(relative, match);
    return entry.isFile() && match(entry.name) ? [relative] : [];
  });
}

const isTest = (name: string) => /\.test\.tsx?$/.test(name);

test("raw SQL in tests stays within the ratcheting budget", () => {
  const counts = ["src", "web", "scripts"].flatMap(dir => files(dir, isTest))
    .filter(file => !file.endsWith("/test-fixtures.ts"))
    .map(file => [file, readFileSync(path.join(root, file), "utf8").match(RAW_SQL)?.length ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const detail = counts.map(([file, n]) => `  ${n} ${file}`).join("\n");
  assert.ok(total <= RAW_SQL_BUDGET,
    `Tests contain ${total} raw .db.prepare/.db.exec calls (budget ${RAW_SQL_BUDGET}). ` +
    `Use src/server/test-fixtures.ts helpers instead.\n${detail}`);
  if (total < RAW_SQL_BUDGET) {
    console.log(`Raw SQL in tests dropped to ${total}; lower RAW_SQL_BUDGET in ${path.basename(fileURLToPath(import.meta.url))}.`);
  }
});

test("production code never imports the test fixtures", () => {
  const offenders = ["src", "web"].flatMap(dir => files(dir, name => /\.tsx?$/.test(name) && !isTest(name) && name !== "test-fixtures.ts"))
    .filter(file => /test-fixtures(?:\.ts)?["']/.test(readFileSync(path.join(root, file), "utf8")));
  assert.deepEqual(offenders, []);
});
