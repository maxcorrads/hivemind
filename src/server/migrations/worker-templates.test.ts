import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, LATEST_VERSION, MIGRATIONS, schemaVersion } from "./index.ts";

// worker_templates on a populated previous-release hive: the fixture (every table has rows) is brought to the
// previous release's schema, then only the new step runs.
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/storage");
const VERSION = MIGRATIONS.find(m => m.name === "worker_templates")!.version;

function rowsOf(db: DatabaseSync): Record<string, unknown[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

test("worker_templates adds an empty table and keeps every row", t => {
  const sql = readFileSync(path.join(fixtures, "main-populated-v2.sql"), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(sql);
  applyMigrations(db, { target: VERSION - 1 });
  const before = rowsOf(db);
  assert.equal("worker_templates" in before, false);

  assert.deepEqual(applyMigrations(db, { target: VERSION }).map(m => m.name), ["worker_templates"]);
  const { worker_templates: templates, ...rest } = rowsOf(db);
  assert.deepEqual(templates, []);
  assert.deepEqual(rest, before, "every other row is kept");
  applyMigrations(db);
  assert.equal(schemaVersion(db), LATEST_VERSION);
});
