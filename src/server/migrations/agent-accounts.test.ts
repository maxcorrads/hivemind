import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, MIGRATIONS, schemaVersion } from './index.ts';

const tableRows = (db: DatabaseSync) => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));

const accountObjects = (db: DatabaseSync, type: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'agent_account%' ORDER BY name")
  .all(type) as { name: string }[]).map(row => row.name);

test('agent_accounts keeps every row of a populated v40 hive and runs only step 41', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8'));
  const version = MIGRATIONS.find(m => m.name === 'agent_accounts')!.version;
  applyMigrations(db, { target: version - 1 });
  const before = tableRows(db);
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ['agent_accounts']);
  assert.equal(schemaVersion(db), version);
  const after = tableRows(db);
  for (const [name, rows] of Object.entries(before)) assert.deepEqual(after[name], rows, name);
  assert.deepEqual(after.agent_accounts, []);
  assert.deepEqual(after.agent_account_policies, []);
});

test('agent_accounts creates both tables and their indexes, with the checks the store relies on', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  applyMigrations(db);
  assert.deepEqual(accountObjects(db, 'table'), ['agent_account_policies', 'agent_accounts']);
  assert.deepEqual(accountObjects(db, 'index'), ['agent_accounts_driver_label', 'agent_accounts_driver_position', 'agent_accounts_shadow']);

  const insert = db.prepare('INSERT INTO agent_accounts(id, driver, label, position, shadow_path, created_at, updated_at) VALUES (?,?,?,?,?,1,1)');
  assert.throws(() => insert.run('a0', 'gemini', 'Work', 0, ''), /CHECK constraint failed/);
  insert.run('a1', 'codex', 'Work', 0, '/shadow/a');
  assert.throws(() => insert.run('a2', 'codex', 'Work', 1, ''), /UNIQUE constraint failed/);
  assert.throws(() => insert.run('a3', 'codex', 'Other', 1, '/shadow/a'), /UNIQUE constraint failed/);
  insert.run('a4', 'claude', 'Work', 0, '');
  insert.run('a5', 'claude', 'Other', 1, '');
  assert.throws(() => db.prepare("INSERT INTO agent_account_policies(driver, policy, updated_at) VALUES ('codex', 'strict', 1)").run(), /CHECK constraint failed/);
});
