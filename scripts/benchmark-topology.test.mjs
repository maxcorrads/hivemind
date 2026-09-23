import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../src/test-support/child-process.ts';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareStudy, validateStudy, summarizeStudy, main, CONDITIONS } from './benchmark-topology.mjs';

const config = {
  evidenceKind: 'synthetic', versions: { hivemindRevision: 'a'.repeat(40), provider: 'fixture', model: 'fixture-model-v1', host: 'node-test', configuration: 'fixture-v1', policyVersion: 'topology-policy-v2.1' },
  workloads: [{ id: 'fixture-work', version: 'v1', inputDigest: 'b'.repeat(64), acceptanceDigest: 'c'.repeat(64) }],
  repeats: 2, seed: 29, freeWorkers: 3, limits: { wallMs: 1000, workloadTokens: 1000 },
};
function evidence() { return { schemaVersion: 1, evidenceClass: 'adaptive-evidence-v1', contractVersion: 'adaptive-routing-v2', policyVersion: 'topology-policy-v2.1',
  models: ['jev-fixture-v1'], modelsTruncated: false, attempts: [{ ordinal: 1, phase: 'initial', status: 'ok' }],
  coverage: { attemptsStarted: 1, attemptsFinished: 1, pendingAttempts: 0, retainedAttempts: 1, prunedAttempts: 0, historyComplete: true, usageComplete: true,
    capture: 'complete', captureReasons: [], aggregateCapture: 'complete', collectionGap: null },
  overhead: { successfulAttempts: 1, unavailableAttempts: 0, tokenObservations: 1, unknownUsageAttempts: 0, knownInputTokens: 10, knownOutputTokens: 5,
    totalInputTokens: 10, totalOutputTokens: 5, latencyObservations: 1, knownLatencyMs: 50, summedLatencyMs: 50 } }; }
function completed(studyConfig = config, routerEvidenceForTrial = evidence) {
  const study = prepareStudy(structuredClone(studyConfig));
  for (const t of study.trials) t.observed = { evidenceKind: 'synthetic', versions: structuredClone(studyConfig.versions), freeWorkers: studyConfig.freeWorkers,
    jevEnabled: t.condition === 'auto', initialTopology: t.condition === 'auto' ? 'single' : t.condition, routingOverrides: 0, outcome: 'passed', independentlyReviewed: true, instrumentationHealthy: true,
    wallMs: t.condition === 'auto' ? 110 : 100, workloadTokens: t.condition === 'auto' ? 80 : 100,
    workloadUsageSource: 'provider_reported', defects: 0, routerEvidence: t.condition === 'auto' ? routerEvidenceForTrial() : null,
    routingReview: t.condition === 'auto' ? { underOrchestration: null, prematureDowngrade: null, flapping: null } : null,
    evidenceRef: 'redacted/review.json' };
  return study;
}
const auto = study => study.trials.find(t => t.condition === 'auto');

test('prepare is deterministic, balanced, version-pinned and does not fabricate observations', () => {
  const a = prepareStudy(config), b = prepareStudy(config);
  assert.deepEqual(a, b); assert.equal(a.trials.length, 10);
  assert.equal(new Set(a.trials.map(t => t.id)).size, 10);
  for (const mode of CONDITIONS) assert.equal(a.trials.filter(t => t.condition === mode).length, 2);
  assert.ok(a.trials.every(t => t.observed === null));
  assert.deepEqual(validateStudy(a), { expected: 10, completed: 0, pending: 10, requestedModels: [], resolvedModels: [] });
  assert.notEqual(prepareStudy({ ...config, seed: 30 }).studyId, a.studyId);
});

test('invalid plans reject placeholder versions, insufficient capacity, duplicate workloads and invalid budgets', () => {
  for (const bad of [
    { ...config, evidenceKind: 'unknown' }, { ...config, freeWorkers: 1 }, { ...config, repeats: 0 },
    { ...config, seed: -1 }, { ...config, workloads: [config.workloads[0], config.workloads[0]] },
    { ...config, versions: { ...config.versions, hivemindRevision: 'main' } },
    { ...config, limits: { wallMs: 0, workloadTokens: 2 } }, { ...config, apiKey: 'forbidden' },
  ]) assert.throws(() => prepareStudy(bad));
});

