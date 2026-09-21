import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seededShuffle } from './benchmark-coordination.mjs';

export const HUMAN_DECISION_SCHEMA_VERSION = 1;
export const HUMAN_DECISION_CASE_VERSION = 1;
export const HUMAN_DECISION_PROTOCOL_VERSION = 'human-decisions-eval-v1';
export const CONDITIONS = Object.freeze(['mentions', 'decision_queue']);
export const DEFAULT_HUMAN_DECISION_SEED = 34;
export const DEFAULT_HUMAN_DECISION_REPEAT = 2;

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const opaqueId = (prefix, value) => prefix + '-' + hash(value).slice(0, 16);

function revision(root) {
  const found = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : 'unknown';
}

function ensureString(value, name) {
  assert.ok(typeof value === 'string' && value.length > 0, name + ' is required');
  return value;
}

function ensureStringArray(value, name) {
  assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0),
    name + ' must be a string array');
  return value;
}

function ensureCount(value, name) {
  assert.ok(Number.isInteger(value) && value >= 0, name + ' must be an integer >= 0');
  return value;
}

function validateAnswerKey(value, name) {
  assert.ok(value && ['answer', 'do_not_apply'].includes(value.action), name + '.action');
  if (value.action === 'answer') ensureString(value.optionId, name + '.optionId');
  else assert.equal(value.optionId, null, name + '.optionId must be null when action is do_not_apply');
  ensureString(value.taskId, name + '.taskId');
  assert.ok(Number.isInteger(value.taskRevision) && value.taskRevision >= 1, name + '.taskRevision');
  return value;
}

function validateMentionView(value, name) {
  assert.equal(value?.mode, 'mentions', name + '.mode');
  ensureString(value.project, name + '.project');
  assert.ok(Array.isArray(value.entries) && value.entries.length >= 2 && value.entries.length <= 12,
    name + '.entries must contain 2..12 messages');
  for (const [index, entry] of value.entries.entries()) {
    ensureString(entry.channel, name + '.entries[' + index + '].channel');
    ensureString(entry.author, name + '.entries[' + index + '].author');
    ensureString(entry.body, name + '.entries[' + index + '].body');
    assert.ok(Number.isInteger(entry.seq) && entry.seq >= 1, name + '.entries[' + index + '].seq');
  }
  return value;
}

function validateDecisionView(value, name) {
  assert.equal(value?.mode, 'decision_queue', name + '.mode');
  ensureString(value.project, name + '.project');
  const decision = value.decision;
  assert.ok(decision && typeof decision === 'object', name + '.decision');
  ensureString(decision.question, name + '.decision.question');
  ensureString(decision.state, name + '.decision.state');
  ensureString(decision.taskId, name + '.decision.taskId');
  assert.ok(Number.isInteger(decision.taskRevision) && decision.taskRevision >= 1, name + '.decision.taskRevision');
  assert.ok(Number.isInteger(decision.currentTaskRevision) && decision.currentTaskRevision >= 1,
    name + '.decision.currentTaskRevision');
  assert.ok(Array.isArray(decision.options), name + '.decision.options');
  for (const [index, option] of decision.options.entries()) {
    ensureString(option.id, name + '.decision.options[' + index + '].id');
    ensureString(option.label, name + '.decision.options[' + index + '].label');
    ensureString(option.impact, name + '.decision.options[' + index + '].impact');
  }
  ensureStringArray(decision.affectedWorkers, name + '.decision.affectedWorkers');
  assert.ok(Array.isArray(decision.evidenceSeqs) && decision.evidenceSeqs.every(item => Number.isInteger(item) && item >= 1),
    name + '.decision.evidenceSeqs');
  ensureStringArray(decision.artifacts, name + '.decision.artifacts');
  ensureString(decision.warning, name + '.decision.warning');
  return value;
}

