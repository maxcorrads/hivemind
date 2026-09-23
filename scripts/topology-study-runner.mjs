// Execution adapter between the immutable #132 topology-comparison manifest and an isolated host (#136).
//
// prepare / validate / dry-run / reconcile / export are credential-free and never reach the network.
// `run` is the only paid path: it requires an explicit per-study authorization and loads the live host lazily.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDITIONS, readJson, validateEvidence, validateStudy } from './benchmark-topology.mjs';
import { TOPOLOGY_POLICY_VERSION } from '../src/shared/adaptive-topology-policy.ts';
import { TYPESAFE_MODEL } from '../src/server/adaptive-config.ts';
import { validJevModel } from '../src/shared/jev-model.ts';

export const RUNNER_VERSION = 'topology-study-runner-v1';
export const REPORT_VERSION = 'topology-study-run-report-v1';
export const OUTCOMES = ['passed', 'quality_failed', 'harness_failed', 'interrupted'];
const FIXED_TOPOLOGIES = CONDITIONS.slice(1);
const TERMINAL = new Set(['completed', 'reconciled']);
export const EXCLUSIONS = ['jev_toggle_drift', 'monitored_fixed_baseline', 'capacity_mismatch', 'topology_not_applied',
  'initial_topology_unknown', 'unplanned_override', 'workload_model_drift', 'jev_requested_model_drift',
  'jev_resolved_model_drift', 'policy_version_drift'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = n => Number.isSafeInteger(n) && n >= 0;
const modelKey = /^[a-z0-9][a-z0-9._/:-]{0,199}$/i;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const workloadDir = id => sha256(id).slice(0, 16);
const attemptName = n => `attempt-${String(n).padStart(3, '0')}`;
const trialRef = (trialId, attempt) => `trials/${trialId}/${attemptName(attempt)}`;

function writeExclusive(file, content, mode = 0o600) {
  const fd = openSync(file, 'wx', mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* directory fsync is best effort on some platforms */ } finally { if (fd !== undefined) closeSync(fd); }
}
/** Durable append: each checkpoint is one JSON line flushed to disk before the runner continues. */
export function appendDurable(file, record) {
  const created = !existsSync(file);
  const fd = openSync(file, 'a+', 0o600);
  try {
    const size = fstatSync(fd).size, last = Buffer.alloc(1);
    // A crash can leave a torn final line: terminate it and record the repair, so later readers can tell it apart from corruption.
    if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a)
      writeFileSync(fd, '\n' + JSON.stringify({ type: 'torn_tail_repaired', at: Date.now() }) + '\n');
    writeFileSync(fd, JSON.stringify({ ...record, at: record.at ?? Date.now() }) + '\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  if (created) fsyncDir(path.dirname(file));
}
/** A torn final line (crash mid-append) is ignored, so a lost `completed` leaves the attempt open and therefore ambiguous. */
export function readJournal(file) {
  if (!existsSync(file)) return { records: [], torn: false };
  const lines = readFileSync(file, 'utf8').split('\n'), records = [];
  let torn = false;
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch {
      const repaired = lines[i + 1] !== undefined && lines[i + 1].includes('"type":"torn_tail_repaired"');
      assert.ok(i === lines.length - 1 || repaired, 'Corrupted checkpoint journal (not a torn tail)');
      torn = true;
    }
  }
  return { records, torn };
}
const redact = (text, secrets = []) => {
  let out = String(text ?? '').slice(0, 500).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
};

// ---------------------------------------------------------------- prepare / load

function planObject(raw) {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'Run plan must be an object');
  assert.ok(Object.keys(raw).every(k => ['schemaVersion', 'manifest', 'workloads', 'host', 'jev'].includes(k)), 'Run plan contains an unknown field');
  assert.equal(raw.schemaVersion, 1, 'Unsupported run plan schemaVersion');
  assert.equal(typeof raw.manifest, 'string', 'plan.manifest must be the prepared #132 study path');
  assert.ok(Array.isArray(raw.workloads), 'plan.workloads must list input/acceptance files');
  const host = raw.host;
  assert.ok(host && typeof host === 'object' && Object.keys(host).every(k => ['name', 'binaryVersion'].includes(k)), 'plan.host must be { name, binaryVersion }');
  assert.ok(['opencode'].includes(host.name), 'Only the opencode seat host is wired for live runs');
  assert.match(String(host.binaryVersion), /^[a-z0-9][a-z0-9._-]{0,63}$/i, 'Pin plan.host.binaryVersion');
  const jev = raw.jev;
  assert.ok(jev && typeof jev === 'object' && Object.keys(jev).every(k => ['expectedResolvedModel'].includes(k)), 'plan.jev must be { expectedResolvedModel }');
  assert.ok(jev.expectedResolvedModel === null || modelKey.test(String(jev.expectedResolvedModel)), 'plan.jev.expectedResolvedModel must be null or an identifier');
  return raw;
}

