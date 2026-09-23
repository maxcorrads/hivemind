import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AdaptiveEvidenceStore, exportAdaptiveEvidence } from '../src/server/adaptive-evidence.ts';
import { rerunMigration } from '../src/server/test-fixtures.ts';
import { main } from './export-topology-evidence.mjs';
import { prepareStudy, summarizeStudy } from './benchmark-topology.mjs';

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

test('real exports carry capture state the paired-study scorer accepts and consumes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE channels(id TEXT PRIMARY KEY); INSERT INTO channels VALUES('c');");
  rerunMigration(db, 'adaptive_observations');
  const store = new AdaptiveEvidenceStore(db), policyVersion = 'topology-policy-v2.1';
  const decision = { routeId: 'r', contractVersion: 'adaptive-routing-v2', targetTopology: 'single', targetWorkers: 0, confidence: 0.9,
    reason: 'fixture', providerStatus: 'ok', model: 'jev-fixture', latencyMs: 1, inputTokens: 3, outputTokens: 1, singleSufficient: true, needsOrchestration: false };
  const scope = executionId => ({ executionId, channelId: 'c', projectId: 'p' });
  for (const id of ['complete', 'gap']) store.finish(store.begin({ ...scope(id), phase: 'initial' }, { topology: null, workers: 0, usableWorkers: 1, policyVersion }), decision);
  const gap = { missedBegins: 1, missedFinishes: 0, unattributed: 0, firstAt: 1, lastAt: 2 };
  store.recordGap(scope('gap'), policyVersion, gap); store.recordGap(scope('gap-only'), policyVersion, gap);
  const versions = { hivemindRevision: 'a'.repeat(40), provider: 'fixture', model: 'fixture', host: 'node-test', configuration: 'fixture', policyVersion };
  const study = prepareStudy({ evidenceKind: 'synthetic', versions, repeats: 3, seed: 1, freeWorkers: 2, limits: { wallMs: 1000, workloadTokens: 1000 },
    workloads: [{ id: 'w', version: 'v1', inputDigest: 'b'.repeat(64), acceptanceDigest: 'c'.repeat(64) }] });
  const exports = ['complete', 'gap', 'gap-only'].map(id => exportAdaptiveEvidence(db, id));
  let next = 0;
  for (const trial of study.trials) trial.observed = { evidenceKind: 'synthetic', versions, freeWorkers: 2, jevEnabled: trial.condition === 'auto',
    initialTopology: trial.condition === 'auto' ? 'single' : trial.condition, routingOverrides: 0, outcome: 'passed', independentlyReviewed: true,
    instrumentationHealthy: true, wallMs: 10, workloadTokens: 10, workloadUsageSource: 'provider_reported', defects: 0,
    routerEvidence: trial.condition === 'auto' ? exports[next++] : null, routingReview: null, evidenceRef: 'redacted/review.json' };
  const summary = summarizeStudy(study);
  assert.deepEqual(summary.routerCapture, { complete: 1, incomplete: 2, unknown: 0, missing: 0 });
  for (const comparison of summary.comparison) assert.equal(comparison.deltaNetTokens.observations, 1);
});
