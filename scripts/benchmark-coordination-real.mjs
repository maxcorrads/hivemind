import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED, WORKFLOWS, loadFixtures, seededShuffle } from './benchmark-coordination.mjs';

export const REAL_AGENT_PROTOCOL_VERSION = 1;
export const REAL_AGENT_PROMPT_VERSION = 'coordination-real-v1';
export const REAL_AGENT_TASK_VERSION = 'coordination-task-v1';

const metrics = [
  ['quality', 'defects'], ['quality', 'reworkEvents'], ['quality', 'duplicateWork'],
  ['coordination', 'clarificationRounds'], ['coordination', 'handoffCount'], ['coordination', 'recoveryEvents'],
  ['timing', 'wallMs'], ['efficiency', 'providerTokens'], ['efficiency', 'providerCost'],
];

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const id = (prefix, value) => `${prefix}-${hash(value).slice(0, 16)}`;
const finiteOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

function revision(root) {
  const found = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : 'unknown';
}

function workflowInstructions(workflow, workerCount) {
  if (workflow === 'single_worker') return ['Use one model session as the only worker.', 'Do not delegate or create a brain/worker hierarchy.'];
  if (workflow === 'brain_one_worker') return ['Use one brain and exactly one worker.', 'Use structured tasks and checkpoint/handoff when the fixture calls for them.'];
  if (workflow === 'brain_multi_dm') return [`Use one brain and up to ${workerCount} workers.`, 'Coordinate workers through task DMs; do not create a collaboration room.'];
  return [`Use one brain and up to ${workerCount} workers.`, 'Create/use one collaboration room for peer-visible coordination and use structured tasks.'];
}

function promptFor(fixture, workflow) {
  const tasks = fixture.tasks.map(task => `- ${task.id}: effort=${task.effort}; scope=${task.scope.join(', ')}; dependsOn=${task.dependsOn.join(', ') || 'none'}; clarifications=${task.clarifications ?? 0}; capability=${task.requiredCapability ?? 'none'}`).join('\n');
  const faults = fixture.faults.length ? fixture.faults.map(fault => `- ${fault.type} on ${fault.taskId}`).join('\n') : '- none';
  const instructions = fixture.instructions?.length ? fixture.instructions.map(line => `- ${line}`).join('\n') : '- none';
  return [
    `Coordination benchmark fixture: ${fixture.id}`,
    fixture.description,
    '',
    ...workflowInstructions(workflow, Math.min(3, fixture.workers.length)),
    'Preserve the fixture task/dependency shape. Use Hivemind coordination primitives when the workflow calls for them.',
    'Do the task normally with the configured real model/provider. Do not optimize for benchmark counters.',
    'Stop when the acceptance artifact is ready for independent review.',
    '', 'Tasks:', tasks, '', 'Scenario instructions:', instructions, '', 'Injected/recovery conditions:', faults,
  ].join('\n');
}

export function trialTemplate(fixture, workflow, seed, repeatIndex, config) {
  assert.ok(WORKFLOWS.includes(workflow));
  const identity = `${fixture.id}|${workflow}|${seed}|${repeatIndex}|${config.provider}|${config.model}|${config.host}|${config.configuration}|${config.hivemindRevision}|${config.promptVersion}|${config.taskVersion}`;
  const trialId = id('trial', identity), blindId = id('blind', `${identity}|blind`);
  return {
    schemaVersion: REAL_AGENT_PROTOCOL_VERSION,
    evidenceClass: 'real_agent',
    status: 'pending',
    trialId,
    blindId,
    fixture: { id: fixture.id, version: fixture.schemaVersion, kind: fixture.kind, description: fixture.description,
      exercises: fixture.exercises, promptVersion: config.promptVersion, taskVersion: config.taskVersion },
    trial: { workflow, seed, repeatIndex },
    versions: { hivemindRevision: config.hivemindRevision, provider: config.provider, model: config.model, host: config.host, configuration: config.configuration,
      promptVersion: config.promptVersion, taskVersion: config.taskVersion },
    runbook: { prompt: promptFor(fixture, workflow), acceptanceCriteria: ['Complete the fixture objective', 'Retain inspectable artifacts/evidence', 'Independent reviewer records defects and rework without seeing workflow metadata when practical'] },
    timing: { startedAt: null, completedAt: null, wallMs: null },
    quality: { acceptancePassed: null, defects: null, reworkEvents: null, duplicateWork: null },
    coordination: { clarificationRounds: null, handoffCount: null, recoveryEvents: null },
    efficiency: { providerTokens: null, providerCost: null, providerCurrency: null, providerUsageReason: 'Fill only from provider-reported usage; unknown stays null.' },
    review: { blinded: null, reviewer: null, notes: null },
  };
}

