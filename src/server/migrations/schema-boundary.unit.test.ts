import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Issue #166: src/server/migrations/ is the single source of the hive schema.
// Stores only prepare statements; schema changes are appended migrations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OWNER = "src/server/migrations/";
const EXEMPT = new Map([
  // Test-only fault injection (temporary triggers) and legacy-layout helpers.
  ["src/server/test-fixtures.ts", "test fixtures"],
  // A separate per-client journal database (pending sends), not hive.db.
  ["src/client/send-journal.ts", "client journal database"],
]);
const SCHEMA_SQL = /\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNIQUE\s+|VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|user_version)\b/;

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(relative);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

test("schema statements appear only in src/server/migrations/", () => {
  const offenders = sources("src")
    .filter(file => !file.startsWith(OWNER) && !EXEMPT.has(file))
    .flatMap(file => readFileSync(path.join(root, file), "utf8").split("\n")
      .map((line, index) => [file, index + 1, line.trim()] as const)
      .filter(([, , line]) => SCHEMA_SQL.test(line)))
    .map(([file, line, text]) => `${file}:${line}: ${text}`);
  assert.deepEqual(offenders, [], "Add a migration in src/server/migrations/ instead of changing the schema in a store");
});

test("the boundary pattern catches DDL and version pragmas but not ordinary SQL", () => {
  for (const line of ["CREATE TABLE IF NOT EXISTS x (a)", "db.exec(`CREATE UNIQUE INDEX i ON t(a)`)", "ALTER TABLE t ADD COLUMN c",
    "CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON a BEGIN", "DROP TABLE IF EXISTS t", "PRAGMA user_version = 3"])
    assert.match(line, SCHEMA_SQL);
  for (const line of ["SELECT * FROM tables", "INSERT INTO task_records VALUES (?)", "UPDATE channels SET name = ?", "// creates a table"])
    assert.doesNotMatch(line, SCHEMA_SQL);
});
