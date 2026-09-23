import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { AdaptiveEvidenceStore, evidenceCapture, exportAdaptiveEvidence, EVIDENCE_RUN_LIMIT } from './adaptive-evidence.ts';
import { EVIDENCE_GAP_MARKER_LIMIT, EvidenceCollectorMonitor } from './adaptive-evidence-health.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { countRows, deleteRows, failWrites, rerunMigration } from './test-fixtures.ts';
import type { AdaptiveTopologyDecision } from '../shared/adaptive-topology.ts';
import type { EvidenceCollectorHealth } from '../shared/evidence-health.ts';

const input = { topology: 'single', workers: 0, usableWorkers: 2, policyVersion: 'topology-policy-v2.1' };
const scope = { executionId: 'e1', channelId: 'c1', projectId: 'p1', phase: 'initial' as const };
const decision: AdaptiveTopologyDecision = { routeId: 'r1', contractVersion: 'adaptive-routing-v2', targetTopology: 'single',
  targetWorkers: 0, confidence: 0.95, reason: 'fixture', providerStatus: 'ok', model: 'jev-fixture',
  latencyMs: 10, inputTokens: 40, outputTokens: 5, singleSufficient: true, needsOrchestration: false };
const gap = (at = 1_000) => ({ missedBegins: 1, missedFinishes: 0, unattributed: 0, firstAt: at, lastAt: at });
function storeFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE channels(id TEXT PRIMARY KEY); INSERT INTO channels VALUES('c1'),('c2');");
  rerunMigration(db, 'adaptive_observations');
  t.after(() => db.close());
  return { db, store: new AdaptiveEvidenceStore(db) };
}

test('export distinguishes complete, explicitly incomplete and unknown capture', t => {
  const { db, store } = storeFixture(t);
  store.finish(store.begin(scope, input), decision);
  store.finish(store.begin({ ...scope, phase: 'continuous' }, input), decision);
  let report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.capture, 'complete'); assert.equal(report.overhead.totalInputTokens, 80);

  // A persisted gap keeps retained usage but never promotes it to a full-run total.
  assert.equal(store.recordGap(scope, input.policyVersion, gap()), 'persisted');
  report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.capture, 'incomplete'); assert.deepEqual(report.coverage.captureReasons, ['collection_gap']);
  assert.deepEqual(report.coverage.collectionGap, { missedBegins: 1, missedFinishes: 0, unattributed: 0 });
  assert.equal(report.coverage.historyComplete, false); assert.equal(report.coverage.usageComplete, false);
  assert.equal(report.overhead.knownInputTokens, 80); assert.equal(report.overhead.totalInputTokens, null);
  assert.equal(report.overhead.summedLatencyMs, null);

  // An attempt without an outcome and no gap marker explaining it is unknown, not complete.
  store.begin({ ...scope, executionId: 'e2' }, input);
  assert.deepEqual(evidenceCapture(db, 'e2'), { capture: 'unknown', reasons: ['attempts_pending'] });
  assert.deepEqual(evidenceCapture(db, 'e2', true), { capture: 'incomplete', reasons: ['collection_gap'] });
  assert.equal(evidenceCapture(db, 'missing'), null);
});

test('records made before collector-health tracking are unknown, never complete', t => {
  const { db, store } = storeFixture(t);
  store.finish(store.begin(scope, input), decision);
  const row = db.prepare('SELECT snapshot FROM adaptive_evidence_runs WHERE execution_id=?').get('e1')!;
  const legacy = JSON.parse(String(row.snapshot)) as Record<string, unknown>; delete legacy.capture;
  db.prepare('UPDATE adaptive_evidence_runs SET snapshot=?').run(JSON.stringify(legacy));
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.capture, 'unknown'); assert.deepEqual(report.coverage.captureReasons, ['legacy_record']);
  assert.equal(report.coverage.historyComplete, false); assert.equal(report.overhead.totalInputTokens, null);
  store.recordGap(scope, input.policyVersion, gap());
  assert.deepEqual(evidenceCapture(db, 'e1'), { capture: 'incomplete', reasons: ['legacy_record', 'collection_gap'] });
});

