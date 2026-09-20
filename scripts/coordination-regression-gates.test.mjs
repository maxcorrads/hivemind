import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WS_MAX_BUFFERED_BYTES, LIVE_MESSAGE_WINDOW } from '../src/shared/realtime.ts';
import { ROUTINE_BATCH_MS } from '../src/shared/notifications.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'benchmarks/coordination/v1/regression-gates.json'), 'utf8'));
const storage = JSON.parse(readFileSync(path.join(root, 'benchmarks/results/storage-scoping-v1.json'), 'utf8'));

const gate = id => {
  const found = manifest.gates.find(item => item.id === id);
  assert.ok(found, `missing regression gate ${id}`);
  return found;
};
const afterFixture = id => {
  const found = storage.after.results.find(item => item.fixture.id === id);
  assert.ok(found, `missing stored storage fixture ${id}`);
  return found;
};

test('coordination regression manifest covers every #29 optimization dependency', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(new Set(manifest.gates.map(item => item.issue)), new Set([20, 21, 27]));
  assert.ok(manifest.gates.every(item => ['ci_hard', 'investigate_only'].includes(item.enforcement)));
  assert.ok(manifest.gates.every(item => item.evidence.length > 0));
  for (const item of manifest.gates) for (const evidence of item.evidence)
    assert.ok(existsSync(path.join(root, evidence)), `missing evidence path for ${item.id}: ${evidence}`);
});

test('#20 deterministic query-count gates match retained after measurements', () => {
  const roster = gate('issue20-roster-query-count');
  const channels = gate('issue20-channel-query-count');
  assert.equal(afterFixture('foreign-agents-50000').metrics.projectRoster.statementExecutions.p95, roster.baseline);
  assert.equal(afterFixture('foreign-channels-2000').metrics.projectChannels.statementExecutions.p95, channels.baseline);
  assert.equal(roster.threshold.value, 1);
  assert.equal(channels.threshold.value, 2);
  assert.equal(gate('issue20-p95-investigate').threshold.factor, 2);
});

test('#21 bounded realtime constants match the published hard gates', () => {
  assert.equal(WS_MAX_BUFFERED_BYTES, gate('issue21-websocket-buffer-cap').baseline);
  assert.equal(LIVE_MESSAGE_WINDOW, gate('issue21-live-message-window').baseline);
  assert.equal(gate('issue21-redundant-touch-writes').threshold.value, 0);
  assert.equal(gate('issue21-heartbeat-boundary-write').threshold.value, 1);
});

test('#27 batching and deterministic wake-count thresholds stay explicit', () => {
  assert.equal(ROUTINE_BATCH_MS, gate('issue27-routine-batch-delay').baseline);
  assert.equal(gate('issue27-ack-only-model-wakes').threshold.value, 0);
  assert.equal(gate('issue27-controlled-task-model-waits').baseline, 3);
  assert.equal(gate('issue27-controlled-task-model-waits').referenceBaseline, 18);
  assert.equal(gate('issue27-controlled-task-addressed-signals').baseline, 10);
  assert.equal(gate('issue27-critical-intentional-delay').threshold.value, 0);
});
