import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CONDITIONS,
  DEFAULT_HUMAN_DECISION_REPEAT,
  loadHumanDecisionCases,
  main,
  prepareHumanDecisionTrials,
  summarizeHumanDecisionTrials,
  trialTemplate,
  validateHumanDecisionTrial,
} from './benchmark-human-decisions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = {
  hivemindRevision: 'abc123',
  participantCohort: 'fixture-humans',
  seed: 34,
  repeat: DEFAULT_HUMAN_DECISION_REPEAT,
};

function complete(trial, answerKey, overrides = {}) {
  return {
    ...structuredClone(trial),
    status: 'complete',
    timing: {
      startedAt: '2026-09-21T10:00:00.000Z',
      completedAt: '2026-09-21T10:00:05.000Z',
      handlingWallMs: 5000,
      blockerToDecisionMs: 8000,
    },
    response: {
      action: answerKey.action,
      selectedOptionId: answerKey.optionId,
      answerText: answerKey.action === 'answer' ? 'Selected the visible option.' : 'Request is stale or expired.',
      taskId: answerKey.taskId,
      taskRevision: answerKey.taskRevision,
      evidenceRefs: ['seq:1'],
    },
    observations: {
      repeatedQuestionCount: 0,
      unrelatedContextsOpened: 0,
    },
    review: {
      supportedByEvidence: true,
      blinded: true,
      reviewer: 'fixture-reviewer',
      notes: 'Reviewed without the manifest condition label.',
    },
    ...overrides,
  };
}

test('Human decision cases cover current, superseded, related and expired request shapes', () => {
  const cases = loadHumanDecisionCases(root);
  assert.equal(cases.length, 4);
  assert.deepEqual(new Set(cases.map(item => item.id)), new Set([
    'current-compatibility-boundary',
    'superseded-task-revision',
    'related-distinct-questions',
    'expired-recommendation',
  ]));
  assert.equal(cases.filter(item => item.answerKey.action === 'do_not_apply').length, 2);
});

test('preparation is deterministic, paired and keeps answer keys out of participant packets', () => {
  const cases = loadHumanDecisionCases(root);
  const first = prepareHumanDecisionTrials(cases, config);
  const second = prepareHumanDecisionTrials(cases, config);
  assert.deepEqual(second, first);
  assert.equal(first.length, cases.length * CONDITIONS.length * config.repeat);
  assert.equal(new Set(first.map(entry => entry.trial.trialId)).size, first.length);
  for (const item of cases) for (let repeatIndex = 0; repeatIndex < config.repeat; repeatIndex++) {
    const rows = first.filter(entry => entry.manifest.fixtureId === item.id &&
      entry.manifest.repeatIndex === repeatIndex);
    assert.deepEqual(new Set(rows.map(entry => entry.manifest.condition)), new Set(CONDITIONS));
  }
  for (const entry of first) {
    const packet = JSON.stringify(entry.trial);
    assert.doesNotMatch(packet, /"answerKey"|"condition"|"fixtureId"/);
    assert.ok(['mentions', 'decision_queue'].includes(entry.trial.runbook.view.mode));
  }
});

test('validation requires measured timing, explicit context and review evidence', () => {
  const item = loadHumanDecisionCases(root)[0];
  const pending = trialTemplate(item, 'decision_queue', 34, 0, config);
  assert.equal(validateHumanDecisionTrial(pending), pending);
  assert.throws(() => validateHumanDecisionTrial(pending, { requireComplete: true }));
  const done = complete(pending, item.answerKey);
  assert.equal(validateHumanDecisionTrial(done, { requireComplete: true }), done);

  const tooFastBlocker = complete(pending, item.answerKey);
  tooFastBlocker.timing.blockerToDecisionMs = 4000;
  assert.throws(() => validateHumanDecisionTrial(tooFastBlocker, { requireComplete: true }),
    /blockerToDecisionMs/);

  const aborted = { ...structuredClone(pending), status: 'aborted', abortReason: 'Participant interrupted.' };
  assert.equal(validateHumanDecisionTrial(aborted), aborted);
});

