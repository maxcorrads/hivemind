import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  coverage: { attemptsStarted: 1, attemptsFinished: 1, pendingAttempts: 0, retainedAttempts: 1, prunedAttempts: 0, historyComplete: true, usageComplete: true },
  overhead: { successfulAttempts: 1, unavailableAttempts: 0, tokenObservations: 1, unknownUsageAttempts: 0, knownInputTokens: 10, knownOutputTokens: 5,
    totalInputTokens: 10, totalOutputTokens: 5, latencyObservations: 1, knownLatencyMs: 50, summedLatencyMs: 50 } }; }
function completed() {
  const study = prepareStudy(structuredClone(config));
  for (const t of study.trials) t.observed = { evidenceKind: 'synthetic', versions: structuredClone(config.versions), freeWorkers: 3,
    jevEnabled: t.condition === 'auto', initialTopology: t.condition === 'auto' ? 'single' : t.condition, routingOverrides: 0, outcome: 'passed', independentlyReviewed: true, instrumentationHealthy: true,
    wallMs: t.condition === 'auto' ? 110 : 100, workloadTokens: t.condition === 'auto' ? 80 : 100,
    workloadUsageSource: 'provider_reported', defects: 0, routerEvidence: t.condition === 'auto' ? evidence() : null,
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
  assert.deepEqual(validateStudy(a), { expected: 10, completed: 0, pending: 10, resolvedModels: [] });
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
  Object.assign(e.coverage, { retainedAttempts: 0, prunedAttempts: 1, historyComplete: false }); e.attempts = [];
  for (const c of summarizeStudy(pruned).comparison) assert.equal(c.deltaNetTokens.observations, 1);
});