export function loadHumanDecisionCases(root = process.cwd()) {
  const file = path.join(root, 'benchmarks', 'human-decisions', 'v1', 'cases.json');
  const document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(document.schemaVersion, HUMAN_DECISION_CASE_VERSION, 'unsupported Human decision case schemaVersion');
  assert.ok(Array.isArray(document.cases) && document.cases.length >= 3 && document.cases.length <= 8,
    'keep Human decision case set intentionally small');
  const ids = new Set();
  for (const item of document.cases) {
    assert.match(item.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.ok(!ids.has(item.id), 'duplicate Human decision case ' + item.id);
    ids.add(item.id);
    ensureString(item.description, item.id + '.description');
    ensureString(item.prompt, item.id + '.prompt');
    validateAnswerKey(item.answerKey, item.id + '.answerKey');
    validateMentionView(item.mentionView, item.id + '.mentionView');
    validateDecisionView(item.decisionView, item.id + '.decisionView');
    assert.equal(item.decisionView.decision.taskId, item.answerKey.taskId, item.id + ' task mismatch');
    assert.equal(item.decisionView.decision.currentTaskRevision, item.answerKey.taskRevision,
      item.id + ' current task revision mismatch');
    if (item.answerKey.action === 'answer') {
      assert.ok(item.decisionView.decision.options.some(option => option.id === item.answerKey.optionId),
        item.id + ' answer option must exist in decision view');
    }
  }
  return document.cases;
}

function participantPrompt(item) {
  return [
    item.prompt,
    '',
    'Use only the supplied Human view.',
    'Respond with either answer or do_not_apply.',
    'If answering, select one visible option and identify the exact task ID and current task revision you intend the answer to affect.',
    'Record evidence references used, any repeated/follow-up questions needed, and any unrelated contexts you had to open.',
    'Do not assume that expiry or a recommendation authorizes an option automatically.',
  ].join('\n');
}

export function trialTemplate(item, condition, seed, repeatIndex, config) {
  assert.ok(CONDITIONS.includes(condition), 'unknown Human decision condition');
  const identity = [
    item.id,
    condition,
    seed,
    repeatIndex,
    config.hivemindRevision,
    config.participantCohort,
    HUMAN_DECISION_PROTOCOL_VERSION,
  ].join('|');
  return {
    schemaVersion: HUMAN_DECISION_SCHEMA_VERSION,
    evidenceClass: 'human_decision_trial',
    status: 'pending',
    abortReason: null,
    trialId: opaqueId('trial', identity),
    blindId: opaqueId('blind', identity + '|blind'),
    caseId: opaqueId('case', HUMAN_DECISION_PROTOCOL_VERSION + '|' + item.id),
    versions: {
      hivemindRevision: config.hivemindRevision,
      participantCohort: config.participantCohort,
      protocolVersion: HUMAN_DECISION_PROTOCOL_VERSION,
    },
    runbook: {
      prompt: participantPrompt(item),
      view: structuredClone(condition === 'decision_queue' ? item.decisionView : item.mentionView),
    },
    timing: {
      startedAt: null,
      completedAt: null,
      handlingWallMs: null,
      blockerToDecisionMs: null,
    },
    response: {
      action: null,
      selectedOptionId: null,
      answerText: null,
      taskId: null,
      taskRevision: null,
      evidenceRefs: [],
    },
    observations: {
      repeatedQuestionCount: null,
      unrelatedContextsOpened: null,
    },
    review: {
      supportedByEvidence: null,
      blinded: null,
      reviewer: null,
      notes: null,
    },
  };
}

export function prepareHumanDecisionTrials(cases, config) {
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
            condition,
            repeatIndex,
            answerKey: structuredClone(item.answerKey),
          },
        });
      }
    }
  }
  return entries;
}

