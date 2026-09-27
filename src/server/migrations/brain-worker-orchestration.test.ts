import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, MIGRATIONS } from "./index.ts";

const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/storage/main-populated-v2.sql");
const version = MIGRATIONS.find(m => m.name === "brain_worker_orchestration")!.version;

test("brain worker migration defaults populated brains to approval and keeps existing rows", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(readFileSync(fixture, "utf8"));
  applyMigrations(db, { target: version - 1 });
  const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
  assert.deepEqual(applyMigrations(db, { target: version }).map(step => step.name), ["brain_worker_orchestration"]);
  const after = db.prepare("SELECT * FROM agents ORDER BY id").all();
  assert.deepEqual(after.map(row => ({ ...row })), before.map(row => ({ ...row, launch_mode: "approval", archived_at: null, reserved_by_brain_id: null })));
  assert.deepEqual(applyMigrations(db, { target: version }), []);
});
