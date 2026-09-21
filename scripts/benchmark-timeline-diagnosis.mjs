import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFixtures, seededShuffle } from './benchmark-coordination.mjs';
import { replayTimeline } from '../src/shared/timeline.ts';

export const DIAGNOSIS_SCHEMA_VERSION = 1;
export const DIAGNOSIS_CASE_VERSION = 1;
export const CONDITIONS = Object.freeze(['baseline', 'timeline']);
export const DEFAULT_DIAGNOSIS_SEED = 32;
export const DEFAULT_DIAGNOSIS_REPEAT = 2;

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const opaqueId = (prefix, value) => `${prefix}-${hash(value).slice(0, 16)}`;
const finiteOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

function revision(root) {
  const found = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : 'unknown';
}

function ensureString(value, name) {
  assert.ok(typeof value === 'string' && value.length > 0, `${name} is required`);
  return value;
}

function ensureStringArray(value, name) {
  assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0), `${name} must be a string array`);
  return value;
}

function validateTimelineExport(value, name) {
  assert.equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  assert.equal(value.mode, 'fake-only', `${name}.mode`);
  ensureString(value.traceId, `${name}.traceId`);
  assert.ok(Array.isArray(value.events) && value.events.length > 0 && value.events.length <= 500, `${name}.events must be bounded`);
  assert.equal(value.truncated, false, `${name} fixture must be complete`);
  const serialized = JSON.stringify(value);
  assert.ok(!/"authorId"|"authorName"|"agentId"|"agentName"|"body"\s*:|"token"\s*:|"secret"\s*:/i.test(serialized),
    `${name} must stay structurally redacted`);
  replayTimeline(value);
  return value;
}

