import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveEvidenceStore, exportAdaptiveEvidence, EVIDENCE_ATTEMPT_LIMIT, EVIDENCE_RUN_LIMIT } from './adaptive-evidence.ts';
import type { AdaptiveTopologyDecision } from '../shared/adaptive-topology.ts';

const input = { topology: 'single', workers: 0, usableWorkers: 2, policyVersion: 'topology-policy-v2.1' };
const scope = { executionId: 'e1', channelId: 'c1', projectId: 'p1', phase: 'continuous' as const };
const decision: AdaptiveTopologyDecision = { routeId: 'r1', contractVersion: 'adaptive-routing-v2', targetTopology: 'brain_multi_room',
  targetWorkers: 2, confidence: 0.95, reason: 'shared_coordination_pressure', providerStatus: 'ok', model: 'jev-fixture',
  latencyMs: 10, inputTokens: 40, outputTokens: 5, singleSufficient: false, needsOrchestration: true };
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE channels(id TEXT PRIMARY KEY); INSERT INTO channels VALUES('c1'),('c2');");
  const store = new AdaptiveEvidenceStore(db);
  return { db, store };
}

test('evidence separates attempts, unknown usage and billable claims', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  const first = store.begin(scope, input); store.finish(first, decision); store.finish(first, decision);
  const second = store.begin(scope, input); store.finish(second, { ...decision, providerStatus: 'unavailable', inputTokens: null, outputTokens: null });
  store.begin(scope, input);
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.attemptsStarted, 3); assert.equal(report.coverage.attemptsFinished, 2);
  assert.equal(report.coverage.pendingAttempts, 1); assert.equal(report.overhead.tokenObservations, 1);
  assert.equal(report.overhead.knownInputTokens, 40); assert.equal(report.overhead.totalInputTokens, null);
  assert.equal(report.overhead.unknownUsageAttempts, 2); assert.equal(report.overhead.monetaryCost, null);
  assert.equal(report.overhead.summedLatencyMs, null);
});

test('all known attempts have additive totals, without counting finish retries', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  for (let i = 0; i < 3; i++) {
    const id = store.begin({ ...scope, phase: i ? 'continuous' : 'initial' }, input); store.finish(id, decision); store.finish(id, decision);
  }
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.capture, 'complete'); assert.deepEqual(report.coverage.captureReasons, []);
  assert.equal(report.overhead.totalInputTokens, 120); assert.equal(report.overhead.totalOutputTokens, 15);
  assert.equal(report.overhead.summedLatencyMs, 30); assert.equal(report.coverage.usageComplete, true);
  assert.equal(report.attempts.length, 3);
});

test('bounded attempt detail keeps exact lifetime aggregate and explicit retention coverage', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  for (let i = 0; i < EVIDENCE_ATTEMPT_LIMIT + 3; i++) store.finish(store.begin({ ...scope, phase: i ? 'continuous' : 'initial' }, input), decision);
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.attempts.length, EVIDENCE_ATTEMPT_LIMIT);
  // Truncated detail is an incomplete capture, but lifetime counters are still exact totals.
  assert.equal(report.coverage.capture, 'incomplete'); assert.deepEqual(report.coverage.captureReasons, ['history_truncated']);
  assert.equal(report.coverage.aggregateCapture, 'complete');
  assert.equal(report.coverage.prunedAttempts, 3); assert.equal(report.coverage.historyComplete, false);
  assert.equal(report.overhead.totalInputTokens, (EVIDENCE_ATTEMPT_LIMIT + 3) * 40);
});

test('recent runs are bounded per channel and channel deletion removes evidence transactionally', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  for (let i = 0; i <= EVIDENCE_RUN_LIMIT; i++) store.finish(store.begin({ ...scope, executionId: `e${i}` }, input), decision);
  assert.throws(() => exportAdaptiveEvidence(db, 'e0'), /not found/);
  store.finish(store.begin({ ...scope, channelId: 'c2', executionId: 'other' }, input), decision);
  db.prepare('DELETE FROM channels WHERE id=?').run('c1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get()!.n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_attempts').get()!.n, 1);
  assert.equal(exportAdaptiveEvidence(db, 'other').coverage.attemptsStarted, 1);
});

test('recently updated runs survive retention even when they were inserted first', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  let now = 1_000; t.mock.method(Date, 'now', () => now++);
  for (let i = 0; i < EVIDENCE_RUN_LIMIT; i++)
    store.finish(store.begin({ ...scope, executionId: `e${i}`, phase: 'initial' }, input), decision);
  store.finish(store.begin({ ...scope, executionId: 'e0' }, input), decision);
  store.finish(store.begin({ ...scope, executionId: 'new', phase: 'initial' }, input), decision);
  assert.equal(exportAdaptiveEvidence(db, 'e0').coverage.attemptsStarted, 2);
  assert.throws(() => exportAdaptiveEvidence(db, 'e1'), /not found/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get()!.n, EVIDENCE_RUN_LIMIT);
});