test('pending, missing, duplicate, reordered and changed-configuration cohorts cannot be summarized', () => {
  assert.throws(() => summarizeStudy(prepareStudy(config)), /Pending/);
  const missing = completed(); missing.trials.pop(); assert.throws(() => summarizeStudy(missing), /Missing/);
  const duplicate = completed(); duplicate.trials[1] = duplicate.trials[0]; assert.throws(() => summarizeStudy(duplicate), /identity/);
  const reordered = completed(); reordered.trials.reverse(); assert.throws(() => summarizeStudy(reordered), /identity/);
  const changed = completed(); changed.config.seed++; assert.throws(() => summarizeStudy(changed), /configuration changed/);
});

test('Auto-minus-fixed net tokens include router usage once; wall time never adds router duration twice', () => {
  const summary = summarizeStudy(completed());
  assert.equal(summary.evidenceClass, 'synthetic_topology_comparison');
  for (const c of summary.comparison) {
    assert.equal(c.deltaNetTokens.mean, -5); // 80 + 10 + 5 - 100
    assert.equal(c.deltaWallMs.mean, 10); // 110 - 100, not 110 + 50 - 100
    assert.equal(c.deltaNetTokens.observations, 2);
    assert.deepEqual(c.deltaNetTokens.bootstrap95, [-5, -5]);
  }
  assert.equal(summary.monetaryCost, null); assert.equal(summary.routerReview.underOrchestration.unknown, 2);
});

test('unknown usage is not zero and affects observation denominators explicitly', () => {
  const study = completed(), t = auto(study);
  t.observed.workloadTokens = null; t.observed.workloadUsageSource = 'unknown';
  for (const c of summarizeStudy(study).comparison) assert.equal(c.deltaNetTokens.observations, 1);
  const evidenceMissing = completed(); auto(evidenceMissing).observed.routerEvidence = null;
  assert.throws(() => summarizeStudy(evidenceMissing), /not zero/);
  auto(evidenceMissing).observed.instrumentationHealthy = false;
  for (const c of summarizeStudy(evidenceMissing).comparison) assert.equal(c.deltaNetTokens.observations, 1);
});

test('partial provider evidence retains known usage but excludes incomplete totals', () => {
  const study = completed(), e = auto(study).observed.routerEvidence;
  e.attempts.push({ ordinal: 2, phase: 'continuous', status: 'unavailable' });
  Object.assign(e.coverage, { attemptsStarted: 2, attemptsFinished: 2, retainedAttempts: 2, usageComplete: false });
  Object.assign(e.overhead, { unavailableAttempts: 1, unknownUsageAttempts: 1, totalInputTokens: null, totalOutputTokens: null, summedLatencyMs: null });
  for (const c of summarizeStudy(study).comparison) assert.equal(c.deltaNetTokens.observations, 1);
  e.overhead.totalInputTokens = 10;
  assert.throws(() => summarizeStudy(study));
});

test('no pooling live/synthetic, model, policy, host configuration or initial capacity mismatches', () => {
  for (const change of [
    o => { o.evidenceKind = 'live'; }, o => { o.versions.model = 'other'; }, o => { o.versions.configuration = 'other'; },
    o => { o.freeWorkers = 2; }, o => { o.routerEvidence.policyVersion = 'v1'; },
    o => { o.routerEvidence.contractVersion = 'adaptive-routing-v1'; },
    o => { o.routerEvidence.models = ['jev-other']; },
  ]) { const study = completed(); change(auto(study).observed); assert.throws(() => summarizeStudy(study)); }
});

