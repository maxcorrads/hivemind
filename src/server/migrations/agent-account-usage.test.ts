import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { countRows, deleteRows, findRow, insertRow } from '../test-fixtures.ts';
import { applyMigrations, MIGRATIONS, schemaVersion } from './index.ts';

const tableRows = (db: DatabaseSync) => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));

const accountObjects = (db: DatabaseSync, type: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'agent_account%' ORDER BY name")
  .all(type) as { name: string }[]).map(row => row.name);

test('agent_account_usage keeps every row of a populated v41 hive and runs only step 42', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8'));
  const version = MIGRATIONS.find(m => m.name === 'agent_account_usage')!.version;
  applyMigrations(db, { target: version - 1 });
  const before = tableRows(db);
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ['agent_account_usage']);
  assert.equal(schemaVersion(db), version);
  const after = tableRows(db);
  for (const [name, rows] of Object.entries(before)) assert.deepEqual(after[name], rows, name);
  assert.deepEqual(after.agent_account_usage, []);
});

test('agent_account_usage creates one row per account, with no data by default, and goes with its account', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  applyMigrations(db);
  db.exec('PRAGMA foreign_keys = ON');
  assert.deepEqual(accountObjects(db, 'table'), ['agent_account_policies', 'agent_account_usage', 'agent_accounts']);
  assert.deepEqual(accountObjects(db, 'index'), ['agent_accounts_driver_label', 'agent_accounts_driver_position', 'agent_accounts_shadow']);

  insertRow(db, 'agent_accounts', { id: 'a1', driver: 'codex', label: 'Work', position: 0, created_at: 1, updated_at: 1 });
  insertRow(db, 'agent_account_usage', { account_id: 'a1', last_attempt_at: 5 });
  assert.deepEqual({ ...findRow(db, 'agent_account_usage', { account_id: 'a1' }) }, { account_id: 'a1', captured_at: null, source: null,
    plan: 'unknown', windows: '[]', last_attempt_at: 5, last_error: null, limit_reset_at: null, limit_error_at: null });
  assert.throws(() => insertRow(db, 'agent_account_usage', { account_id: 'a1', last_attempt_at: 6 }), /UNIQUE constraint failed/);
  assert.throws(() => insertRow(db, 'agent_account_usage', { account_id: 'missing', last_attempt_at: 6 }), /FOREIGN KEY constraint failed/);

  deleteRows(db, 'agent_accounts', { id: 'a1' });
  assert.equal(countRows(db, 'agent_account_usage'), 0, 'deleting the account deletes its usage');
});
