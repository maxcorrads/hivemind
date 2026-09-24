import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hive } from "../hive.ts";
import { applyMigrations, LATEST_VERSION, schemaVersion } from "./index.ts";
import { hasColumn } from "./schema.ts";
import { countRows, findRow, readValue } from "../test-fixtures.ts";

// #215 against a realistic existing hive: the populated fixture (every table has rows) is brought to the previous
// release's schema by the previous migrations, copied online (VACUUM INTO while the source stays open, as a backup of
// a live hive would be), and only the copy is migrated.
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/storage");
const PREVIOUS_VERSION = 28;

function rowsOf(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

test("agent_tombstones migrates an online backup of a populated previous-release hive, and removal then keeps history", t => {
  const sql = readFileSync(path.join(fixtures, "main-populated-v2.sql"), "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agent-tombstones-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = new DatabaseSync(path.join(dir, "live.db")), backup = path.join(dir, "backup.db");
  t.after(() => live.close());
  live.exec(sql);
  live.exec("PRAGMA foreign_keys = ON");
  applyMigrations(live, { target: PREVIOUS_VERSION });
  assert.equal(schemaVersion(live), PREVIOUS_VERSION);
  const before = rowsOf(live);

  live.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  const copy = new DatabaseSync(backup);
  try {
    assert.deepEqual(applyMigrations(copy).map(m => m.name), ["agent_tombstones"]);
    const after = rowsOf(copy);
    const { agents: agentsAfter, ...restAfter } = after, { agents: agentsBefore, ...restBefore } = before;
    assert.deepEqual(restAfter, restBefore, "every other row is kept");
    assert.equal(agentsAfter!.length, agentsBefore!.length);
    for (const [i, row] of agentsAfter!.entries()) {
      const old = agentsBefore![i]!;
      assert.equal(row.removed_at, null);
      assert.deepEqual({ ...row, token_hash: null, removed_at: undefined }, { ...old, token_hash: null, removed_at: undefined });
      if (row.id === "human") assert.notEqual(row.token_hash, old.token_hash, "the constant Human token hash is replaced");
      else assert.equal(row.token_hash, old.token_hash, "agent sessions keep working");
    }
  } finally { copy.close(); }
  assert.equal(schemaVersion(live), PREVIOUS_VERSION, "the live source is untouched");
  assert.equal(hasColumn(live, "agents", "removed_at"), false);

  // The migrated copy starts as a hive; removing the fixture brain keeps everything it authored or requested.
  const hive = new Hive(backup);
  t.after(() => hive.db.close());
  assert.equal(schemaVersion(hive.db), LATEST_VERSION);
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.listAgents().find(agent => agent.role === "brain")!;
  const history = ["messages", "task_records", "decision_requests", "routing_outcomes", "reactions", "adaptive_topology_events", "jev_calls"];
  const count = () => Object.fromEntries(history.map(table => [table, countRows(hive, table)]));
  const kept = count();
  assert.ok(countRows(hive, "messages", { author_id: brain.id }) > 0);
  hive.identity.removeAgent(human, brain.name);
  assert.deepEqual(count(), { ...kept, messages: kept.messages! + 1, adaptive_topology_events: kept.adaptive_topology_events! + 1 },
    "nothing is deleted; the removal notice and the audit of the closed Jev request are added");
  const execution = String(readValue(hive, "adaptive_topology_executions", "snapshot", { brain_id: brain.id }));
  assert.equal(typeof (JSON.parse(execution) as { completedAt?: number }).completedAt, "number");
  const authored = Number(findRow(hive, "messages", { author_id: brain.id }, "seq")!.seq);
  assert.equal(hive.messageQueries.getMessageBySeq(authored).authorName, `${brain.name} (removed)`);
  assert.equal(hive.identity.getAgent(brain.id).name, brain.name);
});
