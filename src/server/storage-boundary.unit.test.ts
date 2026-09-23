import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Issue #168: storage.ts owns every transaction. Any other BEGIN/COMMIT/ROLLBACK/
// SAVEPOINT/RELEASE statement bypasses savepoint nesting and after-commit effects.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = "src/server/storage.ts";
// These benchmarks load an arbitrary (possibly older) checkout's hive.ts to compare
// revisions, so they cannot rely on Storage existing there.
const CROSS_VERSION_BENCHMARKS = new Set(["scripts/benchmark-storage-matrix.mjs", "scripts/benchmark-storage-queries.mjs"]);
// A statement that starts a string passed to exec()/prepare(). Trigger bodies
// (`... AFTER INSERT ON t BEGIN`) never start that string, so they do not match.
const TRANSACTION_SQL = /\b(?:exec|prepare)\([^;]*?["'`]\s*(?:BEGIN|COMMIT|END TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE)\b/;

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(relative);
    return entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name) && !/\.test\.(?:tsx?|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

test("only storage.ts issues transaction statements", () => {
  const offenders = ["src", "scripts"].flatMap(sources)
    .filter(file => file !== OWNER && !CROSS_VERSION_BENCHMARKS.has(file))
    .flatMap(file => readFileSync(path.join(root, file), "utf8").split("\n")
      .map((line, index) => [file, index + 1, line.trim()] as const)
      .filter(([, , line]) => TRANSACTION_SQL.test(line)))
    .map(([file, line, text]) => `${file}:${line}: ${text}`);
  assert.deepEqual(offenders, [], "Use Storage.for(db).transaction (or hive.storage) instead");
});

test("the retired transaction helpers stay gone", () => {
  const offenders = ["src", "scripts"].flatMap(sources)
    .filter(file => /\bimmediateTransaction\b|\boutboxTransaction\b|["']\.\/transaction\.ts["']/.test(readFileSync(path.join(root, file), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the boundary pattern catches statements but not trigger bodies", () => {
  for (const line of ['db.exec("BEGIN IMMEDIATE")', "db.exec('COMMIT')", "exec(depth ? `SAVEPOINT x` : 'BEGIN')", 'db.prepare("ROLLBACK TO x")'])
    assert.match(line, TRANSACTION_SQL);
  for (const line of ['db.exec(`CREATE TRIGGER t AFTER INSERT ON a BEGIN`)', "      BEGIN", 'key = match[1] === "BEGIN";'])
    assert.doesNotMatch(line, TRANSACTION_SQL);
});
