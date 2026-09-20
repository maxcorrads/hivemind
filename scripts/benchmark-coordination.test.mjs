import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { REQUIRED_EXERCISES, WORKFLOWS, coverage, loadFixtures, main, runMatrix, runSyntheticTrial, seededShuffle } from './benchmark-coordination.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('coordination fixtures are versioned, bounded and cover the phase-1 coordination surface', () => {
  const fixtures = loadFixtures(root);
  assert.ok(fixtures.length >= 3 && fixtures.length <= 8);
  assert.deepEqual(coverage(fixtures), Object.fromEntries(REQUIRED_EXERCISES.map(feature => [feature, true])));
  assert.equal(new Set(fixtures.map(fixture => fixture.id)).size, fixtures.length);
});

test('synthetic trials are deterministic, keep provider usage unknown and never emit a single score', () => {
  const fixture = loadFixtures(root)[0];
  for (const workflow of WORKFLOWS) {
    const first = runSyntheticTrial(fixture, workflow, 29, 0);
    const second = runSyntheticTrial(fixture, workflow, 29, 0);
    assert.deepEqual(second, first);
    assert.equal(first.evidenceClass, 'synthetic_contract');
    assert.equal(first.efficiency.providerTokens, null);
    assert.equal(first.efficiency.providerCost, null);
    assert.ok(!Object.hasOwn(first, 'score'));
    assert.ok(first.warning.includes('not evidence'));
  }
});

test('matrix randomizes workflow order reproducibly without changing the comparison set', () => {
  const fixtures = loadFixtures(root).slice(0, 2);
  const first = runMatrix(fixtures, { seed: 29, repeat: 2 });
  const second = runMatrix(fixtures, { seed: 29, repeat: 2 });
  assert.deepEqual(second, first);
  assert.equal(first.trials.length, fixtures.length * WORKFLOWS.length * 2);
  assert.deepEqual(new Set(first.trials.map(trial => trial.trial.workflow)), new Set(WORKFLOWS));
  assert.deepEqual(seededShuffle(WORKFLOWS, 29), seededShuffle(WORKFLOWS, 29));
  assert.notDeepEqual(seededShuffle(WORKFLOWS, 29), seededShuffle(WORKFLOWS, 30));
});

test('CLI writes a reusable JSON result artifact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-coordination-bench-'));
  try {
    const output = path.join(dir, 'result.json');
    const report = main(['--root', root, '--fixture', 'blocked-worker-recovery', '--workflow', 'brain_one_worker', '--output', output]);
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(saved, report);
    assert.equal(saved.fixture.id, 'blocked-worker-recovery');
    assert.equal(saved.coordination.handoffCount, 1);
    assert.ok(saved.coordination.recoveryTicks > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
