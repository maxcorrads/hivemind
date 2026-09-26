import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { botCapabilities } from "./bot-capabilities.ts";
import { applyMigrations, schemaVersion } from "./index.ts";
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

test("upstream terminal schema 31 gains Bot access without changing existing rows or terminal labels", t => {
  const db = previousSchema(t);
  applyMigrations(db, { target: 31 });
  db.prepare("UPDATE agents SET terminal_session = ? WHERE role = 'worker'").run("hm-fixture-worker");
  const before = rowsOf(db);
  assert.deepEqual(applyMigrations(db).map(m => m.name), ["bot_capabilities"]);
  assert.equal(schemaVersion(db), 32);
  const { bot_access, ...after } = rowsOf(db);
  assert.deepEqual(after, before);
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
  assert.deepEqual(applyMigrations(db).map(m => m.name), ["bot_capabilities"]);
  assert.equal(schemaVersion(db), 32);
  const { agents, ...after } = rowsOf(db), { agents: oldAgents, ...oldRest } = before;
  assert.deepEqual(after, oldRest, "all other rows, including Bot grants and credentials, are unchanged");
  assert.deepEqual(agents, oldAgents!.map(row => ({ ...(row as object), terminal_session: null })));
  const migrated = rowsOf(db);
  assert.deepEqual(applyMigrations(db), []);
  assert.deepEqual(rowsOf(db), migrated);
});

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