/** Copies the manifest and workload artifacts into a fresh run directory after verifying their exact bytes. */
export function prepareRun({ planPath, runDir }) {
  const planFile = path.resolve(planPath), base = path.dirname(planFile);
  const plan = planObject(readJson(planFile));
  const manifestFile = path.resolve(base, plan.manifest);
  const manifestBytes = readFileSync(manifestFile);
  const study = JSON.parse(manifestBytes.toString('utf8'));
  const coverage = validateStudy(study);
  assert.equal(coverage.completed, 0, 'The runner consumes a freshly prepared manifest with only pending trials');
  const byId = new Map(plan.workloads.map(w => [w.id, w]));
  assert.equal(byId.size, plan.workloads.length, 'Duplicate plan workload');
  assert.equal(byId.size, study.config.workloads.length, 'Plan must provide exactly the manifest workloads');
  const dir = path.resolve(runDir);
  assert.ok(!existsSync(dir), 'Run directory already exists; choose a new path to retain previous evidence');
  const workloads = {};
  const copies = [];
  for (const w of study.config.workloads) {
    const entry = byId.get(w.id);
    assert.ok(entry && Object.keys(entry).every(k => ['id', 'input', 'acceptance'].includes(k)), `Plan is missing workload ${w.id}`);
    const input = path.resolve(base, entry.input), acceptance = path.resolve(base, entry.acceptance);
    assert.equal(sha256(readFileSync(input)), w.inputDigest, `Input artifact hash mismatch for ${w.id}`);
    assert.equal(sha256(readFileSync(acceptance)), w.acceptanceDigest, `Acceptance artifact hash mismatch for ${w.id}`);
    workloads[w.id] = { dir: workloadDir(w.id), inputSha256: w.inputDigest, acceptanceSha256: w.acceptanceDigest };
    copies.push([input, acceptance, workloadDir(w.id)]);
  }
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  for (const sub of ['workloads', 'trials']) mkdirSync(path.join(dir, sub), { mode: 0o700 });
  writeExclusive(path.join(dir, 'manifest.json'), manifestBytes, 0o400);
  for (const [input, acceptance, sub] of copies) {
    mkdirSync(path.join(dir, 'workloads', sub), { mode: 0o700 });
    copyFileSync(input, path.join(dir, 'workloads', sub, 'input'));
    copyFileSync(acceptance, path.join(dir, 'workloads', sub, 'acceptance'));
  }
  const run = { schemaVersion: 1, runnerVersion: RUNNER_VERSION, studyId: study.studyId, studyVersion: study.studyVersion,
    manifestSha256: sha256(manifestBytes), evidenceKind: study.config.evidenceKind,
    host: { ...plan.host }, workloads,
    // The requested Jev identifier comes from the manifest (#134 versions.jevModel); older studies used the default alias.
    jev: { requestedModel: study.config.versions.jevModel ?? TYPESAFE_MODEL, pinned: study.config.versions.jevModel !== undefined,
      expectedResolvedModel: plan.jev.expectedResolvedModel } };
  writeExclusive(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n', 0o400);
  fsyncDir(dir);
  return { runDir: dir, studyId: run.studyId, trials: study.trials.length };
}

/** Loads a run directory; fails closed if the runner version, manifest bytes or study identity changed. */
export function loadRun(runDir) {
  const dir = path.resolve(runDir);
  const run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));
  assert.equal(run.schemaVersion, 1, 'Unsupported run directory schemaVersion');
  assert.equal(run.runnerVersion, RUNNER_VERSION, `Run directory was created by ${run.runnerVersion}; do not mix runner versions`);
  const manifestBytes = readFileSync(path.join(dir, 'manifest.json'));
  assert.equal(sha256(manifestBytes), run.manifestSha256, 'Manifest bytes changed since prepare');
  const study = JSON.parse(manifestBytes.toString('utf8'));
  validateStudy(study);
  assert.equal(study.studyId, run.studyId, 'Manifest study identity changed');
  assert.ok(study.trials.every(t => t.observed === null), 'The retained manifest must stay pending; observations live in checkpoints');
  return { dir, run, study };
}