test('gap-only evidence is created as incomplete, bounded, and discarded after channel deletion', t => {
  const { db, store } = storeFixture(t);
  assert.equal(store.recordGap(scope, input.policyVersion, gap()), 'persisted');
  const report = exportAdaptiveEvidence(db, 'e1');
  assert.equal(report.coverage.capture, 'incomplete'); assert.equal(report.coverage.attemptsStarted, 0);
  // The first recorded attempt after a lost initial one is not taken for the start of the execution.
  store.finish(store.begin({ ...scope, phase: 'continuous' }, input), decision);
  assert.equal(exportAdaptiveEvidence(db, 'e1').coverage.capture, 'incomplete');
  for (let i = 0; i < EVIDENCE_RUN_LIMIT + 5; i++) store.recordGap({ ...scope, executionId: `g${i}` }, input.policyVersion, gap(2_000 + i));
  assert.equal(countRows(db, 'adaptive_evidence_runs'), EVIDENCE_RUN_LIMIT);
  assert.equal(store.recordGap({ ...scope, channelId: 'gone' }, input.policyVersion, gap()), 'discarded');
  assert.equal(store.recordGap({ ...scope, channelId: 'c2', executionId: 'g60' }, input.policyVersion, gap()), 'persisted');
  assert.equal(store.recordGap({ ...scope, channelId: 'c1', executionId: 'g60' }, input.policyVersion, gap()), 'discarded');
});

test('the bounded in-memory marker set overflows into a conservative unattributed marker', () => {
  const calls: string[] = []; let failing = true;
  const health: EvidenceCollectorHealth[] = [];
  const monitor = new EvidenceCollectorMonitor(value => health.push(value));
  const store = {
    recordGap(target: { executionId: string }) { if (failing) throw new Error('secret-disk-error'); calls.push(target.executionId); return 'persisted'; },
    recordUnattributedGap() { calls.push('unattributed'); return 3; },
  } as unknown as AdaptiveEvidenceStore;
  for (let i = 0; i <= EVIDENCE_GAP_MARKER_LIMIT; i++) monitor.failed('begin', { executionId: `e${i}`, channelId: 'c', projectId: 'p' }, 'v');
  monitor.failed('finish', { executionId: 'e0', channelId: 'c', projectId: 'p' }, 'v');
  assert.equal(monitor.health().status, 'degraded'); assert.equal(monitor.health().overflow, true);
  assert.equal(monitor.health().pendingGaps, EVIDENCE_GAP_MARKER_LIMIT);
  assert.equal(monitor.pendingFor('never-seen'), true, 'An overflow cannot vouch for any execution');
  const published = health.length;
  monitor.flush(() => store);
  assert.equal(health.length, published, 'A retry that still fails is counted, not broadcast');
  assert.equal(monitor.health().failures.marker, 1);
  failing = false; monitor.flush(() => store);
  assert.equal(calls.length, EVIDENCE_GAP_MARKER_LIMIT + 1); assert.equal(calls.at(-1), 'unattributed');
  const recovered = monitor.health();
  assert.equal(recovered.status, 'recovered'); assert.equal(recovered.overflow, false); assert.equal(recovered.pendingGaps, 0);
  assert.deepEqual(recovered.failures, { begin: EVIDENCE_GAP_MARKER_LIMIT + 1, finish: 1, marker: 1 });
  assert.doesNotMatch(JSON.stringify(health), /secret-disk-error/);
});

test('an unattributed marker covers running executions and records touched since the first lost failure', t => {
  const { db, store } = storeFixture(t);
  let now = 1_000; t.mock.method(Date, 'now', () => now++);
  db.exec('CREATE TABLE adaptive_topology_executions(execution_id TEXT PRIMARY KEY, channel_id TEXT, snapshot TEXT)');
  for (const id of ['old-done', 'old-running', 'recent']) store.finish(store.begin({ ...scope, executionId: id }, input), decision);
  db.prepare("INSERT INTO adaptive_topology_executions VALUES(?,'c1',?),(?,'c1',?)")
    .run('old-done', JSON.stringify({ completedAt: 1 }), 'old-running', JSON.stringify({ completedAt: null }));
  const since = db.prepare("SELECT json_extract(snapshot,'$.lastRecordedAt') AS at FROM adaptive_evidence_runs WHERE execution_id='recent'").get()!.at as number;
  assert.equal(store.recordUnattributedGap(since), 2);
  assert.equal(evidenceCapture(db, 'old-done')!.capture, 'complete');
  assert.equal(evidenceCapture(db, 'old-running')!.capture, 'incomplete');
  assert.equal(exportAdaptiveEvidence(db, 'recent').coverage.collectionGap!.unattributed, 1);
});

