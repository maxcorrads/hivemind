import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONDITIONS, prepareStudy, summarizeStudy, validateStudy } from './benchmark-topology.mjs';
import {
  appendDurable, dryRun, exportRun, loadRun, main, prepareRun, reconcileTrial, runStudy, sha256, trialState, validateRun, withoutNetwork,
} from './topology-study-runner.mjs';

const REVISION = 'a'.repeat(40);
const versions = { hivemindRevision: REVISION, provider: 'fixture', model: 'fixture-model', host: 'opencode/1.0.0-fake',
  configuration: 'auto', policyVersion: 'topology-policy-v2.1', jevModel: 'jev-fixture-pin' };

function setup({ evidenceKind = 'synthetic', repeats = 2, expectedResolvedModel = null, studyVersions = versions } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivemind-study-runner-'));
  writeFileSync(path.join(dir, 'input.txt'), 'fixture request\n');
  writeFileSync(path.join(dir, 'acceptance.txt'), 'fixture acceptance\n');
  const study = prepareStudy({ evidenceKind, versions: studyVersions, repeats, seed: 29, freeWorkers: 3,
    workloads: [{ id: 'fixture-work', version: 'v1', inputDigest: sha256(readFileSync(path.join(dir, 'input.txt'))),
      acceptanceDigest: sha256(readFileSync(path.join(dir, 'acceptance.txt'))) }],
    limits: { wallMs: 1000, workloadTokens: 1000 } });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(study, null, 2));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ schemaVersion: 1, manifest: 'manifest.json',
    workloads: [{ id: 'fixture-work', input: 'input.txt', acceptance: 'acceptance.txt' }],
    host: { name: 'opencode', binaryVersion: '1.0.0-fake' }, jev: { expectedResolvedModel } }));
  const runDir = path.join(dir, 'run');
  prepareRun({ planPath: path.join(dir, 'plan.json'), runDir });
  return { dir, runDir, study, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function evidence({ models = ['jev-resolved-v1'], requested = ['jev-fixture-pin'] } = {}) {
  return { schemaVersion: 1, evidenceClass: 'adaptive-evidence-v1', contractVersion: 'adaptive-routing-v2', policyVersion: 'topology-policy-v2.1',
    executionAlias: 'execution-1', models, modelsTruncated: false, requestedModels: requested, requestedModelsTruncated: false,
    attempts: [{ ordinal: 1, phase: 'initial', status: 'ok' }],
    coverage: { attemptsStarted: 1, attemptsFinished: 1, pendingAttempts: 0, retainedAttempts: 1, prunedAttempts: 0, historyComplete: true, usageComplete: true,
      capture: 'complete', captureReasons: [], aggregateCapture: 'complete', collectionGap: null },
    overhead: { successfulAttempts: 1, unavailableAttempts: 0, tokenObservations: 1, unknownUsageAttempts: 0, knownInputTokens: 10, knownOutputTokens: 5,
      totalInputTokens: 10, totalOutputTokens: 5, latencyObservations: 1, knownLatencyMs: 50, summedLatencyMs: 50 } };
}

/** In-memory host: no process, socket or provider. `behave(spec, n)` returns result overrides or throws. */
function fakeHost({ behave = () => ({}), pre = {}, evidenceKind = 'synthetic' } = {}) {
  const calls = [];
  return {
    calls, evidenceKind,
    async preflight({ versions: v }) {
      return { checkout: { revision: REVISION, clean: true }, versions: { ...v }, jevRequestedModel: 'jev-fixture-pin', credentials: { jev: true }, ...pre };
    },
    async executeTrial(spec) {
      calls.push(spec);
      assert.ok(existsSync(spec.home) && existsSync(spec.workspace), 'fresh isolated home and workspace exist');
      const auto = spec.condition === 'auto';
      const base = { phase: 'completed', observedFreeWorkers: spec.freeWorkers, jevEnabled: spec.jevEnabled, jevRequestedModel: auto ? spec.jevRequestedModel : 'jev-fixture-pin',
        jevAttempts: auto ? 1 : 0, initialTopology: auto ? 'brain_one_worker' : spec.condition, routingOverrides: 0, outcome: 'passed', interruption: null,
        wallMs: auto ? 110 : 100, seatUsage: Array.from({ length: spec.freeWorkers + 1 }, (_, i) => ({ seat: `seat-${i}`, tokens: auto ? 20 : 25 })),
        resolvedWorkloadModels: ['fixture-model'], acceptance: { passed: true, defects: 0 }, routerEvidence: auto ? evidence() : null,
        collectorWarnings: 0, artifacts: ['server.log'] };
      return { ...base, ...behave(spec, calls.length) };
    },
  };
}
const authorized = (ctx, host, extra = {}) => runStudy({ runDir: ctx.runDir, host, authorization: ctx.study.studyId, ...extra });
const exported = ctx => exportRun({ runDir: ctx.runDir });

test('all five conditions run in the manifest order with fresh homes, Jev only for Auto and the Human lock for fixed baselines', async () => {
  const ctx = setup();
  try {
    const host = fakeHost();
    assert.deepEqual(await authorized(ctx, host), { status: 'complete', trialId: null, executed: 10 });
    assert.deepEqual(host.calls.map(s => s.trialId), ctx.study.trials.map(t => t.id), 'randomized manifest order is preserved');
    assert.equal(new Set(host.calls.map(s => s.home)).size, 10);
    for (const spec of host.calls) {
      const auto = spec.condition === 'auto';
      assert.equal(spec.jevEnabled, auto); assert.equal(spec.routing, auto ? 'auto' : spec.condition);
      assert.equal(spec.lockScope, auto ? 'none' : 'task'); assert.equal(spec.freeWorkers, 3);
      assert.equal(spec.jevRequestedModel, 'jev-fixture-pin');
      assert.ok(spec.home.startsWith(ctx.runDir) && !spec.home.includes(path.join(os.homedir(), '.hivemind')));
    }
    const { study, report } = exported(ctx);
    assert.equal(validateStudy(study).completed, 10);
    for (const c of CONDITIONS) assert.equal(report.trials.filter(t => t.condition === c && t.state === 'completed').length, 2);
    for (const t of study.trials) {
      const o = t.observed, auto = t.condition === 'auto';
      assert.equal(o.independentlyReviewed, false, 'automated runs are never marked reviewed');
      assert.equal(o.routingReview, null);
      assert.equal(o.jevEnabled, auto); assert.equal(o.routerEvidence === null, !auto);
      assert.equal(o.workloadTokens, auto ? 80 : 100, 'workload tokens exclude Jev usage');
      assert.equal(o.wallMs, auto ? 110 : 100, 'router latency is never added to end-to-end wall time');
      assert.match(o.evidenceRef, /^trials\/[a-f0-9]{24}\/attempt-001$/);
    }
    assert.ok(!JSON.stringify({ study, report }).includes(ctx.dir), 'only redacted relative references are exported');
    assert.throws(() => summarizeStudy(study), /independent review/);
    for (const t of study.trials) t.observed.independentlyReviewed = true; // what a later reviewer does in a new retained file
    for (const c of summarizeStudy(study).comparison) { assert.equal(c.deltaWallMs.mean, 10); assert.equal(c.deltaNetTokens.mean, -5); }
    assert.equal(report.jev.resolvedModelPin, 'jev-resolved-v1');
    assert.deepEqual(validateRun({ runDir: ctx.runDir }).states, { completed: 10 });
  } finally { ctx.cleanup(); }
});

test('paid execution needs the exact study authorization and a host of the same evidence kind', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const host = fakeHost();
    await assert.rejects(runStudy({ runDir: ctx.runDir, host }), /authorize-paid-run/);
    await assert.rejects(runStudy({ runDir: ctx.runDir, host, authorization: 'f'.repeat(64) }), /authorize-paid-run/);
    await assert.rejects(authorized(ctx, fakeHost({ evidenceKind: 'live' })), /evidence kind/);
    assert.equal(host.calls.length, 0);
    await assert.rejects(main(['run', '--run-dir', ctx.runDir], { env: {}, createHost: () => host }), /authorize-paid-run/);
    await assert.rejects(main(['run', '--run-dir', ctx.runDir, '--authorize-paid-run', ctx.study.studyId], { env: { CI: 'true' }, createHost: () => host }), /CI/);
    await assert.rejects(main(['run', '--run-dir', ctx.runDir, '--authorize-paid-run', ctx.study.studyId], { env: {}, createHost: () => host }), /synthetic/);
    assert.equal(host.calls.length, 0);
  } finally { ctx.cleanup(); }
});