/** Re-hashes the retained workload artifacts. Called before every trial. */
export function verifyArtifacts(ctx, workloadId) {
  const w = ctx.run.workloads[workloadId], pinned = ctx.study.config.workloads.find(x => x.id === workloadId);
  assert.ok(w && pinned, `Unknown workload ${workloadId}`);
  const input = path.join(ctx.dir, 'workloads', w.dir, 'input'), acceptance = path.join(ctx.dir, 'workloads', w.dir, 'acceptance');
  const drift = [];
  if (sha256(readFileSync(input)) !== pinned.inputDigest) drift.push({ field: 'workload.input', expected: pinned.inputDigest });
  if (sha256(readFileSync(acceptance)) !== pinned.acceptanceDigest) drift.push({ field: 'workload.acceptance', expected: pinned.acceptanceDigest });
  return { input, acceptance, drift };
}

// ---------------------------------------------------------------- checkpoints

const journalFile = (ctx, trialId) => path.join(ctx.dir, 'trials', trialId, 'journal.jsonl');
const cohortFile = ctx => path.join(ctx.dir, 'cohort.jsonl');

export function trialState(ctx, trialId) {
  const { records, torn } = readJournal(journalFile(ctx, trialId));
  let open = null, state = 'pending', attempts = 0, completed = null, reconciled = null;
  const aborted = [], drift = [], ambiguous = [];
  for (const r of records) {
    if (r.type === 'started') { attempts = Math.max(attempts, r.attempt); open = r.attempt; }
    else if (r.type === 'preflight_drift') drift.push(r);
    else if (r.type === 'aborted_before_request') { aborted.push(r); if (open === r.attempt) open = null; }
    else if (r.type === 'ambiguous') { ambiguous.push(r); if (open === r.attempt) open = null; state = 'ambiguous'; }
    else if (r.type === 'completed') { completed = r; if (open === r.attempt) open = null; state = 'completed'; }
    else if (r.type === 'reconciled') { reconciled = r; state = 'reconciled'; }
  }
  if (!['completed', 'reconciled'].includes(state) && open !== null) state = 'started_unresolved';
  return { state, attempts, open, completed, reconciled, aborted, drift, ambiguous, torn };
}

function cohortPin(ctx) {
  const { records } = readJournal(cohortFile(ctx));
  return records.find(r => r.type === 'jev_resolved_model_pinned')?.model ?? ctx.run.jev.expectedResolvedModel ?? null;
}

// ---------------------------------------------------------------- host result -> observation

const RESULT_KEYS = ['phase', 'reason', 'drift', 'detail', 'observedFreeWorkers', 'jevEnabled', 'jevRequestedModel', 'jevAttempts',
  'initialTopology', 'routingOverrides', 'outcome', 'interruption', 'wallMs', 'seatUsage', 'resolvedWorkloadModels',
  'acceptance', 'routerEvidence', 'collectorWarnings', 'artifacts'];

/** Strict shape check. A result that fails this is treated as ambiguous, never guessed into an observation. */
export function validateHostResult(r) {
  assert.ok(r && typeof r === 'object' && !Array.isArray(r), 'Host result must be an object');
  assert.ok(Object.keys(r).every(k => RESULT_KEYS.includes(k)), 'Host result contains an unknown field');
  assert.ok(['completed', 'aborted_before_request', 'ambiguous'].includes(r.phase), 'Unknown host result phase');
  if (r.phase !== 'completed') { assert.equal(typeof r.reason, 'string', 'Aborted/ambiguous results need a reason code'); return r; }
  assert.ok(r.observedFreeWorkers === null || count(r.observedFreeWorkers));
  assert.equal(typeof r.jevEnabled, 'boolean'); assert.ok(r.jevRequestedModel === null || typeof r.jevRequestedModel === 'string');
  assert.ok(count(r.jevAttempts)); assert.ok(r.initialTopology === null || FIXED_TOPOLOGIES.includes(r.initialTopology));
  assert.ok(count(r.routingOverrides)); assert.ok(OUTCOMES.includes(r.outcome));
  assert.ok([null, 'wall_budget', 'token_budget', 'signal'].includes(r.interruption));
  assert.ok(r.interruption === null || r.outcome === 'interrupted', 'An interruption must be recorded as an interrupted outcome');
  assert.ok(r.wallMs === null || (Number.isFinite(r.wallMs) && r.wallMs >= 0));
  assert.ok(Array.isArray(r.seatUsage) && r.seatUsage.length >= 1, 'Report usage for every launched seat');
  for (const s of r.seatUsage) assert.ok(typeof s.seat === 'string' && (s.tokens === null || count(s.tokens)));
  assert.ok(r.resolvedWorkloadModels === null || (Array.isArray(r.resolvedWorkloadModels) && r.resolvedWorkloadModels.every(m => typeof m === 'string')));
  assert.ok(r.acceptance === null || (typeof r.acceptance.passed === 'boolean' && count(r.acceptance.defects)));
  assert.ok(r.routerEvidence === null || typeof r.routerEvidence === 'object');
  assert.ok(count(r.collectorWarnings));
  assert.ok(Array.isArray(r.artifacts) && r.artifacts.every(a => typeof a === 'string' && !path.isAbsolute(a) && !a.split('/').includes('..')), 'Artifacts must be relative local references');
  return r;
}