export function validateRealTrial(value, { requireComplete = false } = {}) {
  assert.equal(value.schemaVersion, REAL_AGENT_PROTOCOL_VERSION, 'unsupported real-agent schemaVersion');
  assert.equal(value.evidenceClass, 'real_agent');
  assert.ok(['pending', 'complete'].includes(value.status));
  assert.match(value.trialId, /^trial-[a-f0-9]{16}$/); assert.match(value.blindId, /^blind-[a-f0-9]{16}$/);
  assert.ok(WORKFLOWS.includes(value.trial.workflow));
  assert.ok(Number.isInteger(value.trial.seed) && value.trial.seed >= 0);
  assert.ok(Number.isInteger(value.trial.repeatIndex) && value.trial.repeatIndex >= 0);
  for (const key of ['hivemindRevision', 'provider', 'model', 'host', 'configuration', 'promptVersion', 'taskVersion'])
    assert.ok(typeof value.versions[key] === 'string' && value.versions[key].length > 0, `versions.${key} is required`);
  assert.ok(typeof value.runbook.prompt === 'string' && value.runbook.prompt.length > 0);
  if (requireComplete || value.status === 'complete') {
    assert.equal(value.status, 'complete');
    assert.equal(typeof value.quality.acceptancePassed, 'boolean');
    for (const key of ['defects', 'reworkEvents', 'duplicateWork']) assert.ok(Number.isInteger(value.quality[key]) && value.quality[key] >= 0, `quality.${key}`);
    for (const key of ['clarificationRounds', 'handoffCount', 'recoveryEvents']) assert.ok(Number.isInteger(value.coordination[key]) && value.coordination[key] >= 0, `coordination.${key}`);
    assert.ok(typeof value.timing.startedAt === 'string' && !Number.isNaN(Date.parse(value.timing.startedAt)), 'timing.startedAt');
    assert.ok(typeof value.timing.completedAt === 'string' && !Number.isNaN(Date.parse(value.timing.completedAt)), 'timing.completedAt');
    assert.ok(finiteOrNull(value.timing.wallMs) && value.timing.wallMs !== null, 'timing.wallMs');
    assert.ok(finiteOrNull(value.efficiency.providerTokens), 'efficiency.providerTokens');
    assert.ok(finiteOrNull(value.efficiency.providerCost), 'efficiency.providerCost');
    if (value.efficiency.providerCost !== null) assert.ok(typeof value.efficiency.providerCurrency === 'string' && value.efficiency.providerCurrency.length > 0, 'providerCurrency required with providerCost');
    assert.equal(typeof value.review.blinded, 'boolean', 'review.blinded must record what actually happened');
  }
  assert.ok(!Object.hasOwn(value, 'score') && !Object.hasOwn(value, 'winner'), 'real-agent trials must keep dimensions separate');
  return value;
}

export function prepareTrials(fixtures, config) {
  const trials = [];
  for (let repeatIndex = 0; repeatIndex < config.repeat; repeatIndex++) {
    for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
      const fixture = fixtures[fixtureIndex], order = seededShuffle(WORKFLOWS, config.seed + repeatIndex * 10_000 + fixtureIndex);
      for (const workflow of order) trials.push(trialTemplate(fixture, workflow, config.seed, repeatIndex, config));
    }
  }
  return trials;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function deterministicRandom(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state >>>= 0; state ^= state << 5; state >>>= 0; return state / 0x1_0000_0000; };
}

function describe(values, seed) {
  const xs = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null, bootstrap95: null };
  const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
  const sorted = [...xs].sort((a, b) => a - b), random = deterministicRandom(seed), samples = [];
  if (xs.length >= 2) for (let b = 0; b < 1000; b++) samples.push(mean(Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)])));
  samples.sort((a, b) => a - b);
  return { n: xs.length, mean: mean(xs), median: quantile(sorted, 0.5), min: sorted[0], max: sorted.at(-1),
    bootstrap95: xs.length >= 2 ? [quantile(samples, 0.025), quantile(samples, 0.975)] : null };
}