test('wrong artifact hashes, manifest bytes, runner versions and checkout/host versions stop before any trial starts', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const run = loadRun(ctx.runDir), input = path.join(ctx.runDir, 'workloads', run.run.workloads['fixture-work'].dir, 'input');
    const original = readFileSync(input);
    writeFileSync(input, 'tampered\n');
    const host = fakeHost();
    const halted = await authorized(ctx, host);
    assert.equal(halted.status, 'preflight_drift'); assert.deepEqual(halted.drift.map(d => d.field), ['workload.input']);
    assert.equal(host.calls.length, 0);
    writeFileSync(input, original);
    for (const [pre, field] of [[{ checkout: { revision: 'b'.repeat(40), clean: true } }, 'checkout.revision'], [{ checkout: { revision: REVISION, clean: false } }, 'checkout.clean'],
      [{ versions: { ...versions, host: 'opencode/2.0.0' } }, 'versions.host'], [{ versions: { ...versions, policyVersion: 'topology-policy-v3' } }, 'versions.policyVersion'],
      [{ jevRequestedModel: 'jev-latest' }, 'jev.requestedModel'], [{ credentials: { jev: false } }, 'credentials.jev']]) {
      const drifted = fakeHost({ pre });
      const result = await authorized(ctx, drifted);
      assert.equal(result.status, 'preflight_drift', field);
      assert.ok(result.drift.some(d => d.field === field), field);
      // Jev model/credential checks apply to Auto only: fixed trials before it run normally, then Auto is refused.
      if (['jev.requestedModel', 'credentials.jev'].includes(field)) assert.equal(ctx.study.trials.find(t => t.id === result.trialId).condition, 'auto');
      else assert.equal(result.trialId, ctx.study.trials[0].id);
    }
    assert.ok(exported(ctx).report.trials.some(t => t.preflightDrift.includes('workload.input')), 'drift is retained');
    const manifest = path.join(ctx.runDir, 'manifest.json');
    chmodSync(manifest, 0o600); appendFileSync(manifest, ' '); assert.throws(() => loadRun(ctx.runDir), /Manifest bytes changed/);
  } finally { ctx.cleanup(); }
  const wrong = setup({ repeats: 1 });
  try {
    writeFileSync(path.join(wrong.dir, 'input.txt'), 'other\n');
    assert.throws(() => prepareRun({ planPath: path.join(wrong.dir, 'plan.json'), runDir: path.join(wrong.dir, 'run-2') }), /Input artifact hash mismatch/);
    const runJson = path.join(wrong.runDir, 'run.json'), value = JSON.parse(readFileSync(runJson, 'utf8'));
    chmodSync(runJson, 0o600); writeFileSync(runJson, JSON.stringify({ ...value, runnerVersion: 'topology-study-runner-v0' }));
    assert.throws(() => loadRun(wrong.runDir), /do not mix runner versions/);
    const observed = JSON.parse(readFileSync(path.join(wrong.dir, 'manifest.json'), 'utf8'));
    observed.trials[0].observed = { bogus: true };
    writeFileSync(path.join(wrong.dir, 'manifest.json'), JSON.stringify(observed));
    writeFileSync(path.join(wrong.dir, 'input.txt'), 'fixture request\n');
    assert.throws(() => prepareRun({ planPath: path.join(wrong.dir, 'plan.json'), runDir: path.join(wrong.dir, 'run-3') }));
  } finally { wrong.cleanup(); }
});

