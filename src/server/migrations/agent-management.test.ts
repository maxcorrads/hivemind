import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { countRows, insertRow, listRows, rerunMigration, updateRows } from '../test-fixtures.ts';
import { applyMigrations, LATEST_VERSION, MIGRATIONS, schemaVersion } from './index.ts';

const VERSION = MIGRATIONS.find(migration => migration.name === 'agent_management')!.version;

test('agent_management upgrades populated v37 identities and cards without changing existing data', t => {
  const sql = readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8');
  t.mock.timers.enable({ apis: ['Date'], now: Number(/^-- generated at (\d+)/.exec(sql)![1]) + 60_000 });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(sql); // schema-level populated legacy fixture
  applyMigrations(db, { target: VERSION - 1 });
  const agents = listRows(db, 'agents');
  const capabilities = listRows(db, 'worker_capabilities');
  assert.ok(agents.length > 0 && capabilities.length > 0);

  assert.deepEqual(applyMigrations(db, { target: VERSION }).map(migration => migration.name), ['agent_management']);
  assert.deepEqual(listRows(db, 'agents'), agents.map(row => ({ ...row,
    identity_revision: 1, seniority_overridden: 0, focus_overridden: 0 })));
  assert.deepEqual(listRows(db, 'worker_capabilities'), capabilities.map(row => ({ ...row, last_editor_id: null })));
  assert.equal(countRows(db, 'agent_name_aliases'), 0);
  assert.equal(countRows(db, 'agent_lifecycle_events'), 0);

  const worker = agents.find(row => row.role === 'worker')!;
  insertRow(db, 'agent_name_aliases', { name: 'PreviousName', agent_id: worker.id, created_at: 123 });
  assert.throws(() => insertRow(db, 'agent_name_aliases',
    { name: 'previousname', agent_id: worker.id, created_at: 124 }), /UNIQUE/);
  insertRow(db, 'agent_lifecycle_events', { agent_id: worker.id, project_id: worker.project_id,
    actor_id: 'human', kind: 'identity_edited', summary: 'Human renamed this agent.', at: 124, source: 'server' });
  assert.throws(() => updateRows(db, 'agents', { seniority_overridden: 2 }, { id: worker.id }), /CHECK/);
  const savedAlias = listRows(db, 'agent_name_aliases');
  const savedEvent = listRows(db, 'agent_lifecycle_events');
  rerunMigration(db, 'agent_management');
  assert.deepEqual(listRows(db, 'agent_name_aliases'), savedAlias);
  assert.deepEqual(listRows(db, 'agent_lifecycle_events'), savedEvent);
  assert.deepEqual(applyMigrations(db), []);
  assert.equal(schemaVersion(db), LATEST_VERSION);
});