/**
 * Maps a completed host result to a #132 observation. Nothing is inferred: automated runs are never marked reviewed,
 * routing diagnoses stay null, unknown usage stays null and router latency is never added to wall time.
 * Configuration drift yields exclusions: the attempt is retained but its observation is withheld from the cohort.
 */
export function observationFrom({ study, trial, result, attempt, pin, run }) {
  const config = study.config, auto = trial.condition === 'auto', exclusions = [], notes = [];
  if (result.jevEnabled !== auto) exclusions.push('jev_toggle_drift');
  if (!auto && (result.jevAttempts > 0 || result.routerEvidence !== null)) exclusions.push('monitored_fixed_baseline');
  if (result.observedFreeWorkers !== config.freeWorkers) exclusions.push('capacity_mismatch');
  if (result.initialTopology === null) exclusions.push('initial_topology_unknown');
  else if (!auto && result.initialTopology !== trial.condition) exclusions.push('topology_not_applied');
  if (result.routingOverrides !== 0) exclusions.push('unplanned_override');
  if (result.resolvedWorkloadModels !== null && result.resolvedWorkloadModels.some(m => m !== config.versions.model)) exclusions.push('workload_model_drift');
  if (result.resolvedWorkloadModels === null) notes.push('workload_model_resolution_unverified');
  const requestedInEvidence = auto ? result.routerEvidence?.requestedModels ?? null : null;
  if (auto && (result.jevRequestedModel !== run.jev.requestedModel ||
    (requestedInEvidence !== null && (result.routerEvidence.requestedModelsTruncated || requestedInEvidence.some(m => m !== run.jev.requestedModel)))))
    exclusions.push('jev_requested_model_drift');
  let routerEvidence = auto ? result.routerEvidence : null, evidenceValid = false, newPin = null;
  if (auto && routerEvidence) {
    if (routerEvidence.policyVersion !== config.versions.policyVersion) exclusions.push('policy_version_drift');
    else {
      try { validateEvidence(routerEvidence, config.versions.policyVersion); evidenceValid = true; }
      catch { notes.push('router_evidence_invalid'); routerEvidence = null; }
    }
    if (evidenceValid) {
      const models = routerEvidence.models;
      if (models.length > 1 || routerEvidence.modelsTruncated) exclusions.push('jev_resolved_model_drift');
      else if (models.length === 1) {
        if (pin === null) newPin = models[0];
        else if (models[0] !== pin) exclusions.push('jev_resolved_model_drift');
      }
    }
  }
  if (auto && !evidenceValid) routerEvidence = null;
  let outcome = result.outcome;
  if (['passed', 'quality_failed'].includes(outcome)) {
    if (result.acceptance === null || result.wallMs === null) { outcome = 'harness_failed'; notes.push('acceptance_or_wall_time_unavailable'); }
    else if ((outcome === 'passed') !== result.acceptance.passed) { outcome = 'harness_failed'; notes.push('acceptance_outcome_mismatch'); }
  }
  const known = result.seatUsage.every(s => s.tokens !== null);
  const workloadTokens = known ? result.seatUsage.reduce((sum, s) => sum + s.tokens, 0) : null;
  assert.ok(workloadTokens === null || count(workloadTokens), 'Workload token total overflow');
  // TODO(#135): when the collector's capture-completeness export lands on main, require it explicitly (and cover it in
  // tests). Until then health is inferred from sanitized server warnings, pending attempts and history completeness; an
  // export that already states a non-complete `coverage.capture` is honoured.
  const capture = auto && evidenceValid ? routerEvidence.coverage.capture : undefined;
  const collectorHealthy = auto ? evidenceValid && routerEvidence.coverage.pendingAttempts === 0 && routerEvidence.coverage.historyComplete &&
    (capture === undefined || capture === 'complete') : result.jevAttempts === 0;
  const instrumentationHealthy = known && result.wallMs !== null && result.collectorWarnings === 0 && collectorHealthy;
  if (result.collectorWarnings > 0) notes.push('collector_warnings');
  const observation = {
    evidenceKind: config.evidenceKind, versions: { ...config.versions }, freeWorkers: config.freeWorkers,
    jevEnabled: auto, initialTopology: result.initialTopology ?? (auto ? null : trial.condition), routingOverrides: 0,
    outcome, independentlyReviewed: false, instrumentationHealthy,
    wallMs: result.wallMs, workloadTokens, workloadUsageSource: known ? 'provider_reported' : 'unknown',
    defects: result.acceptance ? result.acceptance.defects : null,
    routerEvidence, routingReview: null, evidenceRef: trialRef(trial.id, attempt),
  };
  const budget = {
    wallExceeded: result.wallMs !== null && result.wallMs > config.limits.wallMs,
    tokensExceeded: workloadTokens !== null && workloadTokens > config.limits.workloadTokens,
    interruption: result.interruption,
  };
  return { observation: exclusions.length ? null : observation, withheld: exclusions.length ? observation : null,
    exclusions, notes, budget, newPin };
}