test('capacity changes: aborted-before-request attempts are retained and a later attempt starts fresh; post-request capacity drift is withheld', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const first = await authorized(ctx, fakeHost({ behave: () => ({ phase: 'aborted_before_request', reason: 'capacity_mismatch', drift: [{ field: 'freeWorkers', expected: 3, actual: 2 }] }) }));
    assert.equal(first.status, 'aborted_before_request');
    const host = fakeHost({ behave: (spec, n) => n === 2 ? { observedFreeWorkers: 4 } : {} });
    const second = await authorized(ctx, host);
    assert.equal(second.status, 'configuration_drift'); assert.deepEqual(second.exclusions, ['capacity_mismatch']);
    assert.equal(host.calls[0].attempt, 2, 'a new attempt directory, never reuse');
    const { study, report } = exported(ctx);
    const retried = report.trials[0];
    assert.deepEqual(retried.abortedAttempts, [{ attempt: 1, reason: 'capacity_mismatch', drift: ['freeWorkers'] }]);
    assert.equal(report.trials[1].state, 'completed'); assert.deepEqual(report.trials[1].exclusions, ['capacity_mismatch']);
    assert.equal(study.trials[1].observed, null, 'withheld observations stay out of the cohort');
    assert.equal(report.counts.withheld, 1);
  } finally { ctx.cleanup(); }
});

