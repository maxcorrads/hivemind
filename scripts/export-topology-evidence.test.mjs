import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AdaptiveEvidenceStore } from '../src/server/adaptive-evidence.ts';
import { rerunMigration } from '../src/server/test-fixtures.ts';
import { main } from './export-topology-evidence.mjs';

test('offline export opens existing SQLite read-only and writes a new private file', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-evidence-export-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hive.db'), output = path.join(dir, 'evidence.json');
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE channels(id TEXT PRIMARY KEY); INSERT INTO channels VALUES('c');");
  rerunMigration(db, 'adaptive_observations');
  const store = new AdaptiveEvidenceStore(db);
  store.begin({ executionId: 'e', projectId: 'p', channelId: 'c', phase: 'initial' },
    { topology: null, workers: 0, usableWorkers: 2, policyVersion: 'topology-policy-v2.1' });
  db.close();
  const before = readFileSync(file);
  const report = main(['--db', file, '--execution', 'e', '--output', output]);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(report.coverage.pendingAttempts, 1);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).overhead.totalInputTokens, null);
  assert.throws(() => main(['--db', file, '--execution', 'e', '--output', output]), /already exists/);
});

test('invalid CLI arguments, missing evidence and existing destinations fail without mutation', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-evidence-invalid-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => main([]), /required/);
  assert.throws(() => main(['--db']), /Use/);
  assert.throws(() => main(['--unknown', 'x']), /Use/);
  assert.throws(() => main(['--db', 'a', '--db', 'b']), /Use/);
  assert.throws(() => main(['--db', path.join(dir, 'missing'), '--execution', 'e', '--output', path.join(dir, 'out')]), /does not exist/);
  const existing = path.join(dir, 'existing'); writeFileSync(existing, 'retain me');
  assert.throws(() => main(['--db', existing, '--execution', 'e', '--output', existing]), /already exists/);
  assert.equal(readFileSync(existing, 'utf8'), 'retain me');
});