export function loadDiagnosisCases(root) {
  const file = path.join(root, 'benchmarks', 'timeline', 'v1', 'diagnosis-cases.json');
  const document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(document.schemaVersion, DIAGNOSIS_CASE_VERSION, 'unsupported diagnosis case schemaVersion');
  assert.ok(Array.isArray(document.cases) && document.cases.length >= 3 && document.cases.length <= 8, 'keep diagnosis case set intentionally small');
  const sourceIds = new Set(loadFixtures(root).map(fixture => fixture.id));
  const ids = new Set();
  for (const item of document.cases) {
    assert.match(item.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.ok(!ids.has(item.id), `duplicate diagnosis case ${item.id}`);
    ids.add(item.id);
    assert.ok(sourceIds.has(item.sourceCoordinationFixture), `${item.id} must reference a #29 coordination fixture`);
    ensureString(item.question, `${item.id}.question`);
    ensureString(item.groundTruth?.diagnosis, `${item.id}.groundTruth.diagnosis`);
    ensureStringArray(item.groundTruth?.evidence, `${item.id}.groundTruth.evidence`);
    validateTimelineExport(item.timeline, `${item.id}.timeline`);
  }
  return document.cases;
}

export function baselineEvidence(timeline) {
  const messages = timeline.events.filter(event => event.kind === 'message');
  const root = messages[0]?.messageId ?? null;
  return {
    schemaVersion: 1,
    mode: 'baseline-redacted',
    taskRef: timeline.taskId ? 'task-1' : null,
    events: messages.map((event, index) => ({
      kind: 'message',
      at: event.at,
      messageId: event.messageId,
      seq: event.seq,
      actor: event.actor,
      eventType: event.eventType,
      taskAction: event.taskAction,
      inferredThreadParentMessageId: index === 0 ? null : root,
      references: event.references,
    })),
    truncated: timeline.truncated,
    limitation: 'Pre-timeline view: message/task ordering and inferred thread structure only. No durable transport source, delivery/ack attempts, wake reason, or explicit causal reference.',
  };
}

function promptFor(item) {
  return [
    item.question,
    '',
    'Identify the most likely failure point or root cause supported by the supplied redacted evidence.',
    'Do not inspect benchmark source fixtures or answer keys while performing the timed trial.',
    'If the evidence is insufficient to localize the cause, state that explicitly instead of guessing.',
    'Return a short diagnosis and cite the event IDs/message sequences you relied on.',
  ].join('\n');
}

export function trialTemplate(item, condition, seed, repeatIndex, config) {
  assert.ok(CONDITIONS.includes(condition), 'unknown diagnosis condition');
  const identity = [
    item.id, condition, seed, repeatIndex,
    config.hivemindRevision, config.provider, config.model, config.host, config.configuration,
  ].join('|');
  const evidence = condition === 'timeline' ? structuredClone(item.timeline) : baselineEvidence(item.timeline);
  return {
    schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
    evidenceClass: 'timeline_diagnosis_trial',
    status: 'pending',
    trialId: opaqueId('trial', identity),
    blindId: opaqueId('blind', `${identity}|blind`),
    caseId: opaqueId('case', `timeline-diagnosis-v1|${item.id}`),
    versions: {
      hivemindRevision: config.hivemindRevision,
      provider: config.provider,
      model: config.model,
      host: config.host,
      configuration: config.configuration,
      protocolVersion: 'timeline-diagnosis-v1',
    },
    runbook: { prompt: promptFor(item), evidence },
    timing: { startedAt: null, completedAt: null, wallMs: null },
    diagnosis: { text: null, evidenceRefs: [], clarificationRounds: null },
    efficiency: {
      providerTokens: null,
      providerCost: null,
      providerCurrency: null,
      providerUsageReason: 'Fill only from provider-reported usage; unknown stays null.',
    },
    review: { correct: null, supportedByEvidence: null, blinded: null, reviewer: null, notes: null },
  };
}

export function prepareDiagnosisTrials(cases, config) {
  const entries = [];
  for (let repeatIndex = 0; repeatIndex < config.repeat; repeatIndex++) {
    const caseOrder = seededShuffle(cases, config.seed + repeatIndex * 10_000);
    for (let caseIndex = 0; caseIndex < caseOrder.length; caseIndex++) {
      const item = caseOrder[caseIndex];
      const conditions = seededShuffle(CONDITIONS, config.seed + repeatIndex * 10_000 + caseIndex * 97);
      for (const condition of conditions) {
        const trial = trialTemplate(item, condition, config.seed, repeatIndex, config);
        entries.push({
          trial,
          manifest: {
            trialId: trial.trialId,
            blindId: trial.blindId,
            caseId: trial.caseId,
            fixtureId: item.id,
            sourceCoordinationFixture: item.sourceCoordinationFixture,
            condition,
            repeatIndex,
          },
        });
      }
    }
  }
  return entries;
}

export function validateDiagnosisTrial(value, { requireComplete = false } = {}) {
  assert.equal(value.schemaVersion, DIAGNOSIS_SCHEMA_VERSION, 'unsupported diagnosis trial schemaVersion');
  assert.equal(value.evidenceClass, 'timeline_diagnosis_trial');
  assert.ok(['pending', 'complete'].includes(value.status));
  assert.match(value.trialId, /^trial-[a-f0-9]{16}$/);
  assert.match(value.blindId, /^blind-[a-f0-9]{16}$/);
  assert.match(value.caseId, /^case-[a-f0-9]{16}$/);
  for (const key of ['hivemindRevision', 'provider', 'model', 'host', 'configuration', 'protocolVersion'])
    ensureString(value.versions[key], `versions.${key}`);
  ensureString(value.runbook?.prompt, 'runbook.prompt');
  assert.ok(['baseline-redacted', 'fake-only'].includes(value.runbook?.evidence?.mode), 'unsupported evidence mode');
  assert.ok(!Object.hasOwn(value, 'condition') && !Object.hasOwn(value, 'fixtureId') && !Object.hasOwn(value, 'groundTruth'),
    'participant trial must not expose manifest/answer-key metadata');
  if (requireComplete || value.status === 'complete') {
    assert.equal(value.status, 'complete');
    assert.ok(typeof value.timing.startedAt === 'string' && !Number.isNaN(Date.parse(value.timing.startedAt)), 'timing.startedAt');
    assert.ok(typeof value.timing.completedAt === 'string' && !Number.isNaN(Date.parse(value.timing.completedAt)), 'timing.completedAt');
    assert.ok(typeof value.timing.wallMs === 'number' && Number.isFinite(value.timing.wallMs) && value.timing.wallMs > 0, 'timing.wallMs');
    ensureString(value.diagnosis.text, 'diagnosis.text');
    ensureStringArray(value.diagnosis.evidenceRefs, 'diagnosis.evidenceRefs');
    assert.ok(Number.isInteger(value.diagnosis.clarificationRounds) && value.diagnosis.clarificationRounds >= 0, 'diagnosis.clarificationRounds');
    assert.ok(finiteOrNull(value.efficiency.providerTokens), 'efficiency.providerTokens');
    assert.ok(finiteOrNull(value.efficiency.providerCost), 'efficiency.providerCost');
    if (value.efficiency.providerCost !== null) ensureString(value.efficiency.providerCurrency, 'efficiency.providerCurrency');
    assert.equal(typeof value.review.correct, 'boolean', 'review.correct');
    assert.equal(typeof value.review.supportedByEvidence, 'boolean', 'review.supportedByEvidence');
    assert.equal(typeof value.review.blinded, 'boolean', 'review.blinded');
    ensureString(value.review.reviewer, 'review.reviewer');
  }
  assert.ok(!Object.hasOwn(value, 'score') && !Object.hasOwn(value, 'winner'), 'diagnosis trials must not emit a score or winner');
  return value;
}

function validateManifest(value) {
  assert.equal(value.schemaVersion, DIAGNOSIS_SCHEMA_VERSION, 'unsupported diagnosis manifest schemaVersion');
  assert.equal(value.evidenceClass, 'timeline_diagnosis_manifest');
  assert.ok(Number.isInteger(value.seed) && value.seed >= 0, 'manifest.seed');
  assert.ok(Number.isInteger(value.repeat) && value.repeat >= 1 && value.repeat <= 20, 'manifest.repeat');
  assert.ok(Array.isArray(value.trials) && value.trials.length > 0, 'manifest.trials');
  const ids = new Set();
  for (const row of value.trials) {
    assert.match(row.trialId, /^trial-[a-f0-9]{16}$/);
    assert.ok(!ids.has(row.trialId), `duplicate manifest trial ${row.trialId}`);
    ids.add(row.trialId);
    assert.ok(CONDITIONS.includes(row.condition), 'manifest condition');
    assert.ok(Number.isInteger(row.repeatIndex) && row.repeatIndex >= 0, 'manifest repeatIndex');
    ensureString(row.fixtureId, 'manifest fixtureId');
    ensureString(row.sourceCoordinationFixture, 'manifest sourceCoordinationFixture');
  }
  return value;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

function deterministicRandom(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function describe(values, seed) {
  const xs = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null, bootstrap95: null };
  const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const random = deterministicRandom(seed), samples = [];
  if (xs.length >= 2) {
    for (let index = 0; index < 1000; index++)
      samples.push(mean(Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)])));
    samples.sort((a, b) => a - b);
  }
  return {
    n: xs.length,
    mean: mean(xs),
    median: quantile(sorted, 0.5),
    min: sorted[0],
    max: sorted.at(-1),
    bootstrap95: xs.length >= 2 ? [quantile(samples, 0.025), quantile(samples, 0.975)] : null,
  };
}