test('pinned Jev model cohorts check requested identifiers separately from resolved models', () => {
  const pinned = { ...config, versions: { ...config.versions, jevModel: 'jev-2026-09-01' } };
  const requested = () => ({ ...evidence(), requestedModels: ['jev-2026-09-01'], requestedModelsTruncated: false });
  assert.notEqual(prepareStudy(pinned).studyId, prepareStudy(config).studyId, 'a pinned Jev model is part of the study identity');
  assert.deepEqual(validateStudy(completed(pinned, requested)).requestedModels, ['jev-2026-09-01']);
  assert.deepEqual(validateStudy(completed(pinned, requested)).resolvedModels, ['jev-fixture-v1']);
  assert.ok(summarizeStudy(completed(pinned, requested)));
  // Pre-#134 exports do not record the requested model: they cannot join a pinned cohort, but stay valid unpinned.
  assert.throws(() => validateStudy(completed(pinned)), /does not record the requested Jev model/);
  assert.deepEqual(validateStudy(completed()).requestedModels, []);
  assert.throws(() => validateStudy(completed(pinned, () => ({ ...requested(), requestedModels: ['jev-latest'] }))), /differs from versions.jevModel/);
  const alternating = (a, b) => { let n = 0; return () => (n++ % 2 ? b : a); };
  const requestedSeq = alternating('jev-a', 'jev-b');
  assert.throws(() => validateStudy(completed(config, () => ({ ...requested(), requestedModels: [requestedSeq()] }))),
    /Requested Jev models differ/);
  // Response drift under a pinned request is still rejected by the resolved-model check.
  const resolvedSeq = alternating('jev-r1', 'jev-r2');
  assert.throws(() => validateStudy(completed(pinned, () => ({ ...requested(), models: [resolvedSeq()] }))),
    /Resolved Jev models differ/);
  assert.throws(() => prepareStudy({ ...config, versions: { ...config.versions, jevModel: 'https://evil.example/v1' } }), /bounded Jev model/);
  assert.throws(() => validateStudy(completed(config, () => ({ ...requested(), requestedModels: ['a/b'] }))), /Invalid requested models/);
});

test('manual locks with Jev monitoring cannot masquerade as a fixed no-router baseline', () => {
  const study = completed(), fixed = study.trials.find(t => t.condition === 'single');
  fixed.observed.jevEnabled = true;
  assert.throws(() => summarizeStudy(study), /Fixed baseline/);
});

test('quality regressions are separate from efficiency; harness and interrupted outcomes remain visible', () => {
  const study = completed(); auto(study).observed.outcome = 'quality_failed'; auto(study).observed.defects = 1;
  const summary = summarizeStudy(study);
  for (const c of summary.comparison) { assert.equal(c.qualityRegressions, 1); assert.equal(c.deltaNetTokens.observations, 1); }
  assert.equal(summary.routerReview.underOrchestration.flagged, 0, 'failure is not automatically a routing diagnosis');
  auto(study).observed.outcome = 'harness_failed'; auto(study).observed.independentlyReviewed = false;
  const failed = summarizeStudy(study);
  assert.equal(failed.outcomes.auto.harness_failed, 1);
  for (const c of failed.comparison) { assert.equal(c.excludedHarnessOrInterruptedPairs, 1); assert.equal(c.qualityRegressions, 0); }
});

test('unreviewed quality outcomes cannot produce empirical efficiency conclusions', () => {
  const study = completed(); auto(study).observed.independentlyReviewed = false;
  assert.equal(validateStudy(study).completed, 10);
  assert.throws(() => summarizeStudy(study), /independent review/);
});

test('routing diagnoses require explicit reviewer labels and unknown remains unknown', () => {
  const study = completed(); auto(study).observed.routingReview.underOrchestration = true;
  const summary = summarizeStudy(study);
  assert.deepEqual(summary.routerReview.underOrchestration, { reviewed: 1, flagged: 1, unknown: 1 });
});

