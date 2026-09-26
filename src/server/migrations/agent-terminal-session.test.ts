import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, LATEST_VERSION, MIGRATIONS, schemaVersion } from "./index.ts";
import { hasColumn } from "./schema.ts";

// agent_terminal_session on a populated previous-release hive: the fixture (every table has rows) is brought to the
// previous release's schema, then only the new step runs.
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/storage");
const VERSION = MIGRATIONS.find(m => m.name === "agent_terminal_session")!.version;

function rowsOf(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

test("agent_terminal_session adds an empty label to every agent and keeps every row", t => {
  const sql = readFileSync(path.join(fixtures, "main-populated-v2.sql"), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(sql);
  applyMigrations(db, { target: VERSION - 1 });
  assert.equal(hasColumn(db, "agents", "terminal_session"), false);
  const before = rowsOf(db);

  assert.deepEqual(applyMigrations(db, { target: VERSION }).map(m => m.name), ["agent_terminal_session"]);
  const { agents, ...rest } = rowsOf(db), { agents: agentsBefore, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, "every other row is kept");
  assert.ok(agents!.length > 0);
  assert.deepEqual(agents, agentsBefore!.map(row => ({ ...row, terminal_session: null })));
  applyMigrations(db);
  assert.equal(schemaVersion(db), LATEST_VERSION);
});