test('unknown usage stays null and marks instrumentation unhealthy instead of zero', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    await authorized(ctx, fakeHost({ behave: (spec, n) => n === 1 ? { seatUsage: [{ seat: 'brain', tokens: null }, { seat: 'worker-1', tokens: 30 }] } : {} }));
    const o = exported(ctx).study.trials[0].observed;
    assert.equal(o.workloadTokens, null); assert.equal(o.workloadUsageSource, 'unknown'); assert.equal(o.instrumentationHealthy, false);
    const second = exported(ctx).study.trials[1].observed;
    assert.equal(second.workloadUsageSource, 'provider_reported');
  } finally { ctx.cleanup(); }
  const partial = setup({ repeats: 1 });
  try {
    // A collection gap (#135) keeps valid evidence but is never healthy, even with no server warning.
    const incomplete = evidence();
    Object.assign(incomplete.coverage, { capture: 'incomplete', captureReasons: ['collection_gap'], aggregateCapture: 'incomplete',
      collectionGap: { missedBegins: 1, missedFinishes: 0, unattributed: 0 }, historyComplete: false, usageComplete: false });
    Object.assign(incomplete.overhead, { totalInputTokens: null, totalOutputTokens: null, summedLatencyMs: null });
    await authorized(partial, fakeHost({ behave: spec => spec.condition === 'auto' ? { routerEvidence: incomplete } : {} }));
    const auto = exported(partial).study.trials.find(t => t.condition === 'auto').observed;
    assert.equal(auto.instrumentationHealthy, false); assert.notEqual(auto.routerEvidence, null);
    assert.match(exported(partial).report.captureCompleteness, /required/);
  } finally { partial.cleanup(); }
  const legacy = setup({ repeats: 1 });
  try {
    // An export without capture state predates #135: its completeness is unknown, so it is not healthy either.
    const unknown = evidence();
    for (const k of ['capture', 'captureReasons', 'aggregateCapture', 'collectionGap']) delete unknown.coverage[k];
    await authorized(legacy, fakeHost({ behave: spec => spec.condition === 'auto' ? { routerEvidence: unknown } : {} }));
    const auto = exported(legacy).study.trials.find(t => t.condition === 'auto').observed;
    assert.equal(auto.instrumentationHealthy, false); assert.notEqual(auto.routerEvidence, null);
  } finally { legacy.cleanup(); }
});