// ---------------------------------------------------------------- run

function preflightDrift(ctx, trial, pre) {
  const v = ctx.study.config.versions, drift = [];
  const check = (field, expected, actual) => { if (expected !== actual) drift.push({ field, expected, actual: actual ?? null }); };
  check('checkout.revision', v.hivemindRevision, pre.checkout?.revision);
  check('checkout.clean', true, pre.checkout?.clean);
  for (const k of ['provider', 'model', 'host', 'configuration', 'policyVersion']) check(`versions.${k}`, v[k], pre.versions?.[k]);
  if (trial.condition === 'auto') {
    check('jev.requestedModel', ctx.run.jev.requestedModel, pre.jevRequestedModel);
    check('credentials.jev', true, pre.credentials?.jev);
  }
  return drift;
}

function specFor(ctx, trial, index, attempt, artifacts) {
  const attemptDir = path.join(ctx.dir, 'trials', trial.id, attemptName(attempt));
  const auto = trial.condition === 'auto';
  return { trialId: trial.id, index, condition: trial.condition, workloadId: trial.workloadId, repeat: trial.repeat, attempt,
    attemptDir, home: path.join(attemptDir, 'home'), workspace: path.join(attemptDir, 'workspace'),
    routing: auto ? 'auto' : trial.condition, lockScope: auto ? 'none' : 'task', jevEnabled: auto,
    jevRequestedModel: ctx.run.jev.requestedModel, freeWorkers: ctx.study.config.freeWorkers,
    limits: { ...ctx.study.config.limits }, versions: { ...ctx.study.config.versions },
    inputPath: artifacts.input, acceptancePath: artifacts.acceptance };
}

/**
 * Executes pending trials strictly in manifest order. Stops (never skips ahead) on preflight drift, an ambiguous
 * result, configuration drift, an aborted attempt or a Human interruption, so a later invocation resumes from the
 * durable checkpoints without silently re-running or substituting a trial.
 */
export async function runStudy({ runDir, host, authorization, maxTrials = Infinity, signal, secrets = [] }) {
  const ctx = loadRun(runDir);
  assert.equal(authorization, ctx.run.studyId, 'Paid execution requires --authorize-paid-run <studyId> for exactly this study');
  assert.equal(host?.evidenceKind, ctx.study.config.evidenceKind, 'Host evidence kind does not match the manifest; do not label fake or live runs otherwise');
  let executed = 0;
  const halt = (status, trial, detail = {}) => ({ status, trialId: trial?.id ?? null, executed, ...detail });
  for (const [index, trial] of ctx.study.trials.entries()) {
    const journal = journalFile(ctx, trial.id);
    const state = trialState(ctx, trial.id);
    if (TERMINAL.has(state.state)) continue;
    if (state.state === 'started_unresolved') {
      appendDurable(journal, { type: 'ambiguous', attempt: state.open, reason: 'runner_stopped_without_result' });
      return halt('ambiguous', trial, { reason: 'runner_stopped_without_result' });
    }
    if (state.state === 'ambiguous') return halt('ambiguous', trial, { reason: 'awaiting_reconciliation' });
    if (executed >= maxTrials) return halt('paused', trial);
    if (signal?.aborted) return halt('interrupted', trial);
    mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
    loadRun(runDir); // manifest bytes and identity are re-verified before every trial
    const artifacts = verifyArtifacts(ctx, trial.workloadId);
    const pre = await host.preflight({ condition: trial.condition, trialId: trial.id, versions: { ...ctx.study.config.versions } });
    const drift = [...artifacts.drift, ...preflightDrift(ctx, trial, pre)];
    if (drift.length) {
      appendDurable(journal, { type: 'preflight_drift', drift });
      return halt('preflight_drift', trial, { drift });
    }
    const attempt = state.attempts + 1, spec = specFor(ctx, trial, index, attempt, artifacts);
    mkdirSync(spec.attemptDir, { mode: 0o700 }); // throws if it exists: every attempt is fresh
    mkdirSync(spec.home, { mode: 0o700 }); mkdirSync(spec.workspace, { mode: 0o700 });
    appendDurable(journal, { type: 'started', attempt, condition: trial.condition, routing: spec.routing, lockScope: spec.lockScope,
      jevEnabled: spec.jevEnabled, freeWorkers: spec.freeWorkers });
    let result;
    try { result = validateHostResult(await host.executeTrial(spec, signal)); }
    catch (error) {
      appendDurable(journal, { type: 'ambiguous', attempt, reason: 'host_error', detail: redact(error?.message, secrets) });
      return halt('ambiguous', trial, { reason: 'host_error' });
    }
    if (result.phase === 'ambiguous') {
      appendDurable(journal, { type: 'ambiguous', attempt, reason: result.reason });
      return halt('ambiguous', trial, { reason: result.reason });
    }
    if (result.phase === 'aborted_before_request') {
      appendDurable(journal, { type: 'aborted_before_request', attempt, reason: result.reason, drift: result.drift ?? [],
        detail: result.detail ? redact(result.detail, secrets) : null });
      return halt('aborted_before_request', trial, { reason: result.reason });
    }
    const mapped = observationFrom({ study: ctx.study, trial, result, attempt, pin: cohortPin(ctx), run: ctx.run });
    appendDurable(journal, { type: 'completed', attempt, observation: mapped.observation, withheld: mapped.withheld,
      exclusions: mapped.exclusions, notes: mapped.notes, budget: mapped.budget, artifacts: result.artifacts,
      jevAttempts: result.jevAttempts, seatUsage: result.seatUsage });
    if (mapped.newPin && !mapped.exclusions.length) appendDurable(cohortFile(ctx), { type: 'jev_resolved_model_pinned', model: mapped.newPin, trialId: trial.id });
    executed++;
    if (mapped.exclusions.length) return halt('configuration_drift', trial, { exclusions: mapped.exclusions });
    if (result.interruption === 'signal') return halt('interrupted', trial);
  }
  return { status: 'complete', trialId: null, executed };
}

