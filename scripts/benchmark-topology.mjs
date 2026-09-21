import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUDY_VERSION = 'topology-comparison-v1';
export const CONDITIONS = ['auto', 'single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'];
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const key = /^[a-z0-9][a-z0-9._/-]{0,199}$/i;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const count = n => Number.isSafeInteger(n) && n >= 0;
function object(value, label) { assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); return value; }
function exact(value, keys, label) {
  object(value, label); assert.ok(Object.keys(value).every(k => keys.includes(k)), `${label} contains an unknown field`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function rng(seed) { let state = seed >>> 0 || 1; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
function shuffled(values, random) { const out = [...values]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }

export function prepareStudy(raw) {
  exact(raw, ['evidenceKind','versions','workloads','repeats','seed','freeWorkers','limits'], 'study config');
  assert.ok(['synthetic','live'].includes(raw.evidenceKind), 'evidenceKind must explicitly be synthetic or live');
  exact(raw.versions, ['hivemindRevision','provider','model','host','configuration','policyVersion'], 'versions');
  assert.match(raw.versions.hivemindRevision, sha, 'Pin an exact Hivemind revision');
  for (const k of ['provider','model','host','configuration','policyVersion']) assert.match(raw.versions[k], key, `Pin versions.${k}`);
  assert.equal(raw.versions.policyVersion, 'topology-policy-v2.1', 'Unsupported policy version; do not silently pool policies');
  assert.ok(Array.isArray(raw.workloads) && raw.workloads.length >= 1 && raw.workloads.length <= 10, 'Use 1..10 pinned workloads');
  assert.equal(new Set(raw.workloads.map(w => w.id)).size, raw.workloads.length, 'Duplicate workload');
  for (const w of raw.workloads) {
    exact(w, ['id','version','inputDigest','acceptanceDigest'], 'workload');
    assert.match(w.id, key); assert.match(w.version, key); assert.match(w.inputDigest, digest); assert.match(w.acceptanceDigest, digest);
  }
  const repeats = raw.repeats ?? 2, seed = raw.seed ?? 29, freeWorkers = raw.freeWorkers ?? 3;
  assert.ok(count(repeats) && repeats >= 1 && repeats <= 10, 'repeats must be 1..10');
  assert.ok(count(seed) && seed <= 0xffffffff, 'seed must be uint32');
  assert.ok(count(freeWorkers) && freeWorkers >= 2 && freeWorkers <= 254, 'All conditions require 2..254 equally available workers');
  exact(raw.limits, ['wallMs','workloadTokens'], 'limits');
  assert.ok(count(raw.limits.wallMs) && raw.limits.wallMs > 0 && count(raw.limits.workloadTokens) && raw.limits.workloadTokens > 0, 'Positive explicit budgets required');
  const config = { evidenceKind: raw.evidenceKind, versions: { ...raw.versions }, workloads: raw.workloads.map(w => ({ ...w })),
    repeats, seed, freeWorkers, limits: { ...raw.limits } };
  const studyId = hash(config), random = rng(seed), trials = [];
  const blocks = config.workloads.flatMap(w => Array.from({ length: repeats }, (_, repeat) => ({ workload: w, repeat })));
  for (const block of shuffled(blocks, random)) for (const condition of shuffled(CONDITIONS, random)) {
    const id = hash([studyId, block.workload.id, block.repeat, condition]).slice(0, 24);
    trials.push({ id, workloadId: block.workload.id, repeat: block.repeat, condition, observed: null });
  }
  return { schemaVersion: 1, studyVersion: STUDY_VERSION, studyId, config, trials };
}

function validateEvidence(e, policyVersion) {
  object(e, 'router evidence');
  assert.equal(e.schemaVersion, 1); assert.equal(e.evidenceClass, 'adaptive-evidence-v1');
  assert.equal(e.contractVersion, 'adaptive-routing-v2'); assert.equal(e.policyVersion, policyVersion);
  const c = object(e.coverage, 'coverage'), o = object(e.overhead, 'overhead');
  for (const k of ['attemptsStarted','attemptsFinished','pendingAttempts','retainedAttempts','prunedAttempts']) assert.ok(count(c[k]), `Invalid ${k}`);
  assert.ok(c.attemptsStarted > 0 && c.attemptsFinished <= c.attemptsStarted);
  assert.equal(c.pendingAttempts, c.attemptsStarted - c.attemptsFinished);
  assert.equal(c.retainedAttempts + c.prunedAttempts, c.attemptsStarted, 'Inconsistent retained evidence count');
  assert.equal(c.historyComplete, c.prunedAttempts === 0);
  assert.ok(Array.isArray(e.attempts) && e.attempts.length === c.retainedAttempts, 'Retained attempt detail must match its count');
  let previous = 0;
  for (const a of e.attempts) {
    assert.ok(count(a.ordinal) && a.ordinal > previous && a.ordinal <= c.attemptsStarted, 'Invalid attempt order');
    assert.ok(['initial','continuous'].includes(a.phase)); assert.ok(['pending','ok','unavailable'].includes(a.status));
    previous = a.ordinal;
  }
  for (const k of ['successfulAttempts','unavailableAttempts','tokenObservations','unknownUsageAttempts','knownInputTokens','knownOutputTokens','latencyObservations','knownLatencyMs']) assert.ok(count(o[k]), `Invalid overhead.${k}`);
  assert.equal(o.successfulAttempts + o.unavailableAttempts, c.attemptsFinished);
  assert.ok(o.tokenObservations <= c.attemptsFinished && o.latencyObservations <= c.attemptsFinished);
  assert.equal(o.unknownUsageAttempts, c.attemptsStarted - o.tokenObservations);
  assert.equal(c.usageComplete, o.tokenObservations === c.attemptsStarted);
  assert.equal(o.totalInputTokens, c.usageComplete ? o.knownInputTokens : null);
  assert.equal(o.totalOutputTokens, c.usageComplete ? o.knownOutputTokens : null);
  assert.equal(o.summedLatencyMs, o.latencyObservations === c.attemptsStarted ? o.knownLatencyMs : null);
  assert.ok(Array.isArray(e.models) && e.models.length <= 16 && e.models.every(m => typeof m === 'string' && key.test(m)));
  assert.equal(new Set(e.models).size, e.models.length); assert.equal(typeof e.modelsTruncated, 'boolean');
  const total = c.usageComplete ? o.totalInputTokens + o.totalOutputTokens : null;
  assert.ok(total === null || count(total), 'Router token total overflow');
  return total;
}

export function validateStudy(study, { requireComplete = false } = {}) {
  exact(study, ['schemaVersion','studyVersion','studyId','config','trials'], 'study');
  assert.equal(study.schemaVersion, 1); assert.equal(study.studyVersion, STUDY_VERSION);
  const expected = prepareStudy(study.config);
  assert.equal(study.studyId, expected.studyId, 'Study configuration changed');
  assert.ok(Array.isArray(study.trials) && study.trials.length === expected.trials.length, 'Missing or extra trials');
  let completed = 0; const modelVersions = new Set();
  for (let i = 0; i < study.trials.length; i++) {
    const trial = study.trials[i], wanted = expected.trials[i];
    exact(trial, ['id','workloadId','repeat','condition','observed'], 'trial');
    for (const k of ['id','workloadId','repeat','condition']) assert.equal(trial[k], wanted[k], 'Trial identity/order changed or duplicate trial');
    if (trial.observed === null) { assert.ok(!requireComplete, 'Pending trial: no empirical summary'); continue; }
    const o = trial.observed;
    exact(o, ['evidenceKind','versions','freeWorkers','jevEnabled','outcome','independentlyReviewed','instrumentationHealthy',
      'wallMs','workloadTokens','workloadUsageSource','defects','routerEvidence','routingReview','evidenceRef','initialTopology','routingOverrides'], 'observation');
    assert.equal(o.evidenceKind, study.config.evidenceKind, 'Do not mix live and synthetic trials');
    assert.deepEqual(o.versions, study.config.versions, 'Incompatible version cohort');
    assert.equal(o.freeWorkers, study.config.freeWorkers, 'Incompatible initial capacity');
    assert.ok(CONDITIONS.slice(1).includes(o.initialTopology), 'Record the actual initial topology');
    assert.equal(o.routingOverrides, 0, 'Unplanned routing overrides require a separate experimental condition');
    if (trial.condition !== 'auto') assert.equal(o.initialTopology, trial.condition, 'Fixed topology was not applied');
    assert.equal(o.jevEnabled, trial.condition === 'auto', 'Fixed baseline must have Jev disabled; manual locks with monitoring are different conditions');
    assert.ok(['passed','quality_failed','harness_failed','interrupted'].includes(o.outcome));
    assert.equal(typeof o.independentlyReviewed, 'boolean'); assert.equal(typeof o.instrumentationHealthy, 'boolean');
    assert.ok(o.wallMs === null || finite(o.wallMs)); assert.ok(o.workloadTokens === null || count(o.workloadTokens));
    assert.ok(['provider_reported','unknown'].includes(o.workloadUsageSource));
    assert.equal(o.workloadTokens === null, o.workloadUsageSource === 'unknown', 'Unknown usage must remain null');
    assert.ok(o.defects === null || count(o.defects));
    assert.match(o.evidenceRef, /^[a-z0-9][a-z0-9._/-]{0,199}$/i, 'Use a redacted local artifact reference, not a credential-bearing URL');
    assert.ok(!o.evidenceRef.split('/').includes('..'), 'No parent traversal in evidenceRef');
    if (['passed','quality_failed'].includes(o.outcome)) {
      if (requireComplete) assert.equal(o.independentlyReviewed, true, 'Quality outcomes require independent review');
      assert.ok(o.wallMs !== null && o.defects !== null, 'Reviewed quality needs wall time and defect count');
    }
    if (trial.condition === 'auto') {
      if (o.routerEvidence === null) assert.equal(o.instrumentationHealthy, false, 'Missing router evidence is not zero overhead');
      else { validateEvidence(o.routerEvidence, study.config.versions.policyVersion); for (const m of o.routerEvidence.models) modelVersions.add(m); }
    } else assert.equal(o.routerEvidence, null, 'A clean fixed baseline does not call Jev');
    if (o.routingReview !== null) {
      exact(o.routingReview, ['underOrchestration','prematureDowngrade','flapping'], 'routingReview');
      for (const k of Object.keys(o.routingReview)) assert.ok(o.routingReview[k] === null || typeof o.routingReview[k] === 'boolean');
    }
    completed++;
  }
  assert.ok(modelVersions.size <= 1, 'Resolved Jev models differ; split the cohort instead of pooling versions');
  return { expected: study.trials.length, completed, pending: study.trials.length - completed, resolvedModels: [...modelVersions] };
}

function metric(values) {
  if (!values.length) return { observations: 0, mean: null, median: null, min: null, max: null, bootstrap95: null };
  const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / values.length;
  let bootstrap95 = null;
  if (values.length >= 2) {
    const random = rng(29), samples = [];
    for (let i = 0; i < 2000; i++) samples.push(values.reduce(sum => sum + values[Math.floor(random() * values.length)], 0) / values.length);
    samples.sort((a, b) => a - b); bootstrap95 = [samples[49], samples[1949]];
  }
  const mid = Math.floor(sorted.length / 2), median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { observations: values.length, mean, median, min: sorted[0], max: sorted.at(-1), bootstrap95 };
}
function tokens(trial) {
  const o = trial.observed;
  if (!o.instrumentationHealthy || o.workloadTokens === null) return null;
  const router = trial.condition === 'auto' ? o.routerEvidence && !o.routerEvidence.modelsTruncated && o.routerEvidence.models.length === 1 &&
    o.routerEvidence.coverage.historyComplete && o.routerEvidence.attempts[0]?.ordinal === 1 && o.routerEvidence.attempts[0]?.phase === 'initial'
    ? validateEvidence(o.routerEvidence, o.versions.policyVersion) : null : 0;
  if (router === null) return null;
  const total = o.workloadTokens + router;
  assert.ok(count(total), 'End-to-end token total overflow'); return total;
}
function reviewedLabel(trials, field) {
  const values = trials.map(t => t.observed.routingReview?.[field]);
  const known = values.filter(v => typeof v === 'boolean');
  return { reviewed: known.length, flagged: known.filter(Boolean).length, unknown: trials.length - known.length };
}

export function summarizeStudy(study) {
  const coverage = validateStudy(study, { requireComplete: true });
  const auto = study.trials.filter(t => t.condition === 'auto');
  const comparison = CONDITIONS.filter(c => c !== 'auto').map(condition => {
    const pairs = auto.map(a => {
      const b = study.trials.find(t => t.condition === condition && t.workloadId === a.workloadId && t.repeat === a.repeat);
      const eligible = [a, b].every(t => ['passed','quality_failed'].includes(t.observed.outcome));
      const bothPassed = eligible && a.observed.outcome === 'passed' && b.observed.outcome === 'passed';
      const at = tokens(a), bt = tokens(b);
      return { workloadId: a.workloadId, repeat: a.repeat, autoOutcome: a.observed.outcome, baselineOutcome: b.observed.outcome,
        qualityComparable: eligible, bothPassed, autoDefects: a.observed.defects, baselineDefects: b.observed.defects,
        deltaDefects: eligible ? a.observed.defects - b.observed.defects : null,
        qualityRegression: eligible && a.observed.outcome !== 'passed' && b.observed.outcome === 'passed',
        qualityImprovement: eligible && a.observed.outcome === 'passed' && b.observed.outcome !== 'passed',
        deltaWallMs: bothPassed && a.observed.instrumentationHealthy && b.observed.instrumentationHealthy ? a.observed.wallMs - b.observed.wallMs : null,
        deltaNetTokens: bothPassed && at !== null && bt !== null ? at - bt : null };
    });
    return { condition, matchedPairs: pairs.length, qualityComparablePairs: pairs.filter(p => p.qualityComparable).length,
      excludedHarnessOrInterruptedPairs: pairs.filter(p => !p.qualityComparable).length,
      qualityRegressions: pairs.filter(p => p.qualityRegression).length, qualityImprovements: pairs.filter(p => p.qualityImprovement).length,
      bothPassed: pairs.filter(p => p.bothPassed).length,
      deltaDefects: metric(pairs.map(p => p.deltaDefects).filter(n => n !== null)),
      deltaWallMs: metric(pairs.map(p => p.deltaWallMs).filter(n => n !== null)),
      deltaNetTokens: metric(pairs.map(p => p.deltaNetTokens).filter(n => n !== null)), pairs };
  });
  return { schemaVersion: 1, evidenceClass: study.config.evidenceKind === 'live' ? 'live_topology_comparison' : 'synthetic_topology_comparison',
    studyId: study.studyId, studyVersion: STUDY_VERSION, coverage, versions: study.config.versions,
    deltaConvention: 'auto_minus_fixed; negative is lower consumption/time, not a quality-adjusted universal winner',
    outcomes: Object.fromEntries(CONDITIONS.map(c => [c, Object.fromEntries(['passed','quality_failed','harness_failed','interrupted'].map(outcome =>
      [outcome, study.trials.filter(t => t.condition === c && t.observed.outcome === outcome).length]))])),
    routerReview: { underOrchestration: reviewedLabel(auto, 'underOrchestration'), prematureDowngrade: reviewedLabel(auto, 'prematureDowngrade'), flapping: reviewedLabel(auto, 'flapping') },
    budgetExceeded: Object.fromEntries(CONDITIONS.map(c => [c, study.trials.filter(t => t.condition === c &&
      ((t.observed.wallMs !== null && t.observed.wallMs > study.config.limits.wallMs) ||
        (t.observed.workloadTokens !== null && t.observed.workloadTokens > study.config.limits.workloadTokens))).length])),
    comparison, monetaryCost: null,
    limitations: ['Fixture/synthetic output is not empirical validation.', 'Negative token deltas require complete observed workload/router usage and an unpruned capture starting with the initial attempt.',
      'End-to-end wall time already includes router waits; summed router latency is not added again.',
      'Only jointly acceptance-passing reviewed pairs enter efficiency deltas. Independent defect deltas, quality regressions and failed/interrupted runs remain explicit; efficiency is not automatically quality-adjusted.',
      'Bootstrap intervals resample the retained matched pairs; small samples and workload selection limit generalization.',
      'Routing mistake labels are independent reviewer inputs, not inferred from a recommendation or a mode switch.'] };
}

function readJson(file) {
  const max = 8 * 1024 * 1024, fd = openSync(file, 'r'), buffer = Buffer.alloc(max + 1);
  let bytes = 0;
  try { while (bytes <= max) { const n = readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!n) break; bytes += n; } }
  finally { closeSync(fd); }
  assert.ok(bytes <= max, 'Study file exceeds 8 MiB');
  return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
}
export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv, options = {};
  assert.ok(['prepare','validate','summarize'].includes(command), 'Use prepare, validate or summarize');
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--input','--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !options[args[i]], 'Use --input <JSON> --output <new JSON>');
    options[args[i]] = args[i + 1];
  }
  assert.ok(options['--input'], '--input required');
  const input = readJson(options['--input']);
  const output = command === 'prepare' ? prepareStudy(input) : command === 'validate' ? validateStudy(input) : summarizeStudy(input);
  if (options['--output']) {
    const fd = openSync(options['--output'], 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(output, null, 2) + '\n'); } finally { closeSync(fd); }
  } else assert.equal(command, 'validate', '--output is required for prepare/summarize');
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = main(); if (process.argv[2] === 'validate') console.log(JSON.stringify(result)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Study failed'); process.exitCode = 1; }
}