test('invalid counts, inconsistent evidence and credential-bearing artifact references fail closed', () => {
  for (const change of [
    o => { o.workloadTokens = -1; }, o => { o.workloadTokens = Infinity; }, o => { o.evidenceRef = '../secret'; },
    o => { o.evidenceRef = 'https://user:password@example.com/x'; }, o => { o.routerEvidence.coverage.pendingAttempts = 5; },
    o => { o.routerEvidence.overhead.knownInputTokens = 20; }, o => { o.apiKey = 'forbidden'; },
  ]) { const study = completed(); change(auto(study).observed); assert.throws(() => summarizeStudy(study)); }
});

test('CLI is offline, uses exclusive private outputs, preserves inputs and diagnoses unknown commands', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-study-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'config.json'), output = path.join(dir, 'study.json'), summary = path.join(dir, 'summary.json');
  writeFileSync(input, JSON.stringify(config)); const original = readFileSync(input, 'utf8');
  main(['prepare','--input',input,'--output',output]);
  assert.equal(statSync(output).mode & 0o777, 0o600); assert.equal(readFileSync(input, 'utf8'), original);
  assert.equal(main(['validate','--input',output]).pending, 10);
  assert.throws(() => main(['prepare','--input',input,'--output',output]), /EEXIST/);
  writeFileSync(output, JSON.stringify(completed())); main(['summarize','--input',output,'--output',summary]);
  assert.equal(JSON.parse(readFileSync(summary, 'utf8')).evidenceClass, 'synthetic_topology_comparison');
  assert.throws(() => main(['run','--input',input])); assert.throws(() => main(['prepare','--input',input]));
  assert.throws(() => main(['validate','--input',input,'--bogus','value']));
});

test('CLI validates and summarizes the full supported cohort with retained export detail', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-large-study-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'study.json'), output = path.join(dir, 'summary.json');
  const model = 'm'.repeat(200), attempts = 500;
  // Synthetic adaptive-evidence-v1 export shape, including the producer's bounded
  // policy tail. This contract fixture does not import or require its recorder.
  const retained = { ...evidence(), executionAlias: 'execution-1', models: [model],
    coverage: { startedAt: 1900000000000, endedAt: 1900000000500, attemptsStarted: attempts, attemptsFinished: attempts,
      pendingAttempts: 0, retainedAttempts: attempts, prunedAttempts: 0, historyComplete: true, usageComplete: true,
      collection: 'since_recorder_installation', countsAre: 'classifier_attempts_not_verified_billable_calls',
      capture: 'complete', captureReasons: [], aggregateCapture: 'complete', collectionGap: null },
    overhead: { successfulAttempts: attempts, unavailableAttempts: 0, tokenObservations: attempts, unknownUsageAttempts: 0,
      knownInputTokens: 5000, knownOutputTokens: 2500, totalInputTokens: 5000, totalOutputTokens: 2500,
      latencyObservations: attempts, knownLatencyMs: 25000, summedLatencyMs: 25000, monetaryCost: null },
    attempts: Array.from({ length: attempts }, (_, i) => ({ ordinal: i + 1, phase: i ? 'continuous' : 'initial', status: 'ok',
      currentTopology: i ? 'brain_multi_room' : null, currentWorkers: i ? 254 : 0, usableWorkers: 254, targetTopology: 'brain_multi_room',
      targetWorkers: 254, confidence: 0.9999999999999999, latencyMs: 50, inputTokens: 10, outputTokens: 5, model })),
    policyEvents: Array.from({ length: 500 }, () => ({ kind: 'transition', from: 'brain_multi_room', target: 'brain_multi_room',
      applied: 'brain_multi_room', targetWorkers: 254, appliedWorkers: 254, changed: false, hasWarning: false })),
    policyEventCoverage: 'retained_tail_only', limitations: ['Synthetic export fixture; not measured performance.'] };
  const study = completed({ ...config, repeats: 10, freeWorkers: 254, limits: { ...config.limits, wallMs: 60000 },
    workloads: Array.from({ length: 10 }, (_, i) => ({ ...config.workloads[0], id: `fixture-work-${i}` })) }, () => retained);
  for (const trial of study.trials) {
    trial.observed.wallMs = trial.condition === 'auto' ? 30000 : 28000;
    if (trial.condition === 'auto') trial.observed.initialTopology = 'brain_multi_room';
  }
  writeFileSync(input, JSON.stringify(study, null, 2), { mode: 0o600 });
  const bytes = statSync(input).size;
  assert.ok(bytes > 8 * 1024 * 1024, 'Regression must exceed the former CLI bound');
  t.diagnostic(`Full exported-evidence cohort: ${bytes} bytes, 500 trials, 50,000 attempt details and 50,000 policy events`);
  const cli = new URL('./benchmark-topology.mjs', import.meta.url).pathname;
  const validated = spawnSync(process.execPath, [cli, 'validate', '--input', input], { encoding: 'utf8', env: childEnv() });
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), { expected: 500, completed: 500, pending: 0, requestedModels: [], resolvedModels: [model] });
  const summarized = spawnSync(process.execPath, [cli, 'summarize', '--input', input, '--output', output], { encoding: 'utf8', env: childEnv() });
  assert.equal(summarized.status, 0, summarized.stderr);
  const summary = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(summary.evidenceClass, 'synthetic_topology_comparison');
  for (const comparison of summary.comparison) {
    assert.equal(comparison.matchedPairs, 100);
    assert.equal(comparison.deltaNetTokens.observations, 100);
    assert.equal(comparison.deltaNetTokens.mean, 7480);
  }
});