// ---------------------------------------------------------------- reconcile / export / validate / dry-run

/** Human resolution of an ambiguous attempt. The raw attempt stays retained; nothing is re-run or substituted. */
export function reconcileTrial({ runDir, trialId, resolution, initialTopology = null, note = '' }) {
  const ctx = loadRun(runDir);
  const trial = ctx.study.trials.find(t => t.id === trialId);
  assert.ok(trial, 'Unknown trial');
  const state = trialState(ctx, trialId);
  assert.ok(['ambiguous', 'started_unresolved'].includes(state.state), 'Only an ambiguous attempt can be reconciled');
  assert.ok(['interrupted', 'harness_failed'].includes(resolution), 'Resolve as interrupted or harness_failed; recovered results are reviewed separately, never substituted');
  const topology = trial.condition === 'auto' ? initialTopology : trial.condition;
  assert.ok(FIXED_TOPOLOGIES.includes(topology), 'Auto reconciliation requires --initial-topology from the retained attempt');
  const attempt = state.open ?? state.ambiguous.at(-1)?.attempt;
  const config = ctx.study.config;
  const observation = { evidenceKind: config.evidenceKind, versions: { ...config.versions }, freeWorkers: config.freeWorkers,
    jevEnabled: trial.condition === 'auto', initialTopology: topology, routingOverrides: 0, outcome: resolution,
    independentlyReviewed: false, instrumentationHealthy: false, wallMs: null, workloadTokens: null, workloadUsageSource: 'unknown',
    defects: null, routerEvidence: null, routingReview: null, evidenceRef: trialRef(trialId, attempt) };
  appendDurable(journalFile(ctx, trialId), { type: 'reconciled', attempt, resolution, observation, note: redact(note) });
  return { trialId, resolution };
}