export function validateHumanDecisionTrial(value, { requireComplete = false } = {}) {
  assert.equal(value.schemaVersion, HUMAN_DECISION_SCHEMA_VERSION, 'unsupported Human decision trial schemaVersion');
  assert.equal(value.evidenceClass, 'human_decision_trial');
  assert.ok(['pending', 'complete', 'aborted'].includes(value.status), 'unsupported Human decision trial status');
  assert.match(value.trialId, /^trial-[a-f0-9]{16}$/);
  assert.match(value.blindId, /^blind-[a-f0-9]{16}$/);
  assert.match(value.caseId, /^case-[a-f0-9]{16}$/);
  for (const key of ['hivemindRevision', 'participantCohort', 'protocolVersion'])
    ensureString(value.versions[key], 'versions.' + key);
  assert.equal(value.versions.protocolVersion, HUMAN_DECISION_PROTOCOL_VERSION, 'protocolVersion');
  ensureString(value.runbook?.prompt, 'runbook.prompt');
  assert.ok(['mentions', 'decision_queue'].includes(value.runbook?.view?.mode), 'unsupported Human decision view mode');
  assert.ok(!Object.hasOwn(value, 'condition') && !Object.hasOwn(value, 'fixtureId') && !Object.hasOwn(value, 'answerKey'),
    'participant trial must not expose manifest/answer-key metadata');

  if (value.status === 'aborted') ensureString(value.abortReason, 'abortReason');
  if (requireComplete || value.status === 'complete') {
    assert.equal(value.status, 'complete');
    assert.ok(typeof value.timing.startedAt === 'string' && !Number.isNaN(Date.parse(value.timing.startedAt)), 'timing.startedAt');
    assert.ok(typeof value.timing.completedAt === 'string' && !Number.isNaN(Date.parse(value.timing.completedAt)), 'timing.completedAt');
    assert.ok(typeof value.timing.handlingWallMs === 'number' && Number.isFinite(value.timing.handlingWallMs) &&
      value.timing.handlingWallMs > 0, 'timing.handlingWallMs');
    assert.ok(typeof value.timing.blockerToDecisionMs === 'number' && Number.isFinite(value.timing.blockerToDecisionMs) &&
      value.timing.blockerToDecisionMs >= value.timing.handlingWallMs, 'timing.blockerToDecisionMs');
    assert.ok(['answer', 'do_not_apply'].includes(value.response.action), 'response.action');
    if (value.response.action === 'answer') ensureString(value.response.selectedOptionId, 'response.selectedOptionId');
    else assert.equal(value.response.selectedOptionId, null, 'selectedOptionId must be null when response is do_not_apply');
    assert.ok(value.response.answerText === null || typeof value.response.answerText === 'string', 'response.answerText');
    ensureString(value.response.taskId, 'response.taskId');
    assert.ok(Number.isInteger(value.response.taskRevision) && value.response.taskRevision >= 1, 'response.taskRevision');
    ensureStringArray(value.response.evidenceRefs, 'response.evidenceRefs');
    ensureCount(value.observations.repeatedQuestionCount, 'observations.repeatedQuestionCount');
    ensureCount(value.observations.unrelatedContextsOpened, 'observations.unrelatedContextsOpened');
    assert.equal(typeof value.review.supportedByEvidence, 'boolean', 'review.supportedByEvidence');
    assert.equal(typeof value.review.blinded, 'boolean', 'review.blinded');
    ensureString(value.review.reviewer, 'review.reviewer');
  }
  assert.ok(!Object.hasOwn(value, 'score') && !Object.hasOwn(value, 'winner'),
    'Human decision trials must not emit a score or winner');
  return value;
}