test('summary derives objective decision/context safety and keeps paired dimensions separate', () => {
  const item = loadHumanDecisionCases(root)[0];
  const entries = prepareHumanDecisionTrials([item], { ...config, repeat: 2 });
  const manifest = {
    schemaVersion: 1,
    evidenceClass: 'human_decision_manifest',
    seed: 34,
    repeat: 2,
    versions: entries[0].trial.versions,
    trials: entries.map(entry => entry.manifest),
  };
  const trials = entries.map((entry, index) => {
    const queue = entry.manifest.condition === 'decision_queue';
    return complete(entry.trial, entry.manifest.answerKey, {
      timing: {
        startedAt: '2026-09-21T10:00:00.000Z',
        completedAt: '2026-09-21T10:00:10.000Z',
        handlingWallMs: queue ? 3000 + index : 6000 + index,
        blockerToDecisionMs: queue ? 7000 + index : 10000 + index,
      },
      observations: {
        repeatedQuestionCount: queue ? 0 : 1,
        unrelatedContextsOpened: queue ? 0 : 2,
      },
    });
  });
  const one = summarizeHumanDecisionTrials(trials, manifest, 34);
  const two = summarizeHumanDecisionTrials(trials, manifest, 34);
  assert.deepEqual(two, one);
  assert.equal(one.completeTrials, 4);
  assert.equal(one.incompleteTrials, 0);
  assert.equal(one.summaries.length, 2);
  assert.equal(one.pairedComparisons.length, 2);
  assert.ok(one.pairedComparisons.every(pair => pair.decisionQueueMinusMentionsHandlingWallMs < 0));
  assert.ok(one.pairedComparisons.every(pair => pair.decisionQueueMinusMentionsRepeatedQuestions < 0));
  assert.ok(!Object.hasOwn(one, 'score') && !Object.hasOwn(one, 'winner'));
});

test('wrong-context answer is reported without turning the benchmark into a score', () => {
  const item = loadHumanDecisionCases(root)[0];
  const entries = prepareHumanDecisionTrials([item], { ...config, repeat: 1 });
  const manifest = {
    schemaVersion: 1,
    evidenceClass: 'human_decision_manifest',
    seed: 34,
    repeat: 1,
    versions: entries[0].trial.versions,
    trials: entries.map(entry => entry.manifest),
  };
  const trials = entries.map(entry => {
    const done = complete(entry.trial, entry.manifest.answerKey);
    if (entry.manifest.condition === 'mentions') done.response.taskRevision = 2;
    return done;
  });
  const summary = summarizeHumanDecisionTrials(trials, manifest, 34);
  const mentions = summary.summaries.find(row => row.condition === 'mentions');
  const queue = summary.summaries.find(row => row.condition === 'decision_queue');
  assert.equal(mentions.wrongContextAnswerRate, 1);
  assert.equal(queue.wrongContextAnswerRate, 0);
});

test('CLI prepare, validate and summarize round-trip a 16-trial default cohort', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-human-decisions-'));
  try {
    const out = path.join(dir, 'trials');
    const manifest = main([
      'prepare', '--root', root, '--output', out,
      '--participant-cohort', 'fixture-humans',
      '--hivemind-revision', 'deadbeef',
    ]);
    const files = readdirSync(out).filter(name => name.startsWith('trial-'));
    assert.equal(files.length, 16);
    assert.equal(manifest.trials.length, 16);
    const firstPath = path.join(out, files[0]);
    const first = JSON.parse(readFileSync(firstPath, 'utf8'));
    const row = manifest.trials.find(item => item.trialId === first.trialId);
    writeFileSync(firstPath, JSON.stringify(complete(first, row.answerKey), null, 2) + '\n');
    const validated = main(['validate', '--input', out]);
    assert.equal(validated.length, 16);
    const summaryPath = path.join(dir, 'summary.json');
    const summary = main(['summarize', '--input', out, '--output', summaryPath]);
    assert.equal(summary.completeTrials, 1);
    assert.equal(summary.incompleteTrials, 15);
    assert.deepEqual(JSON.parse(readFileSync(summaryPath, 'utf8')), summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