test('active execution protection stays within the cap and ends when its lifecycle completes', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  let now = 1_000; t.mock.method(Date, 'now', () => now++);
  db.exec('CREATE TABLE adaptive_topology_executions(channel_id TEXT PRIMARY KEY, execution_id TEXT, snapshot TEXT)');
  db.prepare('INSERT INTO adaptive_topology_executions VALUES(?,?,?)').run('c1', 'active', JSON.stringify({ completedAt: null }));
  store.finish(store.begin({ ...scope, executionId: 'active', phase: 'initial' }, input), decision);
  for (let i = 0; i < EVIDENCE_RUN_LIMIT; i++)
    store.finish(store.begin({ ...scope, executionId: `rejected-${i}`, phase: 'initial' }, input), decision);
  assert.equal(exportAdaptiveEvidence(db, 'active').coverage.attemptsStarted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get()!.n, EVIDENCE_RUN_LIMIT);
  assert.throws(() => exportAdaptiveEvidence(db, 'rejected-0'), /not found/);
  db.prepare('UPDATE adaptive_topology_executions SET snapshot=?').run(JSON.stringify({ completedAt: now }));
  store.finish(store.begin({ ...scope, executionId: 'new', phase: 'initial' }, input), decision);
  assert.throws(() => exportAdaptiveEvidence(db, 'active'), /not found/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_attempts').get()!.n, EVIDENCE_RUN_LIMIT);
});

test('recreated continuous capture does not claim complete execution history', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  let now = 1_000; t.mock.method(Date, 'now', () => now++);
  store.finish(store.begin({ ...scope, phase: 'initial' }, input), decision);
  assert.equal(exportAdaptiveEvidence(db, scope.executionId).coverage.historyComplete, true);
  for (let i = 0; i < EVIDENCE_RUN_LIMIT; i++)
    store.finish(store.begin({ ...scope, executionId: `new-${i}`, phase: 'initial' }, input), decision);
  assert.throws(() => exportAdaptiveEvidence(db, scope.executionId), /not found/);
  const resumed = new AdaptiveEvidenceStore(db);
  resumed.finish(resumed.begin(scope, input), decision);
  const report = exportAdaptiveEvidence(db, scope.executionId);
  assert.equal(report.coverage.historyComplete, false);
  assert.equal(report.coverage.prunedAttempts, 0);
  // Counters since a mid-execution installation are never promoted to full-run totals.
  assert.equal(report.coverage.capture, 'incomplete');
  assert.deepEqual(report.coverage.captureReasons, ['recorder_installed_mid_execution']);
  assert.equal(report.coverage.usageComplete, false); assert.equal(report.overhead.totalInputTokens, null);
  assert.equal(report.overhead.knownInputTokens, 40);
  assert.equal(report.attempts[0]!.phase, 'continuous');
});

test('evidence projects only numeric routing facts, never private input or decision fields', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  const sensitiveInput = { ...input, request: 'private request', apiKey: 'private-key', workerName: 'private worker' };
  const sensitiveDecision = { ...decision, reason: 'private-reason', model: 'provider\ninvalid', apiKey: 'private-key' };
  store.finish(store.begin(scope, sensitiveInput), sensitiveDecision);
  const serialized = JSON.stringify(exportAdaptiveEvidence(db, 'e1'));
  assert.doesNotMatch(serialized, /private-|private request|private worker|"c1"|"e1"|"p1"|"r1"/);
  assert.match(serialized, /brain_multi_room/); assert.doesNotMatch(serialized, /provider\\ninvalid/);
});

test('reading legacy or absent evidence never invents zero-cost execution', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  assert.throws(() => exportAdaptiveEvidence(db, 'missing'), /historical usage is unknown/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n, 0);
});

test('invalid evidence inputs fail before persistence and scope reuse cannot mix channels', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  assert.throws(() => store.begin(scope, { ...input, topology: 'invented' }), /Invalid/);
  assert.throws(() => store.begin(scope, { ...input, workers: -1 }), /Invalid/);
  assert.throws(() => store.begin(scope, { ...input, policyVersion: 'arbitrary secret text' }), /Invalid/);
  store.finish(store.begin(scope, input), decision);
  assert.throws(() => store.begin({ ...scope, channelId: 'c2' }, input), /scope conflict/);
  assert.throws(() => store.begin(scope, { ...input, policyVersion: 'v3' }), /policy changed/);
  assert.equal(exportAdaptiveEvidence(db, 'e1').coverage.attemptsStarted, 1);
});

test('late outcome after deletion is harmless and does not recreate orphan evidence', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  const id = store.begin(scope, input); db.prepare('DELETE FROM channels WHERE id=?').run('c1');
  assert.doesNotThrow(() => store.finish(id, decision));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get()!.n, 0);
});

test('pending interruptions also obey the hard detail bound', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  for (let i = 0; i < EVIDENCE_ATTEMPT_LIMIT + 2; i++) store.begin(scope, input);
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.attempts.length, EVIDENCE_ATTEMPT_LIMIT);
  assert.equal(report.coverage.pendingAttempts, EVIDENCE_ATTEMPT_LIMIT + 2);
  assert.equal(report.coverage.prunedAttempts, 2);
  assert.equal(report.overhead.totalInputTokens, null);
});

test('policy event export is allowlisted and explicitly only the retained tail', t => {
  const { db, store } = fixture(); t.after(() => db.close());
  store.finish(store.begin(scope, input), decision);
  db.exec('CREATE TABLE adaptive_topology_events(execution_id TEXT,snapshot TEXT)');
  db.prepare('INSERT INTO adaptive_topology_events VALUES(?,?)').run('e1', JSON.stringify({
    kind: 'transition', fromTopology: 'single', targetTopology: 'brain_multi_room', appliedTopology: 'brain_multi_room',
    targetWorkers: 2, appliedWorkers: 2, applied: true, warning: 'secret-warning', body: 'secret-body', apiKey: 'secret-key',
  }));
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.policyEventCoverage, 'retained_tail_only'); assert.equal(report.policyEvents[0]!.changed, true);
  assert.doesNotMatch(JSON.stringify(report), /secret-warning|secret-body|secret-key/);
  assert.deepEqual(report.models, ['jev-fixture']);
});