function validateManifest(value) {
  assert.equal(value.schemaVersion, HUMAN_DECISION_SCHEMA_VERSION, 'unsupported Human decision manifest schemaVersion');
  assert.equal(value.evidenceClass, 'human_decision_manifest');
  assert.ok(Number.isInteger(value.seed) && value.seed >= 0, 'manifest.seed');
  assert.ok(Number.isInteger(value.repeat) && value.repeat >= 1 && value.repeat <= 20, 'manifest.repeat');
  assert.ok(Array.isArray(value.trials) && value.trials.length > 0, 'manifest.trials');
  const ids = new Set();
  for (const row of value.trials) {
    assert.match(row.trialId, /^trial-[a-f0-9]{16}$/);
    assert.ok(!ids.has(row.trialId), 'duplicate manifest trial ' + row.trialId);
    ids.add(row.trialId);
    assert.ok(CONDITIONS.includes(row.condition), 'manifest condition');
    assert.ok(Number.isInteger(row.repeatIndex) && row.repeatIndex >= 0, 'manifest repeatIndex');
    ensureString(row.fixtureId, 'manifest fixtureId');
    validateAnswerKey(row.answerKey, 'manifest answerKey');
  }
  return value;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
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
  const random = deterministicRandom(seed);
  const samples = [];
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

function objectiveResult(trial, answerKey) {
  const actionCorrect = trial.response.action === answerKey.action;
  const optionCorrect = answerKey.action === 'answer'
    ? trial.response.selectedOptionId === answerKey.optionId
    : trial.response.selectedOptionId === null;
  const decisionCorrect = actionCorrect && optionCorrect;
  const contextCorrect = trial.response.taskId === answerKey.taskId &&
    trial.response.taskRevision === answerKey.taskRevision;
  return {
    decisionCorrect,
    contextCorrect,
    wrongContextAnswer: trial.response.action === 'answer' && !contextCorrect,
  };
}

export function summarizeHumanDecisionTrials(trials, manifest, seed = DEFAULT_HUMAN_DECISION_SEED) {
  validateManifest(manifest);
  const metadata = new Map(manifest.trials.map(row => [row.trialId, row]));
  const complete = [];
  let abortedTrials = 0;
  for (const trial of trials) {
    validateHumanDecisionTrial(trial);
    const row = metadata.get(trial.trialId);
    assert.ok(row, 'trial ' + trial.trialId + ' is not present in manifest');
    if (trial.status === 'aborted') abortedTrials++;
    if (trial.status === 'complete') {
      const validated = validateHumanDecisionTrial(trial, { requireComplete: true });
      complete.push({ trial: validated, meta: row, objective: objectiveResult(validated, row.answerKey) });
    }
  }

  const groups = new Map();
  for (const item of complete) {
    const v = item.trial.versions;
    const cohort = [v.hivemindRevision, v.participantCohort, v.protocolVersion].join('|');
    const key = cohort + '::' + item.meta.fixtureId + '::' + item.meta.condition;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const summaries = [...groups.entries()].sort().map(([key, rows], index) => {
    const [cohort, fixtureId, condition] = key.split('::');
    const [hivemindRevision, participantCohort, protocolVersion] = cohort.split('|');
    return {
      cohort: { hivemindRevision, participantCohort, protocolVersion },
      fixtureId,
      condition,
      trials: rows.length,
      correctDecisionRate: rows.filter(row => row.objective.decisionCorrect).length / rows.length,
      correctContextRate: rows.filter(row => row.objective.contextCorrect).length / rows.length,
      wrongContextAnswerRate: rows.filter(row => row.objective.wrongContextAnswer).length / rows.length,
      evidenceSupportRate: rows.filter(row => row.trial.review.supportedByEvidence).length / rows.length,
      dimensions: {
        handlingWallMs: describe(rows.map(row => row.trial.timing.handlingWallMs), seed + index * 101),
        blockerToDecisionMs: describe(rows.map(row => row.trial.timing.blockerToDecisionMs), seed + index * 101 + 1),
        repeatedQuestionCount: describe(rows.map(row => row.trial.observations.repeatedQuestionCount), seed + index * 101 + 2),
        unrelatedContextsOpened: describe(rows.map(row => row.trial.observations.unrelatedContextsOpened), seed + index * 101 + 3),
      },
    };
  });

  const completeById = new Map(complete.map(item => [item.trial.trialId, item]));
  const pairGroups = new Map();
  for (const row of manifest.trials) {
    const key = row.fixtureId + '::' + row.repeatIndex;
    if (!pairGroups.has(key)) pairGroups.set(key, {});
    pairGroups.get(key)[row.condition] = row;
  }
  const pairedComparisons = [];
  for (const [key, pair] of [...pairGroups.entries()].sort()) {
    if (!pair.mentions || !pair.decision_queue) continue;
    const mentions = completeById.get(pair.mentions.trialId);
    const decisionQueue = completeById.get(pair.decision_queue.trialId);
    if (!mentions || !decisionQueue) continue;
    const [fixtureId, repeatIndex] = key.split('::');
    pairedComparisons.push({
      fixtureId,
      repeatIndex: Number(repeatIndex),
      mentions: {
        handlingWallMs: mentions.trial.timing.handlingWallMs,
        blockerToDecisionMs: mentions.trial.timing.blockerToDecisionMs,
        repeatedQuestionCount: mentions.trial.observations.repeatedQuestionCount,
        unrelatedContextsOpened: mentions.trial.observations.unrelatedContextsOpened,
        decisionCorrect: mentions.objective.decisionCorrect,
        contextCorrect: mentions.objective.contextCorrect,
        wrongContextAnswer: mentions.objective.wrongContextAnswer,
      },
      decisionQueue: {
        handlingWallMs: decisionQueue.trial.timing.handlingWallMs,
        blockerToDecisionMs: decisionQueue.trial.timing.blockerToDecisionMs,
        repeatedQuestionCount: decisionQueue.trial.observations.repeatedQuestionCount,
        unrelatedContextsOpened: decisionQueue.trial.observations.unrelatedContextsOpened,
        decisionCorrect: decisionQueue.objective.decisionCorrect,
        contextCorrect: decisionQueue.objective.contextCorrect,
        wrongContextAnswer: decisionQueue.objective.wrongContextAnswer,
      },
      decisionQueueMinusMentionsHandlingWallMs:
        decisionQueue.trial.timing.handlingWallMs - mentions.trial.timing.handlingWallMs,
      decisionQueueMinusMentionsBlockerToDecisionMs:
        decisionQueue.trial.timing.blockerToDecisionMs - mentions.trial.timing.blockerToDecisionMs,
      decisionQueueMinusMentionsRepeatedQuestions:
        decisionQueue.trial.observations.repeatedQuestionCount - mentions.trial.observations.repeatedQuestionCount,
      decisionQueueMinusMentionsUnrelatedContextsOpened:
        decisionQueue.trial.observations.unrelatedContextsOpened - mentions.trial.observations.unrelatedContextsOpened,
    });
  }

  return {
    schemaVersion: HUMAN_DECISION_SCHEMA_VERSION,
    evidenceClass: 'human_decision_summary',
    completeTrials: complete.length,
    incompleteTrials: trials.length - complete.length,
    abortedTrials,
    summaries,
    pairedComparisons,
    interpretation: 'Descriptive paired Human-handling evidence only. Compare correctness/context safety alongside time and interaction counts. Do not collapse dimensions into an overall winner or generalize a small local cohort.',
  };
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    root: process.cwd(),
    input: null,
    output: null,
    participantCohort: null,
    repeat: DEFAULT_HUMAN_DECISION_REPEAT,
    seed: DEFAULT_HUMAN_DECISION_SEED,
    hivemindRevision: null,
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--input') options.input = path.resolve(argv[++index]);
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else if (arg === '--participant-cohort') options.participantCohort = argv[++index];
    else if (arg === '--repeat') options.repeat = Number(argv[++index]);
    else if (arg === '--seed') options.seed = Number(argv[++index]);
    else if (arg === '--hivemind-revision') options.hivemindRevision = argv[++index];
    else throw new Error('Unknown argument: ' + arg);
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
    ensureString(options.participantCohort, '--participant-cohort');
    assert.ok(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 20, '--repeat must be 1..20');
    assert.ok(Number.isInteger(options.seed) && options.seed >= 0, '--seed must be a non-negative integer');
    const config = {
      ...options,
      hivemindRevision: options.hivemindRevision ?? revision(options.root),
    };
    assert.notEqual(config.hivemindRevision, 'unknown',
      'Unable to pin Hivemind revision; pass --hivemind-revision explicitly');
    const cases = loadHumanDecisionCases(options.root);
    const entries = prepareHumanDecisionTrials(cases, config);
    mkdirSync(options.output, { recursive: true });
    for (const entry of entries)
      writeFileSync(path.join(options.output, entry.trial.trialId + '.json'),
        JSON.stringify(entry.trial, null, 2) + '\n', { flag: 'wx' });
    const manifest = {
      schemaVersion: HUMAN_DECISION_SCHEMA_VERSION,
      evidenceClass: 'human_decision_manifest',
      seed: options.seed,
      repeat: options.repeat,
      versions: {
        hivemindRevision: config.hivemindRevision,
        participantCohort: config.participantCohort,
        protocolVersion: HUMAN_DECISION_PROTOCOL_VERSION,
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
    for (const trial of trials) validateHumanDecisionTrial(trial);
    process.stdout.write(JSON.stringify({ valid: trials.length }) + '\n');
    return trials;
  }

  const summary = summarizeHumanDecisionTrials(trials, manifest, options.seed);
  const json = JSON.stringify(summary, null, 2) + '\n';
  if (options.output) writeFileSync(options.output, json);
  else process.stdout.write(json);
  return summary;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