export function summarizeDiagnosisTrials(trials, manifest, seed = DEFAULT_DIAGNOSIS_SEED) {
  validateManifest(manifest);
  const metadata = new Map(manifest.trials.map(row => [row.trialId, row]));
  const complete = [];
  for (const trial of trials) {
    validateDiagnosisTrial(trial);
    const row = metadata.get(trial.trialId);
    assert.ok(row, `trial ${trial.trialId} is not present in manifest`);
    if (trial.status === 'complete') complete.push({ trial: validateDiagnosisTrial(trial, { requireComplete: true }), meta: row });
  }

  const groups = new Map();
  for (const item of complete) {
    const v = item.trial.versions;
    const cohort = [v.hivemindRevision, v.provider, v.model, v.host, v.configuration, v.protocolVersion].join('|');
    const key = `${cohort}::${item.meta.fixtureId}::${item.meta.condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const summaries = [...groups.entries()].sort().map(([key, rows], index) => {
    const [cohort, fixtureId, condition] = key.split('::');
    const [hivemindRevision, provider, model, host, configuration, protocolVersion] = cohort.split('|');
    return {
      cohort: { hivemindRevision, provider, model, host, configuration, protocolVersion },
      fixtureId,
      sourceCoordinationFixture: rows[0].meta.sourceCoordinationFixture,
      condition,
      trials: rows.length,
      accuracyRate: rows.filter(row => row.trial.review.correct).length / rows.length,
      evidenceSupportRate: rows.filter(row => row.trial.review.supportedByEvidence).length / rows.length,
      dimensions: {
        wallMs: describe(rows.map(row => row.trial.timing.wallMs), seed + index * 101),
        clarificationRounds: describe(rows.map(row => row.trial.diagnosis.clarificationRounds), seed + index * 101 + 1),
        providerTokens: describe(rows.map(row => row.trial.efficiency.providerTokens), seed + index * 101 + 2),
        providerCost: describe(rows.map(row => row.trial.efficiency.providerCost), seed + index * 101 + 3),
      },
    };
  });

  const completeById = new Map(complete.map(item => [item.trial.trialId, item]));
  const pairs = [];
  const pairGroups = new Map();
  for (const row of manifest.trials) {
    const key = `${row.fixtureId}::${row.repeatIndex}`;
    if (!pairGroups.has(key)) pairGroups.set(key, {});
    pairGroups.get(key)[row.condition] = row;
  }
  for (const [key, pair] of [...pairGroups.entries()].sort()) {
    if (!pair.baseline || !pair.timeline) continue;
    const baseline = completeById.get(pair.baseline.trialId), timeline = completeById.get(pair.timeline.trialId);
    if (!baseline || !timeline) continue;
    const [fixtureId, repeatIndex] = key.split('::');
    pairs.push({
      fixtureId,
      sourceCoordinationFixture: baseline.meta.sourceCoordinationFixture,
      repeatIndex: Number(repeatIndex),
      baseline: {
        wallMs: baseline.trial.timing.wallMs,
        correct: baseline.trial.review.correct,
        supportedByEvidence: baseline.trial.review.supportedByEvidence,
      },
      timeline: {
        wallMs: timeline.trial.timing.wallMs,
        correct: timeline.trial.review.correct,
        supportedByEvidence: timeline.trial.review.supportedByEvidence,
      },
      timelineMinusBaselineWallMs: timeline.trial.timing.wallMs - baseline.trial.timing.wallMs,
    });
  }

  return {
    schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
    evidenceClass: 'timeline_diagnosis_summary',
    completeTrials: complete.length,
    incompleteTrials: trials.length - complete.length,
    summaries,
    pairedComparisons: pairs,
    interpretation: 'Descriptive diagnosis evidence only. Compare accuracy/evidence support alongside wall time. Paired wall-time deltas are workload-specific observations, not a general winner or productivity claim.',
  };
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    root: process.cwd(),
    input: null,
    output: null,
    provider: null,
    model: null,
    host: null,
    configuration: null,
    repeat: DEFAULT_DIAGNOSIS_REPEAT,
    seed: DEFAULT_DIAGNOSIS_SEED,
    hivemindRevision: null,
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--input') options.input = path.resolve(argv[++index]);
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--configuration') options.configuration = argv[++index];
    else if (arg === '--repeat') options.repeat = Number(argv[++index]);
    else if (arg === '--seed') options.seed = Number(argv[++index]);
    else if (arg === '--hivemind-revision') options.hivemindRevision = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function trialFiles(input) {
  return readdirSync(input).filter(name => name.startsWith('trial-') && name.endsWith('.json')).sort();
}

function readTrials(input) {
  return trialFiles(input).map(name => JSON.parse(readFileSync(path.join(input, name), 'utf8')));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  assert.ok(['prepare', 'validate', 'summarize'].includes(options.command), 'Use prepare, validate or summarize');

  if (options.command === 'prepare') {
    assert.ok(options.output, '--output directory is required');
    assert.ok(options.provider && options.model && options.host && options.configuration,
      '--provider, --model, --host and --configuration are required');
    assert.ok(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 20, '--repeat must be 1..20');
    assert.ok(Number.isInteger(options.seed) && options.seed >= 0, '--seed must be a non-negative integer');
    const config = {
      ...options,
      hivemindRevision: options.hivemindRevision ?? revision(options.root),
    };
    assert.notEqual(config.hivemindRevision, 'unknown', 'Unable to pin Hivemind revision; pass --hivemind-revision explicitly');
    const cases = loadDiagnosisCases(options.root);
    const entries = prepareDiagnosisTrials(cases, config);
    mkdirSync(options.output, { recursive: true });
    for (const entry of entries)
      writeFileSync(path.join(options.output, `${entry.trial.trialId}.json`), JSON.stringify(entry.trial, null, 2) + '\n', { flag: 'wx' });
    const manifest = {
      schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
      evidenceClass: 'timeline_diagnosis_manifest',
      seed: options.seed,
      repeat: options.repeat,
      versions: {
        hivemindRevision: config.hivemindRevision,
        provider: config.provider,
        model: config.model,
        host: config.host,
        configuration: config.configuration,
        protocolVersion: 'timeline-diagnosis-v1',
      },
      trials: entries.map(entry => entry.manifest),
    };
    writeFileSync(path.join(options.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output: options.output, trials: entries.length }) + '\n');
    return manifest;
  }

  assert.ok(options.input && existsSync(options.input), '--input directory is required');
  const trials = readTrials(options.input);
  const manifestPath = path.join(options.input, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest.json is required');
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

  if (options.command === 'validate') {
    for (const trial of trials) validateDiagnosisTrial(trial);
    process.stdout.write(JSON.stringify({ valid: trials.length }) + '\n');
    return trials;
  }

  const summary = summarizeDiagnosisTrials(trials, manifest, options.seed);
  const json = JSON.stringify(summary, null, 2) + '\n';
  if (options.output) writeFileSync(options.output, json);
  else process.stdout.write(json);
  return summary;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