export function exportRun({ runDir }) {
  const ctx = loadRun(runDir);
  const study = structuredClone(ctx.study), trials = [];
  const counts = { completed: 0, reconciled: 0, withheld: 0, pending: 0, ambiguous: 0 };
  for (const [index, trial] of study.trials.entries()) {
    const s = trialState(ctx, trial.id), record = s.reconciled ?? s.completed;
    trial.observed = s.state === 'reconciled' ? s.reconciled.observation : s.state === 'completed' ? s.completed.observation : null;
    if (s.state === 'completed' && !s.completed.observation) counts.withheld++;
    else if (TERMINAL.has(s.state)) counts[s.state]++;
    else if (['ambiguous', 'started_unresolved'].includes(s.state)) counts.ambiguous++;
    else counts.pending++;
    trials.push({ id: trial.id, index, condition: trial.condition, workloadId: trial.workloadId, repeat: trial.repeat,
      state: s.state === 'started_unresolved' ? 'ambiguous' : s.state, attempts: s.attempts,
      evidenceRef: record ? trialRef(trial.id, record.attempt) : null,
      outcome: trial.observed?.outcome ?? record?.withheld?.outcome ?? null,
      exclusions: s.completed?.exclusions ?? [], notes: s.completed?.notes ?? [], budget: s.completed?.budget ?? null,
      reconciliation: s.reconciled ? s.reconciled.resolution : null,
      ambiguousAttempts: s.ambiguous.map(a => ({ attempt: a.attempt, reason: a.reason })),
      abortedAttempts: s.aborted.map(a => ({ attempt: a.attempt, reason: a.reason, drift: (a.drift ?? []).map(d => d.field) })),
      preflightDrift: s.drift.flatMap(d => d.drift.map(x => x.field)) });
  }
  const coverage = validateStudy(study);
  const report = { schemaVersion: 1, reportVersion: REPORT_VERSION, runnerVersion: RUNNER_VERSION, studyId: ctx.run.studyId,
    manifestSha256: ctx.run.manifestSha256, evidenceKind: ctx.run.evidenceKind, coverage, counts,
    jev: { requestedModel: ctx.run.jev.requestedModel, resolvedModelPin: cohortPin(ctx) },
    independentReview: 'pending: automated runs are never marked independently reviewed; routingReview stays null',
    captureCompleteness: 'TODO(#135): not yet exported by the collector; inferred from warnings, pending attempts and history completeness',
    trials };
  const serialized = JSON.stringify(report) + JSON.stringify(study);
  assert.ok(!serialized.includes(ctx.dir), 'Export must contain only redacted relative references');
  return { study, report };
}

export function validateRun({ runDir }) {
  const ctx = loadRun(runDir);
  for (const w of ctx.study.config.workloads) assert.deepEqual(verifyArtifacts(ctx, w.id).drift, [], `Artifact drift for ${w.id}`);
  const expected = new Set(ctx.study.trials.map(t => t.id));
  for (const name of readdirSync(path.join(ctx.dir, 'trials'))) assert.ok(expected.has(name), `Unexpected trial directory ${name}`);
  let seenIncomplete = false;
  const states = {};
  for (const trial of ctx.study.trials) {
    const s = trialState(ctx, trial.id);
    states[s.state] = (states[s.state] ?? 0) + 1;
    const started = s.attempts > 0 || s.drift.length > 0;
    assert.ok(!(seenIncomplete && started), 'A trial started before an earlier trial finished: randomized order was not followed');
    if (!TERMINAL.has(s.state)) seenIncomplete = true;
  }
  const exported = exportRun({ runDir });
  return { studyId: ctx.run.studyId, trials: ctx.study.trials.length, states, coverage: exported.report.coverage };
}

function checkoutOf(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' });
  return { revision: head.status === 0 ? head.stdout.trim() : null, clean: status.status === 0 && status.stdout.trim() === '' };
}

/** Blocks fetch and every outbound TCP/IPC socket for the duration of fn. */
export async function withoutNetwork(fn) {
  const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
  globalThis.fetch = async () => { throw new Error('Network is disabled in credential-free runner actions'); };
  net.Socket.prototype.connect = function blocked() { throw new Error('Network is disabled in credential-free runner actions'); };
  try { return await fn(); } finally { globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect; }
}