function runtime(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-evidence-health-'));
  let hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' }).agent;
  const worker = hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' }).agent;
  const dm = hive.channels.openDm(human, brain.name);
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'never-export-this-key' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++; return Response.json(jevTopologyResponse(String(init?.body), 'single'));
  });
  const errors: string[] = []; t.mock.method(console, 'error', (message: string) => errors.push(message));
  const events: EvidenceCollectorHealth[] = [];
  const listen = () => hive.bus.on('evidence-health', health => events.push(health));
  listen();
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get hive() { return hive; }, human, brain, worker, dm, errors, events, calls: () => calls,
    start: () => hive.adaptiveTopology.routeHumanRequest(human, { channel: dm.id, body: 'Private original Human request', requestId: 'root' }, 'auto', 'none'),
    check: (id: string) => hive.adaptiveTopology.revalidateForActor(brain, { kind: 'brain_message', actorId: brain.id, actorRole: 'brain', channelId: dm.id, eventId: id }),
    view: () => hive.adaptiveTopology.view(human, dm.id),
    restart: async () => { await hive.adaptiveTopology.stop(); hive.db.close(); hive = new Hive(path.join(dir, 'hive.db')); listen(); },
  };
}
const privateText = /Private original|never-export|secret-|SQLITE|constraint/i;

test('begin failure degrades collector health, recovers by persisting a gap marker, and never blocks Human work', async t => {
  const f = runtime(t), started = await f.start(); assert.ok(started);
  const executionId = started.state.executionId;
  assert.equal(f.view().collector?.status, 'healthy');
  assert.equal(f.view().state?.evidence?.capture, 'complete');
  const heal = failWrites(f.hive, 'adaptive_evidence_runs', { message: 'secret-database-error', persistent: true });
  const result = await f.check('lost-attempt');
  assert.equal(result?.currentTopology, 'single'); assert.equal(f.calls(), 2, 'No extra Jev call for diagnostics');
  let view = f.view();
  assert.equal(view.state?.providerAvailable, true, 'Jev availability is independent of collector health');
  assert.equal(view.collector?.status, 'degraded'); assert.equal(view.collector?.pendingGaps, 1);
  assert.deepEqual(view.state?.evidence, { capture: 'incomplete', reasons: ['collection_gap'] });
  assert.equal(f.events.at(-1)?.status, 'degraded');
  const response = await createApp(f.hive).request('/api/ui/adaptive-routing/evidence-health');
  assert.equal(response.status, 200);
  const served = await response.json() as EvidenceCollectorHealth;
  assert.equal(served.status, 'degraded'); assert.equal(served.failures.begin, 1);
  // The Jev call history is a separate store and still records the exchange.
  assert.equal(countRows(f.hive, 'jev_calls') >= 2, true);

  heal();
  view = f.view();
  assert.equal(view.collector?.status, 'recovered'); assert.equal(view.collector?.persistedGaps, 1);
  assert.equal(f.events.at(-1)?.status, 'recovered');
  const report = exportAdaptiveEvidence(f.hive.db, executionId);
  assert.equal(report.coverage.capture, 'incomplete'); assert.equal(report.coverage.collectionGap?.missedBegins, 1);
  assert.equal(report.coverage.attemptsStarted, 1); assert.equal(report.overhead.knownInputTokens, 80);
  assert.equal(report.overhead.totalInputTokens, null);
  // Later attempts keep the execution incomplete; health stays `recovered` until the server restarts.
  await f.check('after-recovery');
  assert.equal(exportAdaptiveEvidence(f.hive.db, executionId).coverage.capture, 'incomplete');
  assert.doesNotMatch(JSON.stringify([f.view(), f.events, f.errors, report]), privateText);
  assert.doesNotMatch(JSON.stringify(f.hive.adaptiveTopology.forAgent(f.brain)), /evidence|collector|capture/);
});

