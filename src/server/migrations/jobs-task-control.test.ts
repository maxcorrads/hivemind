import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, MIGRATIONS } from './index.ts';

test('jobs migration preserves populated tasks and existing launch defaults', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8'));
  const version = MIGRATIONS.find(m => m.name === 'jobs_task_control')!.version;
  applyMigrations(db, { target: version - 1 });
  const before = db.prepare('SELECT * FROM task_records ORDER BY id').all();
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ['jobs_task_control']);
  assert.deepEqual(db.prepare('SELECT * FROM task_records ORDER BY id').all().map(r => ({ ...r })),
    before.map(r => ({ ...r, job_id: null })));
  assert.deepEqual(db.prepare('SELECT * FROM jobs').all(), []);
  assert.deepEqual(applyMigrations(db, { target: version }), []);
});
