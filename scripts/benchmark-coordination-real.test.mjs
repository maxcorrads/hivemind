import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadFixtures } from './benchmark-coordination.mjs';
import { REAL_AGENT_PROMPT_VERSION, REAL_AGENT_TASK_VERSION, main, prepareTrials, summarizeTrials, trialTemplate, validateRealTrial } from './benchmark-coordination-real.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = loadFixtures(root);
const config = { provider: 'fixture-provider', model: 'fixture-model', host: 'fixture-host', configuration: 'reasoning=medium', hivemindRevision: 'abc123',
  promptVersion: REAL_AGENT_PROMPT_VERSION, taskVersion: REAL_AGENT_TASK_VERSION, repeat: 2, seed: 29 };

function complete(trial, overrides = {}) {
  return { ...structuredClone(trial), status: 'complete',
    timing: { startedAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:00:05.000Z', wallMs: 5000 },
    quality: { acceptancePassed: true, defects: 0, reworkEvents: 1, duplicateWork: 0 },
    coordination: { clarificationRounds: 2, handoffCount: 1, recoveryEvents: 0 },
    efficiency: { providerTokens: null, providerCost: null, providerCurrency: null, providerUsageReason: 'provider did not report usage' },
    review: { blinded: true, reviewer: 'fixture-reviewer', notes: 'Reviewed artifact without workflow label.' }, ...overrides };
}

test('real-agent preparation is deterministic, balanced and never invents provider usage', () => {
  const first = prepareTrials(fixtures, config), second = prepareTrials(fixtures, config);
  assert.deepEqual(second, first);
  assert.equal(first.length, fixtures.length * 4 * config.repeat);
  assert.equal(new Set(first.map(trial => trial.trialId)).size, first.length);
  assert.equal(new Set(first.map(trial => trial.blindId)).size, first.length);
  for (const fixture of fixtures) for (let repeat = 0; repeat < config.repeat; repeat++) {
    const rows = first.filter(trial => trial.fixture.id === fixture.id && trial.trial.repeatIndex === repeat);
    assert.deepEqual(new Set(rows.map(trial => trial.trial.workflow)), new Set(['single_worker', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room']));
  }
  assert.ok(first.every(trial => trial.efficiency.providerTokens === null && trial.efficiency.providerCost === null));
  assert.ok(first.every(trial => !Object.hasOwn(trial, 'score') && !Object.hasOwn(trial, 'winner')));
});

test('workflow prompts preserve the same fixture while changing only coordination instructions', () => {
  const fixture = fixtures[0];
  const single = trialTemplate(fixture, 'single_worker', 29, 0, config);
  const room = trialTemplate(fixture, 'brain_multi_room', 29, 0, config);
  assert.equal(single.fixture.id, room.fixture.id);
  assert.match(single.runbook.prompt, /Do not delegate/);
  assert.match(room.runbook.prompt, /collaboration room/);
  for (const task of fixture.tasks) {
    assert.match(single.runbook.prompt, new RegExp(task.id));
    assert.match(room.runbook.prompt, new RegExp(task.id));
  }
  assert.notEqual(single.trialId, room.trialId);
});

test('validation fails closed on incomplete or fabricated usage and accepts an explicit complete trial', () => {
  const pending = trialTemplate(fixtures[0], 'brain_one_worker', 29, 0, config);
  assert.equal(validateRealTrial(pending), pending);
  assert.throws(() => validateRealTrial(pending, { requireComplete: true }));
  const done = complete(pending);
  assert.equal(validateRealTrial(done, { requireComplete: true }), done);
  const negativeTokens = complete(pending); negativeTokens.efficiency.providerTokens = -1;
  assert.throws(() => validateRealTrial(negativeTokens, { requireComplete: true }), /providerTokens/);
  const priced = complete(pending); priced.efficiency.providerCost = 1.25; priced.efficiency.providerCurrency = null;
  assert.throws(() => validateRealTrial(priced, { requireComplete: true }), /providerCurrency/);
});

test('summary keeps dimensions separate and reports deterministic repeated-trial uncertainty', () => {
  const base = trialTemplate(fixtures[0], 'brain_one_worker', 29, 0, config);
  const rows = [
    complete(base),
    complete({ ...structuredClone(base), trialId: 'trial-1111111111111111', blindId: 'blind-1111111111111111', trial: { ...base.trial, repeatIndex: 1 } },
      { timing: { startedAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:00:07.000Z', wallMs: 7000 }, quality: { acceptancePassed: false, defects: 2, reworkEvents: 3, duplicateWork: 1 } }),
    trialTemplate(fixtures[1], 'single_worker', 29, 0, config),
  ];
  const one = summarizeTrials(rows, 29), two = summarizeTrials(rows, 29);
  assert.deepEqual(two, one);
  assert.equal(one.completeTrials, 2); assert.equal(one.incompleteTrials, 1);
  const group = one.summaries[0]; assert.equal(group.acceptanceRate, 0.5);
  assert.equal(group.dimensions['timing.wallMs'].median, 6000);
  assert.ok(Array.isArray(group.dimensions['timing.wallMs'].bootstrap95));
  assert.ok(!Object.hasOwn(one, 'score') && !Object.hasOwn(one, 'winner'));
});

test('CLI prepare, validate and summarize round-trip version-pinned trial templates', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-real-benchmark-'));
  try {
    const out = path.join(dir, 'trials');
    main(['prepare', '--root', root, '--output', out, '--provider', 'fixture-provider', '--model', 'fixture-model', '--host', 'fixture-host',
      '--configuration', 'reasoning=medium', '--repeat', '1', '--seed', '29', '--hivemind-revision', 'deadbeef']);
    const files = readdirSync(out).filter(name => name.startsWith('trial-'));
    assert.equal(files.length, fixtures.length * 4);
    const firstPath = path.join(out, files[0]), first = JSON.parse(readFileSync(firstPath, 'utf8'));
    assert.equal(first.versions.hivemindRevision, 'deadbeef');
    writeFileSync(firstPath, JSON.stringify(complete(first), null, 2) + '\n');
    const validated = main(['validate', '--input', out]); assert.equal(validated.length, files.length);
    const summary = main(['summarize', '--input', out, '--seed', '29']);
    assert.equal(summary.completeTrials, 1); assert.equal(summary.incompleteTrials, files.length - 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