test('a lost response is retained for reconciliation, never re-run, and the cohort continues only after a Human resolution', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const lost = fakeHost({ behave: () => ({ phase: 'ambiguous', reason: 'lost_request_response' }) });
    assert.equal((await authorized(ctx, lost)).status, 'ambiguous');
    const again = fakeHost();
    const blocked = await authorized(ctx, again);
    assert.deepEqual([blocked.status, blocked.reason, again.calls.length], ['ambiguous', 'awaiting_reconciliation', 0]);
    const trial = ctx.study.trials[0];
    assert.throws(() => reconcileTrial({ runDir: ctx.runDir, trialId: ctx.study.trials[1].id, resolution: 'interrupted', initialTopology: 'single' }), /Only an ambiguous/);
    assert.throws(() => reconcileTrial({ runDir: ctx.runDir, trialId: trial.id, resolution: 'passed', initialTopology: 'single' }), /interrupted or harness_failed/);
    reconcileTrial({ runDir: ctx.runDir, trialId: trial.id, resolution: 'interrupted', initialTopology: 'single', note: 'server log shows no completion' });
    const resumed = fakeHost();
    assert.equal((await authorized(ctx, resumed)).status, 'complete');
    assert.equal(resumed.calls.length, 4); assert.ok(resumed.calls.every(s => s.trialId !== trial.id));
    const { study, report } = exported(ctx);
    assert.equal(study.trials[0].observed.outcome, 'interrupted'); assert.equal(study.trials[0].observed.instrumentationHealthy, false);
    assert.deepEqual(report.trials[0].ambiguousAttempts, [{ attempt: 1, reason: 'lost_request_response' }]);
    assert.equal(report.trials[0].reconciliation, 'interrupted');
    const thrown = setup({ repeats: 1 });
    try {
      const result = await authorized(thrown, fakeHost({ behave: () => { throw new Error('socket hang up Bearer secret-token'); } }), { secrets: ['secret-token'] });
      assert.equal(result.status, 'ambiguous');
      const journal = readFileSync(path.join(thrown.runDir, 'trials', thrown.study.trials[0].id, 'journal.jsonl'), 'utf8');
      assert.ok(!journal.includes('secret-token'));
      const invalid = setup({ repeats: 1 });
      try { assert.equal((await authorized(invalid, fakeHost({ behave: () => ({ extra: true }) }))).status, 'ambiguous'); } finally { invalid.cleanup(); }
    } finally { thrown.cleanup(); }
  } finally { ctx.cleanup(); }
});

test('resume is idempotent through durable checkpoints; a crash mid-trial becomes ambiguous rather than a silent rerun', async () => {
  const ctx = setup();
  try {
    const first = fakeHost();
    assert.equal((await authorized(ctx, first, { maxTrials: 3 })).status, 'paused');
    const second = fakeHost();
    assert.equal((await authorized(ctx, second)).status, 'complete');
    assert.deepEqual([...first.calls, ...second.calls].map(s => s.trialId), ctx.study.trials.map(t => t.id));
    const third = fakeHost();
    assert.deepEqual(await authorized(ctx, third), { status: 'complete', trialId: null, executed: 0 });
    assert.equal(third.calls.length, 0);
  } finally { ctx.cleanup(); }
  const crashed = setup({ repeats: 1 });
  try {
    const trial = crashed.study.trials[0], journal = path.join(crashed.runDir, 'trials', trial.id, 'journal.jsonl');
    mkdirSync(path.dirname(journal), { recursive: true });
    appendDurable(journal, { type: 'started', attempt: 1 });
    appendFileSync(journal, '{"type":"completed","attem'); // torn write at crash time
    const ctx2 = loadRun(crashed.runDir);
    assert.equal(trialState(ctx2, trial.id).state, 'started_unresolved');
    const host = fakeHost();
    assert.deepEqual([(await authorized(crashed, host)).status, host.calls.length], ['ambiguous', 0]);
    assert.equal(exported(crashed).report.trials[0].ambiguousAttempts[0].reason, 'runner_stopped_without_result');
  } finally { crashed.cleanup(); }
});

