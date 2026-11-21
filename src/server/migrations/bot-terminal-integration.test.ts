import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { botCapabilities } from "./bot-capabilities.ts";
import { applyMigrations, LATEST_VERSION, MIGRATIONS, schemaVersion } from "./index.ts";
import { hasColumn } from "./schema.ts";

function previousSchema(t: TestContext): DatabaseSync {
  const sql = readFileSync(new URL("../fixtures/storage/main-populated-v2.sql", import.meta.url), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(sql);
  applyMigrations(db, { target: 30 });
  db.exec(`INSERT INTO agents (id, name, role, token_hash, online, last_seen_at, created_at, inbox_cursor, project_id)
    SELECT 'fixture-bot', 'Fixture Bot', 'bot', 'synthetic-bot-token-hash', 0, 1, 1, 0, id FROM projects LIMIT 1`);
  return db;
}

function rowsOf(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) =>
    [String(name), db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

// drop_jev removes these tables later in the chain, with their rows.
const DROPPED_LATER = new Set(["jev_calls", "adaptive_topology_executions", "adaptive_topology_events",
  "adaptive_evidence_runs", "adaptive_evidence_attempts"]);

function assertPreviousRowsPreserved(db: DatabaseSync, before: Record<string, unknown[]>): void {
  const after = rowsOf(db);
  for (const [table, rows] of Object.entries(before)) {
    if (DROPPED_LATER.has(table)) {
      assert.equal(after[table], undefined, `${table}: dropped`);
      continue;
    }
    assert.equal(after[table]?.length, rows.length, `${table}: no rows lost or added`);
    if (!rows.length) continue;
    const columns = Object.keys(rows[0] as object);
    assert.deepEqual(after[table]!.map(row => Object.fromEntries(columns.map(column =>
      [column, (row as Record<string, unknown>)[column]]))), rows, `${table}: existing values preserved`);
  }
}

test("upstream terminal schema 31 gains Bot access without changing existing rows or terminal labels", t => {
  const db = previousSchema(t);
  applyMigrations(db, { target: 31 });
  db.prepare("UPDATE agents SET terminal_session = ? WHERE role = 'worker'").run("hm-fixture-worker");
  const before = rowsOf(db);
  assert.deepEqual(applyMigrations(db).map(m => m.name), MIGRATIONS.filter(m => m.version > 31).map(m => m.name));
  assert.equal(schemaVersion(db), LATEST_VERSION);
  const { bot_access } = rowsOf(db);
  assertPreviousRowsPreserved(db, before);
  assert.deepEqual(bot_access, [{ bot_id: "fixture-bot", capabilities: '["publish"]', receive_channels: "[]",
    definition_id: null, revision: 1 }]);
  assert.deepEqual(applyMigrations(db), []);
});

test("local Bot preview schema 31 gains terminal labels without resetting grants, subscriptions or revisions", t => {
  const db = previousSchema(t);
  // Reproduce the already-deployed preview, independently of the new migration ordering.
  botCapabilities(db);
  db.exec("PRAGMA user_version = 31");
  assert.equal(hasColumn(db, "agents", "terminal_session"), false);
  const channel = String(db.prepare("SELECT id FROM channels ORDER BY id LIMIT 1").get()!.id);
  db.prepare("UPDATE bot_access SET capabilities = ?, receive_channels = ?, definition_id = ?, revision = ?")
    .run('["receive","tools"]', JSON.stringify([channel]), "fixture-service", 7);
  const before = rowsOf(db);
  assert.deepEqual(applyMigrations(db).map(m => m.name), MIGRATIONS.filter(m => m.version > 31).map(m => m.name));
  assert.equal(schemaVersion(db), LATEST_VERSION);
  assertPreviousRowsPreserved(db, before);
  assert.ok(db.prepare("SELECT terminal_session FROM agents").all().every(row => row.terminal_session === null));
  const migrated = rowsOf(db);
  assert.deepEqual(applyMigrations(db), []);
  assert.deepEqual(rowsOf(db), migrated);
});

test("deployed fork schema 32 converges without losing Bot grants or terminal labels", t => {
  const db = previousSchema(t);
  applyMigrations(db, { target: 31 });
  botCapabilities(db);
  db.exec("PRAGMA user_version = 32");
  db.prepare("UPDATE agents SET terminal_session = ? WHERE role = 'worker'").run("hm-fixture-worker");
  db.prepare("UPDATE bot_access SET capabilities = '[]', revision = 11").run();
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_templates'").get(), undefined);
  const before = rowsOf(db);
  applyMigrations(db);
  assert.equal(schemaVersion(db), LATEST_VERSION);
  assertPreviousRowsPreserved(db, before);
  assert.deepEqual(db.prepare("SELECT * FROM worker_templates").all(), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const migrated = rowsOf(db);
  assert.deepEqual(applyMigrations(db), []);
  assert.deepEqual(rowsOf(db), migrated);
});

for (const version of [32, 33, 34, 35, 36, 37, 38]) {
  test(`upstream schema ${version} gains Bot grants and preserves existing data`, t => {
    const db = previousSchema(t);
    applyMigrations(db, { target: version });
    const project = String(db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get()!.id);
    db.prepare("INSERT INTO worker_templates VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("fixture-template", project, "fixture", 4, '{"label":"Existing template"}', 1, 2);
    const before = rowsOf(db);
    applyMigrations(db);
    assert.equal(schemaVersion(db), LATEST_VERSION);
    assertPreviousRowsPreserved(db, before);
    assert.deepEqual(db.prepare("SELECT * FROM bot_access WHERE bot_id = 'fixture-bot'").get(),
      Object.assign(Object.create(null), { bot_id: "fixture-bot", capabilities: '["publish"]', receive_channels: '[]', definition_id: null, revision: 1 }));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(applyMigrations(db), []);
  });
}

test("preview Bot access disabled by Human is not re-enabled during the merge migration", t => {
  const db = previousSchema(t);
  botCapabilities(db);
  db.exec("PRAGMA user_version = 31");
  db.prepare("UPDATE bot_access SET capabilities = '[]', revision = 9").run();
  const before = db.prepare("SELECT * FROM bot_access").all();
  applyMigrations(db);
  assert.deepEqual(db.prepare("SELECT * FROM bot_access").all(), before);
  assert.equal(hasColumn(db, "agents", "terminal_session"), true);
});