test('CLI rejects oversized input before parsing and does not create output', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-oversized-study-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'oversized.json'), output = path.join(dir, 'summary.json');
  writeFileSync(input, '{}'); truncateSync(input, 128 * 1024 * 1024 + 1);
  for (const command of ['validate', 'summarize']) {
    assert.throws(() => main([command, '--input', input, '--output', output]), /Study file exceeds 128 MiB/);
    assert.throws(() => statSync(output), { code: 'ENOENT' });
  }
});

test('mid-execution or pruned capture cannot claim complete net router savings', () => {
  const study = completed(); auto(study).observed.routerEvidence.attempts[0].phase = 'continuous';
  for (const c of summarizeStudy(study).comparison) assert.equal(c.deltaNetTokens.observations, 1);
});

test('fixed-mode mismatch, unplanned override and budget overshoot are explicit', () => {
  const study = completed(); study.trials.find(t => t.condition === 'single').observed.initialTopology = 'brain_one_worker';
  assert.throws(() => summarizeStudy(study), /not applied/);
  const override = completed(); auto(override).observed.routingOverrides = 1;
  assert.throws(() => summarizeStudy(override), /separate experimental/);
  const exceeded = completed(); auto(exceeded).observed.wallMs = 1001;
  assert.equal(summarizeStudy(exceeded).budgetExceeded.auto, 1);
});

test('independent review defects are visible even when deterministic acceptance passed', () => {
  const study = completed(); auto(study).observed.defects = 2;
  for (const c of summarizeStudy(study).comparison) {
    assert.equal(c.qualityRegressions, 0);
    assert.equal(c.deltaDefects.observations, 2);
    assert.equal(c.deltaDefects.mean, 1);
    assert.equal(c.pairs.filter(p => p.autoDefects === 2).length, 1);
  }
});

test('missing resolved model or pruned capture suppresses net usage comparison', () => {
  const unknown = completed(); auto(unknown).observed.routerEvidence.models = [];
  for (const c of summarizeStudy(unknown).comparison) assert.equal(c.deltaNetTokens.observations, 1);
  const pruned = completed(), e = auto(pruned).observed.routerEvidence;
  Object.assign(e.coverage, { retainedAttempts: 0, prunedAttempts: 1, historyComplete: false,
    capture: 'incomplete', captureReasons: ['history_truncated'] }); e.attempts = [];
  for (const c of summarizeStudy(pruned).comparison) assert.equal(c.deltaNetTokens.observations, 1);
});