test('Jev model drift: requested and resolved model changes are retained but withheld from the pinned cohort', async () => {
  const ctx = setup({ repeats: 2 });
  try {
    let autos = 0;
    const host = fakeHost({ behave: spec => spec.condition === 'auto' && ++autos === 2 ? { routerEvidence: evidence({ models: ['jev-resolved-v2'] }) } : {} });
    const result = await authorized(ctx, host);
    assert.equal(result.status, 'configuration_drift'); assert.deepEqual(result.exclusions, ['jev_resolved_model_drift']);
    const { study, report } = exported(ctx);
    assert.equal(report.jev.resolvedModelPin, 'jev-resolved-v1');
    assert.equal(study.trials.find(t => t.id === result.trialId).observed, null);
    assert.deepEqual(validateStudy(study).resolvedModels, ['jev-resolved-v1']);
  } finally { ctx.cleanup(); }
  for (const [label, override] of [
    ['requested', { routerEvidence: evidence({ requested: ['jev-latest'] }) }],
    ['settings', { jevRequestedModel: 'jev-latest' }],
    ['expected', { routerEvidence: evidence({ models: ['jev-other'] }) }],
  ]) {
    const drift = setup({ repeats: 1, expectedResolvedModel: label === 'expected' ? 'jev-expected' : null });
    try {
      const result = await authorized(drift, fakeHost({ behave: spec => spec.condition === 'auto' ? override : {} }));
      assert.equal(result.status, 'configuration_drift', label);
      assert.deepEqual(result.exclusions, [label === 'expected' ? 'jev_resolved_model_drift' : 'jev_requested_model_drift'], label);
    } finally { drift.cleanup(); }
  }
  const workload = setup({ repeats: 1 });
  try {
    const result = await authorized(workload, fakeHost({ behave: () => ({ resolvedWorkloadModels: ['fixture-model-2'] }) }));
    assert.deepEqual(result.exclusions, ['workload_model_drift']);
  } finally { workload.cleanup(); }
});

test('monitored fixed baselines, unapplied locks and Human overrides are withheld rather than counted as clean baselines', async () => {
  for (const [override, exclusion] of [[{ jevAttempts: 1 }, 'monitored_fixed_baseline'], [{ jevEnabled: true }, 'jev_toggle_drift'],
    [{ initialTopology: 'single' }, 'topology_not_applied'], [{ routingOverrides: 1 }, 'unplanned_override']]) {
    const ctx = setup({ repeats: 1 });
    try {
      const target = ctx.study.trials.find(t => t.condition !== 'auto' && t.condition !== 'single');
      const result = await authorized(ctx, fakeHost({ behave: spec => spec.trialId === target.id ? override : {} }));
      assert.equal(result.trialId, target.id); assert.ok(result.exclusions.includes(exclusion), exclusion);
    } finally { ctx.cleanup(); }
  }
});

test('interrupted and budget-exceeded trials are retained with explicit budget flags; a Human signal stops the cohort', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const host = fakeHost({ behave: (spec, n) => n === 1 ? { outcome: 'interrupted', interruption: 'wall_budget', wallMs: 1500, acceptance: null }
      : n === 2 ? { seatUsage: [{ seat: 'brain', tokens: 1500 }] } : n === 3 ? { outcome: 'interrupted', interruption: 'signal', acceptance: null } : {} });
    const result = await authorized(ctx, host);
    assert.deepEqual([result.status, result.executed], ['interrupted', 3]);
    const { study, report } = exported(ctx);
    assert.equal(study.trials[0].observed.outcome, 'interrupted'); assert.equal(report.trials[0].budget.wallExceeded, true);
    assert.equal(report.trials[0].budget.interruption, 'wall_budget');
    assert.equal(study.trials[1].observed.outcome, 'passed'); assert.equal(report.trials[1].budget.tokensExceeded, true);
    assert.equal(study.trials[2].observed.outcome, 'interrupted'); assert.equal(study.trials[3].observed, null);
    const acceptanceMissing = setup({ repeats: 1 });
    try {
      await authorized(acceptanceMissing, fakeHost({ behave: (spec, n) => n === 1 ? { acceptance: null } : {} }));
      assert.equal(exported(acceptanceMissing).study.trials[0].observed.outcome, 'harness_failed');
    } finally { acceptanceMissing.cleanup(); }
    const untouched = setup({ repeats: 1 });
    try {
      const stopped = fakeHost();
      assert.equal((await authorized(untouched, stopped, { signal: AbortSignal.abort() })).status, 'interrupted');
      assert.equal(stopped.calls.length, 0);
    } finally { untouched.cleanup(); }
  } finally { ctx.cleanup(); }
});