export function summarizeTrials(trials, seed = DEFAULT_SEED) {
  const complete = trials.filter(trial => trial.status === 'complete').map(trial => validateRealTrial(trial, { requireComplete: true }));
  const groups = new Map();
  for (const trial of complete) {
    const cohort = trial.versions;
    const cohortKey = [cohort.hivemindRevision, cohort.provider, cohort.model, cohort.host, cohort.configuration, cohort.promptVersion, cohort.taskVersion].join('|');
    const key = `${cohortKey}::${trial.fixture.id}::${trial.trial.workflow}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  const summaries = [...groups.entries()].sort().map(([key, rows], index) => {
    const [cohortKey, fixtureId, workflow] = key.split('::'); const dimensions = {};
    const [hivemindRevision, provider, model, host, configuration, promptVersion, taskVersion] = cohortKey.split('|');
    for (const [section, metric] of metrics) dimensions[`${section}.${metric}`] = describe(rows.map(row => row[section][metric]), seed + index * 97 + metric.length);
    return { cohort: { hivemindRevision, provider, model, host, configuration, promptVersion, taskVersion }, fixtureId, workflow, trials: rows.length, acceptanceRate: rows.filter(row => row.quality.acceptancePassed).length / rows.length, dimensions };
  });
  return { schemaVersion: REAL_AGENT_PROTOCOL_VERSION, evidenceClass: 'real_agent_summary', completeTrials: complete.length,
    incompleteTrials: trials.length - complete.length, summaries,
    interpretation: 'Descriptive per-dimension results only. Bootstrap intervals describe repeated trial samples; do not collapse them into one score or winner.' };
}

function args(argv) {
  const command = argv[0]; const options = { command, root: process.cwd(), input: null, output: null, provider: null, model: null, host: null,
    repeat: 3, seed: DEFAULT_SEED, hivemindRevision: null, configuration: null, promptVersion: REAL_AGENT_PROMPT_VERSION, taskVersion: REAL_AGENT_TASK_VERSION };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') options.root = path.resolve(argv[++i]);
    else if (arg === '--input') options.input = path.resolve(argv[++i]);
    else if (arg === '--output') options.output = path.resolve(argv[++i]);
    else if (arg === '--provider') options.provider = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--configuration') options.configuration = argv[++i];
    else if (arg === '--repeat') options.repeat = Number(argv[++i]);
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg === '--hivemind-revision') options.hivemindRevision = argv[++i];
    else if (arg === '--prompt-version') options.promptVersion = argv[++i];
    else if (arg === '--task-version') options.taskVersion = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function jsonFiles(dir) { return readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'manifest.json' && name !== 'summary.json').sort(); }

export function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  assert.ok(['prepare', 'validate', 'summarize'].includes(options.command), 'Use prepare, validate or summarize');
  if (options.command === 'prepare') {
    assert.ok(options.output, '--output directory is required'); assert.ok(options.provider && options.model && options.host && options.configuration, '--provider, --model, --host and --configuration are required');
    assert.ok(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 20, '--repeat must be 1..20');
    const config = { ...options, hivemindRevision: options.hivemindRevision ?? revision(options.root) };
    assert.notEqual(config.hivemindRevision, 'unknown', 'Unable to pin Hivemind revision; pass --hivemind-revision explicitly');
    const trials = prepareTrials(loadFixtures(options.root), config); mkdirSync(options.output, { recursive: true });
    for (const trial of trials) writeFileSync(path.join(options.output, `${trial.trialId}.json`), JSON.stringify(trial, null, 2) + '\n', { flag: 'wx' });
    const manifest = { schemaVersion: 1, evidenceClass: 'real_agent_manifest', seed: options.seed, repeat: options.repeat, trials: trials.map(trial => ({ trialId: trial.trialId, blindId: trial.blindId, fixtureId: trial.fixture.id, workflow: trial.trial.workflow })) };
    writeFileSync(path.join(options.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output: options.output, trials: trials.length }) + '\n'); return manifest;
  }
  assert.ok(options.input, '--input directory is required');
  const trials = jsonFiles(options.input).map(name => JSON.parse(readFileSync(path.join(options.input, name), 'utf8')));
  if (options.command === 'validate') {
    for (const trial of trials) validateRealTrial(trial); process.stdout.write(JSON.stringify({ valid: trials.length }) + '\n'); return trials;
  }
  const summary = summarizeTrials(trials, options.seed), json = JSON.stringify(summary, null, 2) + '\n';
  if (options.output) writeFileSync(options.output, json); else process.stdout.write(json); return summary;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
