import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, MIGRATIONS } from './index.ts';

test('task view indexes preserve populated records and match page and template lookups', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../fixtures/storage/main-populated-v2.sql', import.meta.url), 'utf8'));
  const version = MIGRATIONS.find(m => m.name === 'task_view_indexes')!.version;
  applyMigrations(db, { target: version - 1 });
  const before = db.prepare('SELECT * FROM task_records ORDER BY id').all();
  assert.deepEqual(applyMigrations(db, { target: version }).map(m => m.name), ['task_view_indexes']);
  assert.deepEqual(db.prepare('SELECT * FROM task_records ORDER BY id').all(), before);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM task_records
    ORDER BY COALESCE(CAST(json_extract(snapshot,'$.updatedAt') AS INTEGER),0) DESC,id DESC LIMIT 51`).all();
  assert.match(JSON.stringify(plan), /idx_task_updated_page/);
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
  const launch = db.prepare('EXPLAIN QUERY PLAN SELECT template_snapshot FROM launch_requests WHERE task_id=? AND agent_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1').all('task', 'worker');
  assert.match(JSON.stringify(launch), /idx_launch_task_worker/);
  assert.deepEqual(applyMigrations(db, { target: version }), []);
});