test('dry-run, validate, prepare and export are credential-free and network is impossible during them', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    await assert.rejects(withoutNetwork(() => fetch('https://api.typesafe.ai/v1/systemone')), /Network is disabled/);
    await assert.rejects(withoutNetwork(async () => (await import('node:net')).connect(443, 'example.com')), /Network is disabled/);
    const preview = await main(['dry-run', '--run-dir', ctx.runDir], { env: {} });
    assert.equal(preview.paid, false); assert.equal(preview.next.length, 5);
    assert.deepEqual(preview.next.map(t => t.trialId), ctx.study.trials.map(t => t.id));
    assert.ok(preview.checks.some(c => c.name === 'checkout.revision' && !c.ok), 'a synthetic revision would be refused');
    assert.ok(preview.wouldRefuse.includes('checkout.revision'));
    assert.equal(readFileSync(path.join(ctx.runDir, 'run.json'), 'utf8').includes('apiKey'), false);
    assert.ok(!existsSync(path.join(ctx.runDir, 'trials', ctx.study.trials[0].id)), 'dry-run creates no attempt');
    const direct = await dryRun({ runDir: ctx.runDir, limit: 2 });
    assert.equal(direct.next.length, 2);
    assert.deepEqual((await main(['validate', '--run-dir', ctx.runDir])).states, { pending: 5 });
    const out = path.join(ctx.dir, 'exported.json'), rep = path.join(ctx.dir, 'report.json');
    assert.deepEqual(await main(['export', '--run-dir', ctx.runDir, '--output', out, '--report', rep]), { completed: 0, reconciled: 0, withheld: 0, pending: 5, ambiguous: 0 });
    await assert.rejects(main(['export', '--run-dir', ctx.runDir, '--output', out, '--report', path.join(ctx.dir, 'r2.json')]), /EEXIST/);
    await assert.rejects(main(['prepare', '--plan', path.join(ctx.dir, 'plan.json'), '--run-dir', ctx.runDir]), /already exists/);
    await assert.rejects(main(['bogus', '--run-dir', ctx.runDir]), /Usage/);
  } finally { ctx.cleanup(); }
});

test('validate detects trials started out of the randomized order', async () => {
  const ctx = setup({ repeats: 1 });
  try {
    const later = ctx.study.trials[2].id, journal = path.join(ctx.runDir, 'trials', later, 'journal.jsonl');
    mkdirSync(path.dirname(journal), { recursive: true });
    appendDurable(journal, { type: 'started', attempt: 1 });
    assert.throws(() => validateRun({ runDir: ctx.runDir }), /randomized order/);
  } finally { ctx.cleanup(); }
});