/** Shows what `run` would do for the next pending trials without creating attempts, spawning hosts or reading credentials. */
export async function dryRun({ runDir, repoRoot = root, limit = 5 }) {
  return withoutNetwork(async () => {
    const validation = validateRun({ runDir });
    const ctx = loadRun(runDir), v = ctx.study.config.versions, checkout = checkoutOf(repoRoot);
    const checks = [
      { name: 'checkout.revision', ok: checkout.revision === v.hivemindRevision, detail: checkout.revision },
      { name: 'checkout.clean', ok: checkout.clean, detail: null },
      { name: 'versions.policyVersion', ok: TOPOLOGY_POLICY_VERSION === v.policyVersion, detail: TOPOLOGY_POLICY_VERSION },
      { name: 'jev.requestedModel', ok: validJevModel(ctx.run.jev.requestedModel), detail: ctx.run.jev.pinned ? ctx.run.jev.requestedModel : `${TYPESAFE_MODEL} (unpinned alias)` },
      { name: 'versions.host', ok: v.host === `${ctx.run.host.name}/${ctx.run.host.binaryVersion}`, detail: `${ctx.run.host.name}/${ctx.run.host.binaryVersion}` },
    ];
    const next = [];
    for (const [index, trial] of ctx.study.trials.entries()) {
      const s = trialState(ctx, trial.id);
      if (TERMINAL.has(s.state)) continue;
      const auto = trial.condition === 'auto';
      next.push({ index, trialId: trial.id, condition: trial.condition, workloadId: trial.workloadId, repeat: trial.repeat,
        state: s.state, wouldCreate: trialRef(trial.id, s.attempts + 1), routing: auto ? 'auto' : trial.condition,
        lockScope: auto ? 'none' : 'task', jevEnabled: auto, freeWorkers: ctx.study.config.freeWorkers });
      if (s.state !== 'pending' || next.length >= limit) break;
    }
    return { studyId: ctx.run.studyId, evidenceKind: ctx.run.evidenceKind, states: validation.states, checks,
      wouldRefuse: checks.filter(c => !c.ok).map(c => c.name), next, paid: false };
  });
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage (all but run are credential-free and offline):
  prepare   --plan <plan.json> --run-dir <new dir>
  validate  --run-dir <dir>
  dry-run   --run-dir <dir>
  run       --run-dir <dir> --authorize-paid-run <studyId> [--max-trials <n>]
  reconcile --run-dir <dir> --trial <id> --resolution interrupted|harness_failed [--initial-topology <t>] [--note <text>]
  export    --run-dir <dir> --output <new study.json> --report <new report.json>`;
const FLAGS = { prepare: ['--plan', '--run-dir'], validate: ['--run-dir'], 'dry-run': ['--run-dir'],
  run: ['--run-dir', '--authorize-paid-run', '--max-trials'], reconcile: ['--run-dir', '--trial', '--resolution', '--initial-topology', '--note'],
  export: ['--run-dir', '--output', '--report'] };

export function parseArgs(argv) {
  const [command, ...args] = argv;
  assert.ok(Object.hasOwn(FLAGS, command), USAGE);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(FLAGS[command].includes(args[i]) && args[i + 1] !== undefined && !args[i + 1].startsWith('--') && !options[args[i]], USAGE);
    options[args[i]] = args[i + 1];
  }
  assert.ok(options['--run-dir'], USAGE);
  return { command, options };
}

export async function main(argv = process.argv.slice(2), { env = process.env, createHost } = {}) {
  const { command, options } = parseArgs(argv);
  const runDir = options['--run-dir'];
  if (command === 'prepare') { assert.ok(options['--plan'], USAGE); return withoutNetwork(async () => prepareRun({ planPath: options['--plan'], runDir })); }
  if (command === 'validate') return withoutNetwork(async () => validateRun({ runDir }));
  if (command === 'dry-run') return dryRun({ runDir });
  if (command === 'reconcile') return withoutNetwork(async () => reconcileTrial({ runDir, trialId: options['--trial'],
    resolution: options['--resolution'], initialTopology: options['--initial-topology'] ?? null, note: options['--note'] ?? '' }));
  if (command === 'export') {
    assert.ok(options['--output'] && options['--report'], USAGE);
    return withoutNetwork(async () => {
      const { study, report } = exportRun({ runDir });
      writeExclusive(path.resolve(options['--output']), JSON.stringify(study, null, 2) + '\n');
      writeExclusive(path.resolve(options['--report']), JSON.stringify(report, null, 2) + '\n');
      return report.counts;
    });
  }
  // run: the only path that may reach a provider.
  assert.ok(!['1', 'true'].includes(String(env.CI ?? '').toLowerCase()), 'Paid execution is refused in CI');
  const ctx = loadRun(runDir);
  assert.equal(options['--authorize-paid-run'], ctx.run.studyId, 'Paid execution requires --authorize-paid-run <studyId> for exactly this study');
  assert.equal(ctx.run.evidenceKind, 'live', 'Only a live manifest can be executed by the live host; synthetic manifests stay offline');
  const maxTrials = options['--max-trials'] === undefined ? Infinity : Number(options['--max-trials']);
  assert.ok(maxTrials === Infinity || (Number.isSafeInteger(maxTrials) && maxTrials >= 1), '--max-trials must be a positive integer');
  const pendingAuto = ctx.study.trials.some(t => t.condition === 'auto' && !TERMINAL.has(trialState(ctx, t.id).state));
  assert.ok(!pendingAuto || String(env.HIVEMIND_STUDY_TYPESAFE_KEY ?? '').trim(), 'Auto trials need HIVEMIND_STUDY_TYPESAFE_KEY; refusing before any paid trial starts');
  const factory = createHost ?? (await import('./topology-study-host.mjs')).createHivemindHost;
  const host = factory({ repoRoot: root, plan: ctx.run, env });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await runStudy({ runDir, host, authorization: options['--authorize-paid-run'], maxTrials, signal: controller.signal,
      secrets: [env.HIVEMIND_STUDY_TYPESAFE_KEY] });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error instanceof Error ? error.message.split('\n')[0] : 'Runner failed'); process.exitCode = 1; });
}