test('acknowledged incomplete history needs no pruning to suppress net usage', () => {
  const study = completed(), e = auto(study).observed.routerEvidence;
  // Exports made before capture state existed: validated as before, never eligible for net comparisons.
  for (const k of ['capture', 'captureReasons', 'aggregateCapture', 'collectionGap']) delete e.coverage[k];
  for (const comparison of summarizeStudy(study).comparison) assert.equal(comparison.deltaNetTokens.observations, 1);
  assert.equal(summarizeStudy(study).routerCapture.unknown, 1);
  e.coverage.historyComplete = false;
  for (const comparison of summarizeStudy(study).comparison) assert.equal(comparison.deltaNetTokens.observations, 1);
  e.attempts[0].phase = 'continuous';
  for (const comparison of summarizeStudy(study).comparison) assert.equal(comparison.deltaNetTokens.observations, 1);
  e.coverage.historyComplete = 'false';
  assert.throws(() => summarizeStudy(study));
  Object.assign(e.coverage, { retainedAttempts: 0, prunedAttempts: 1, historyComplete: true }); e.attempts = [];
  assert.throws(() => summarizeStudy(study), /Pruned evidence/);
});

function gapEvidence() {
  const e = evidence();
  Object.assign(e.coverage, { capture: 'incomplete', captureReasons: ['collection_gap'], aggregateCapture: 'incomplete',
    collectionGap: { missedBegins: 1, missedFinishes: 0, unattributed: 0 }, historyComplete: false, usageComplete: false });
  Object.assign(e.overhead, { totalInputTokens: null, totalOutputTokens: null, summedLatencyMs: null });
  return e;
}

test('the scorer consumes exported capture state instead of trusting a healthy flag or provider status', () => {
  const gap = completed(config, gapEvidence);
  for (const trial of gap.trials) assert.equal(trial.observed.instrumentationHealthy, true);
  const summary = summarizeStudy(gap);
  assert.deepEqual(summary.routerCapture, { complete: 0, incomplete: 2, unknown: 0, missing: 0 });
  for (const c of summary.comparison) {
    assert.equal(c.deltaNetTokens.observations, 0, 'Retained usage across a known gap is never a full-run total');
    assert.equal(c.deltaWallMs.observations, 2, 'Wall time is measured outside the collector');
  }
  const complete = summarizeStudy(completed());
  assert.deepEqual(complete.routerCapture, { complete: 2, incomplete: 0, unknown: 0, missing: 0 });
});

test('inconsistent capture state is rejected instead of promoted', () => {
  const cases = [
    e => { e.coverage.capture = 'complete'; },
    e => { e.coverage.captureReasons = ['invented']; },
    e => { e.overhead.totalInputTokens = e.overhead.knownInputTokens; e.overhead.totalOutputTokens = e.overhead.knownOutputTokens; e.coverage.usageComplete = true; },
    e => { e.coverage.collectionGap = null; e.coverage.captureReasons = []; },
    e => { e.coverage.historyComplete = true; },
    e => { e.coverage.aggregateCapture = 'complete'; },
    e => { e.coverage.collectionGap.missedBegins = -1; },
  ];
  for (const mutate of cases) {
    const study = completed(config, () => { const e = gapEvidence(); mutate(e); return e; });
    assert.throws(() => validateStudy(study), mutate.toString());
  }
  const gapOnly = completed(config, () => {
    const e = gapEvidence(); e.attempts = [];
    Object.assign(e.coverage, { attemptsStarted: 0, attemptsFinished: 0, retainedAttempts: 0 });
    Object.assign(e.overhead, { successfulAttempts: 0, tokenObservations: 0, knownInputTokens: 0, knownOutputTokens: 0, latencyObservations: 0, knownLatencyMs: 0 });
    return e;
  });
  assert.equal(validateStudy(gapOnly).completed, gapOnly.trials.length, 'Gap-only evidence is a valid, incomplete observation');
});