test('finish failure leaves a pending attempt explained by a persisted gap, not a complete total', async t => {
  const f = runtime(t), started = await f.start(); assert.ok(started);
  const heal = failWrites(f.hive, 'adaptive_evidence_attempts', { on: 'update', message: 'secret-finish-error', persistent: true });
  await f.check('finish-fails');
  heal();
  const health = f.view().collector!;
  assert.equal(health.status, 'recovered'); assert.deepEqual(health.failures, { begin: 0, finish: 1, marker: 0 });
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.equal(report.coverage.pendingAttempts, 1); assert.equal(report.coverage.collectionGap?.missedFinishes, 1);
  assert.deepEqual(report.coverage.captureReasons, ['collection_gap']);
  assert.equal(report.overhead.totalInputTokens, null);
  assert.ok(f.errors.some(message => message.includes('attempt usage is unknown')));
  assert.doesNotMatch(JSON.stringify([f.view(), f.errors]), privateText);
});

test('a gap marker for a deleted channel is discarded without recreating evidence or blocking recovery', async t => {
  const f = runtime(t), started = await f.start(); assert.ok(started);
  const heal = failWrites(f.hive, 'adaptive_evidence_runs', { persistent: true });
  await f.check('lost-before-delete');
  assert.equal(f.hive.adaptiveTopology.observations.collectorHealth().status, 'degraded');
  for (const agent of [f.brain, f.worker]) f.hive.identity.setOffline(agent.id);
  f.hive.projects.deleteProject(f.human, 'chapter');
  heal();
  const health = f.hive.adaptiveTopology.observations.collectorHealth();
  assert.equal(health.status, 'recovered'); assert.equal(health.discardedGaps, 1); assert.equal(health.persistedGaps, 0);
  assert.equal(countRows(f.hive, 'adaptive_evidence_runs'), 0);
});

test('restart during a gap: a lost marker still cannot yield a complete capture, and a graceful stop persists one', async t => {
  const f = runtime(t);
  void f.hive.adaptiveTopology.observations.evidence; // opens the store so its tables exist
  // A connection-scoped failure: still failing when stop() tries to persist the marker, gone after the restart.
  failWrites(f.hive, 'adaptive_evidence_runs');
  const started = await f.start(); assert.ok(started, 'Human work proceeds while the collector is down');
  const executionId = started.state.executionId;
  assert.equal(f.view().state?.evidence?.capture, 'incomplete');
  await f.restart(); // The store still rejected writes at shutdown: the in-memory marker is lost with the process.
  assert.equal(f.view().collector?.status, 'healthy', 'A new process knows nothing of the lost marker');
  assert.deepEqual(f.view().state?.evidence, { capture: 'unknown', reasons: ['not_recorded'] });
  await f.check('after-restart');
  let report = exportAdaptiveEvidence(f.hive.db, executionId);
  assert.equal(report.coverage.capture, 'incomplete');
  assert.deepEqual(report.coverage.captureReasons, ['recorder_installed_mid_execution']);
  assert.equal(report.overhead.totalInputTokens, null);

  // Store writable again before a graceful restart: stop() persists the held marker.
  const again = failWrites(f.hive, 'adaptive_evidence_runs');
  await f.check('lost-then-restart');
  again();
  await f.restart();
  report = exportAdaptiveEvidence(f.hive.db, executionId);
  assert.equal(report.coverage.collectionGap?.missedBegins, 1);
});

test('collector installation after an execution began is explicitly incomplete for Human and export', async t => {
  const f = runtime(t), started = await f.start(); assert.ok(started);
  // Simulates an execution that started before this database had an evidence recorder.
  deleteRows(f.hive, 'adaptive_evidence_runs', { execution_id: started.state.executionId });
  assert.deepEqual(f.view().state?.evidence, { capture: 'unknown', reasons: ['not_recorded'] });
  await f.check('first-recorded');
  assert.deepEqual(f.view().state?.evidence, { capture: 'incomplete', reasons: ['recorder_installed_mid_execution'] });
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.equal(report.coverage.capture, 'incomplete'); assert.equal(report.coverage.historyComplete, false);
  assert.equal(report.overhead.totalInputTokens, null); assert.equal(report.overhead.knownInputTokens, 80);
  assert.equal(f.view().collector?.status, 'healthy', 'Mid-execution installation is a capture state, not a write failure');
});