/** Fake host whose trials take `ms`, tracking how many run at once and in which order they start/finish. */
function slowHost({ ms = 40, behave } = {}) {
  const base = fakeHost({ behave }), events = [];
  let running = 0, peak = 0;
  return { ...base, events, peak: () => peak,
    async executeTrial(spec, signal) {
      running++; peak = Math.max(peak, running); events.push(['start', spec.trialId, spec.index]);
      const until = Date.now() + ms;
      while (Date.now() < until && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 5));
      running--; events.push(['end', spec.trialId, spec.index]);
      if (signal?.aborted) return { ...(await base.executeTrial(spec)), outcome: 'interrupted', interruption: 'signal', acceptance: null };
      return base.executeTrial(spec);
    } };
}
const lots = 64 * 1024 ** 3;
const startedRecord = (ctx, id) => readFileSync(path.join(ctx.runDir, 'trials', id, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(r => r.type === 'started');

test('--concurrency runs whole manifest blocks side by side and records the load of every trial', async () => {
  const ctx = setup({ repeats: 3 });
  try {
    const host = slowHost();
    assert.deepEqual(await authorized(ctx, host, { concurrency: 10, availableMemory: () => lots }), { status: 'complete', trialId: null, executed: 15 });
    assert.equal(host.peak(), 10, 'two blocks of five at once');
    const startIndex = host.events.filter(e => e[0] === 'start').map(e => e[2]);
    assert.deepEqual(startIndex.slice(0, 10).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'blocks start in manifest order');
    const firstEnd = host.events.findIndex(e => e[0] === 'end');
    assert.ok(host.events.findIndex(e => e[0] === 'start' && e[2] >= 10) > firstEnd, 'the third block waits for a free block slot');
    const { report } = exported(ctx);
    assert.deepEqual(report.trials.map(t => t.load.blockIndex), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    assert.ok(report.trials.every(t => t.load.concurrency === 10 && t.load.concurrentWith.length >= 4));
    assert.equal(report.concurrency.maxObserved, 10);
    assert.equal(startedRecord(ctx, ctx.study.trials[7].id).blockIndex, 1);
    validateRun({ runDir: ctx.runDir });
  } finally { ctx.cleanup(); }
  const single = setup({ repeats: 2 });
  try {
    const host = slowHost();
    await authorized(single, host, { concurrency: 7, availableMemory: () => lots });
    assert.equal(host.peak(), 5, 'a concurrency below two blocks rounds down to one block');
  } finally { single.cleanup(); }
});

test('concurrent resume continues mid-block and an ambiguous trial stops new blocks while running trials finish', async () => {
  const ctx = setup({ repeats: 3 });
  try {
    const first = await authorized(ctx, slowHost(), { concurrency: 10, maxTrials: 7, availableMemory: () => lots });
    assert.deepEqual([first.status, first.executed], ['paused', 7]);
    assert.equal(exported(ctx).report.counts.completed, 7, 'block 0 and the first two trials of block 1');
    const second = slowHost();
    assert.equal((await authorized(ctx, second, { concurrency: 10, availableMemory: () => lots })).status, 'complete');
    assert.deepEqual(second.events.filter(e => e[0] === 'start').map(e => e[2]).sort((a, b) => a - b), [7, 8, 9, 10, 11, 12, 13, 14]);
    validateRun({ runDir: ctx.runDir });
  } finally { ctx.cleanup(); }

  const amb = setup({ repeats: 3 });
  try {
    const host = slowHost({ behave: (spec) => { if (spec.index === 1) throw new Error('lost'); return {}; } });
    const result = await authorized(amb, host, { concurrency: 5, availableMemory: () => lots });
    assert.deepEqual([result.status, result.trialId, result.reason], ['ambiguous', amb.study.trials[1].id, 'host_error']);
    assert.deepEqual(host.events.filter(e => e[0] === 'start').map(e => e[2]).sort(), [0, 1, 2, 3, 4], 'no later block was scheduled');
    assert.equal(host.events.filter(e => e[0] === 'end').length, 5, 'the running block finished');
    const again = slowHost();
    const refused = await authorized(amb, again, { concurrency: 10, availableMemory: () => lots });
    assert.deepEqual([refused.status, refused.reason], ['ambiguous', 'awaiting_reconciliation']);
    assert.equal(again.events.length, 0, 'later runs refuse past it');
  } finally { amb.cleanup(); }
});

test('low available memory downgrades to one block; a Human interrupt stops every running trial', async () => {
  const ctx = setup({ repeats: 2 });
  try {
    const host = slowHost();
    await authorized(ctx, host, { concurrency: 10, availableMemory: () => 1024 ** 3, minFreeMemoryBytes: 3 * 1024 ** 3 });
    assert.equal(host.peak(), 5);
    const [downgrade] = exported(ctx).report.concurrency.downgrades;
    assert.deepEqual([downgrade.reason, downgrade.from, downgrade.to, downgrade.availableBytes], ['low_memory', 10, 5, 1024 ** 3]);
  } finally { ctx.cleanup(); }
  const stop = setup({ repeats: 3 });
  try {
    const controller = new AbortController(), host = slowHost({ ms: 5_000 });
    setTimeout(() => controller.abort(), 100);
    const result = await authorized(stop, host, { concurrency: 10, signal: controller.signal, availableMemory: () => lots });
    assert.equal(result.status, 'interrupted');
    assert.equal(host.events.filter(e => e[0] === 'start').length, 10, 'no block starts after the interrupt');
    assert.equal(exported(stop).study.trials.slice(0, 10).filter(t => t.observed?.outcome === 'interrupted').length, 10);
  } finally { stop.cleanup(); }
});
