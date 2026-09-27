import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { listRows } from "../test-fixtures.ts";
import { applyMigrations, LATEST_VERSION, MIGRATIONS, schemaVersion } from "./index.ts";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/storage");
const VERSION = MIGRATIONS.find(m => m.name === "launcher_queue")!.version;

test("launcher_queue adds empty durable tables to a populated prior hive and keeps every old row", t => {
  const sql = readFileSync(path.join(fixtures, "main-populated-v2.sql"), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(sql);
  applyMigrations(db, { target: VERSION - 1 });
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(row => row.name);
  const before = Object.fromEntries(names.map(name => [name, listRows(db, name)]));
  assert.deepEqual(applyMigrations(db, { target: VERSION }).map(m => m.name), ["launcher_queue"]);
  assert.deepEqual(listRows(db, "launch_requests"), []);
  assert.deepEqual(listRows(db, "launcher_commands"), []);
  assert.deepEqual(Object.fromEntries(names.map(name => [name, listRows(db, name)])), before);
  applyMigrations(db);
  assert.equal(schemaVersion(db), LATEST_VERSION);
});
