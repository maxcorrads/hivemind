import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { replayTimeline } from '../src/shared/timeline.ts';
import {
  CONDITIONS,
  DEFAULT_DIAGNOSIS_REPEAT,
  baselineEvidence,
  loadDiagnosisCases,
  main,
  prepareDiagnosisTrials,
  summarizeDiagnosisTrials,
  trialTemplate,
  validateDiagnosisTrial,
} from './benchmark-timeline-diagnosis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = {
  provider: 'fixture-provider',
  model: 'fixture-model',
  host: 'fixture-host',
  configuration: 'reasoning=medium',
  hivemindRevision: 'abc123',
  seed: 32,
  repeat: DEFAULT_DIAGNOSIS_REPEAT,
};

function complete(trial, overrides = {}) {
  return {
    ...structuredClone(trial),
    status: 'complete',
    timing: {
      startedAt: '2026-09-21T08:00:00.000Z',
      completedAt: '2026-09-21T08:00:05.000Z',
      wallMs: 5000,
    },
    diagnosis: {
      text: 'The supplied evidence identifies the recoverable failure point.',
      evidenceRefs: ['seq:1', 'event:delivery-1'],
      clarificationRounds: 0,
    },
    efficiency: {
      providerTokens: null,
      providerCost: null,
      providerCurrency: null,
      providerUsageReason: 'provider did not report usage',
    },
    review: {
      correct: true,
      supportedByEvidence: true,
      blinded: true,
      reviewer: 'fixture-reviewer',
      notes: 'Reviewed without the condition label.',
    },
    ...overrides,
  };
}

test('diagnosis cases are redacted replay fixtures tied to #29 scenario families', () => {
  const cases = loadDiagnosisCases(root);
  assert.equal(cases.length, 3);
  assert.deepEqual(new Set(cases.map(item => item.sourceCoordinationFixture)),
    new Set(['offline-dropped-delivery', 'noisy-room', 'reviewer-disagreement']));
  for (const item of cases) {
    const replay = replayTimeline(item.timeline);
    assert.equal(replay.traceId, item.timeline.traceId);
    const serialized = JSON.stringify(item.timeline);
    assert.doesNotMatch(serialized, /authorName|agentName|"body"\s*:|"secret"\s*:/i);
  }
});

test('baseline condition preserves message/thread evidence but removes timeline-only provenance', () => {
  const item = loadDiagnosisCases(root)[0];
  const baseline = baselineEvidence(item.timeline);
  assert.equal(baseline.mode, 'baseline-redacted');
  assert.ok(baseline.events.length > 0);
  assert.ok(baseline.events.every(event => event.kind === 'message'));
  const serialized = JSON.stringify(baseline);
  assert.doesNotMatch(serialized, /wakeReason|deliveryId|"source"|explicit/);
  assert.match(serialized, /inferredThreadParentMessageId/);
});

test('preparation is deterministic, paired, balanced and participant packets omit the answer key', () => {
  const cases = loadDiagnosisCases(root);
  const first = prepareDiagnosisTrials(cases, config), second = prepareDiagnosisTrials(cases, config);
  assert.deepEqual(second, first);
  assert.equal(first.length, cases.length * CONDITIONS.length * config.repeat);
  assert.equal(new Set(first.map(entry => entry.trial.trialId)).size, first.length);
  for (const item of cases) for (let repeatIndex = 0; repeatIndex < config.repeat; repeatIndex++) {
    const rows = first.filter(entry => entry.manifest.fixtureId === item.id && entry.manifest.repeatIndex === repeatIndex);
    assert.deepEqual(new Set(rows.map(entry => entry.manifest.condition)), new Set(CONDITIONS));
  }
  for (const entry of first) {
    const packet = JSON.stringify(entry.trial);
    assert.doesNotMatch(packet, /groundTruth|sourceCoordinationFixture|"condition"|"fixtureId"/);
    assert.ok(entry.trial.efficiency.providerTokens === null && entry.trial.efficiency.providerCost === null);
  }
});

test('validation records real timing/review fields and never fabricates provider usage', () => {
  const pending = trialTemplate(loadDiagnosisCases(root)[0], 'timeline', 32, 0, config);
  assert.equal(validateDiagnosisTrial(pending), pending);
  assert.throws(() => validateDiagnosisTrial(pending, { requireComplete: true }));
  const done = complete(pending);
  assert.equal(validateDiagnosisTrial(done, { requireComplete: true }), done);
  const bad = complete(pending);
  bad.efficiency.providerTokens = -1;
  assert.throws(() => validateDiagnosisTrial(bad, { requireComplete: true }), /providerTokens/);
});

test('summary keeps conditions separate and exposes only descriptive paired wall-time deltas', () => {
  const cases = loadDiagnosisCases(root);
  const entries = prepareDiagnosisTrials(cases.slice(0, 1), { ...config, repeat: 2 });
  const manifest = {
    schemaVersion: 1,
    evidenceClass: 'timeline_diagnosis_manifest',
    seed: 32,
    repeat: 2,
    versions: entries[0].trial.versions,
    trials: entries.map(entry => entry.manifest),
  };
  const trials = entries.map((entry, index) => complete(entry.trial, {
    timing: {
      startedAt: '2026-09-21T08:00:00.000Z',
      completedAt: '2026-09-21T08:00:10.000Z',
      wallMs: entry.manifest.condition === 'timeline' ? 4000 + index : 7000 + index,
    },
  }));
  const one = summarizeDiagnosisTrials(trials, manifest, 32), two = summarizeDiagnosisTrials(trials, manifest, 32);
  assert.deepEqual(two, one);
  assert.equal(one.completeTrials, 4);
  assert.equal(one.incompleteTrials, 0);
  assert.equal(one.summaries.length, 2);
  assert.equal(one.pairedComparisons.length, 2);
  assert.ok(one.pairedComparisons.every(pair => pair.timelineMinusBaselineWallMs < 0));
  assert.ok(!Object.hasOwn(one, 'score') && !Object.hasOwn(one, 'winner'));
});

test('CLI prepare, validate and summarize round-trip a 12-trial default cohort', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-timeline-diagnosis-'));
  try {
    const out = path.join(dir, 'trials');
    const manifest = main([
      'prepare', '--root', root, '--output', out,
      '--provider', 'fixture-provider', '--model', 'fixture-model', '--host', 'fixture-host',
      '--configuration', 'reasoning=medium', '--hivemind-revision', 'deadbeef',
    ]);
    const files = readdirSync(out).filter(name => name.startsWith('trial-'));
    assert.equal(files.length, 12);
    assert.equal(manifest.trials.length, 12);
    const firstPath = path.join(out, files[0]);
    const first = JSON.parse(readFileSync(firstPath, 'utf8'));
    writeFileSync(firstPath, JSON.stringify(complete(first), null, 2) + '\n');
    const validated = main(['validate', '--input', out]);
    assert.equal(validated.length, 12);
    const summaryPath = path.join(dir, 'summary.json');
    const summary = main(['summarize', '--input', out, '--output', summaryPath]);
    assert.equal(summary.completeTrials, 1);
    assert.equal(summary.incompleteTrials, 11);
    assert.deepEqual(JSON.parse(readFileSync(summaryPath, 'utf8')), summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
