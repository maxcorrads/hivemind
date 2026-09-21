import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main, measureTimelineOverhead } from './benchmark-timeline.mjs';

test('timeline overhead benchmark keeps structural bounds separate from observational timing', () => {
  const result = measureTimelineOverhead({ rows: 20, samples: 5 });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.rows, 20);
  assert.equal(result.eventsReturned, 20);
  assert.ok(result.logicalTimelineBytes > 0);
  assert.ok(result.logicalBytesPerProvenance > 0);
  assert.ok(result.writeMs.total >= 0 && result.writeMs.perMessage >= 0);
  assert.equal(result.queryMs.samples, 5);
  assert.ok(result.queryMs.p50 >= 0 && result.queryMs.p95 >= 0);
  assert.match(result.note, /not an A\/B baseline/);
});

test('timeline overhead benchmark can retain a machine observation as JSON', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-timeline-observation-'));
  try {
    const output = path.join(dir, 'observation.json');
    const result = main(['--rows', '12', '--samples', '3', '--output', output]);
    const saved = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(saved, result);
    assert.equal(saved.environment.node, process.version);
    assert.equal(saved.queryMs.samples, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
