import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixtures, summary, measureFixture } from './benchmark-storage-matrix.mjs';
import { Hive } from '../src/server/hive.ts';
import { createApp } from '../src/server/app.ts';

test('storage benchmark varies one dimension at a time and reports honest descriptive quantiles', () => {
  assert.equal(fixtures.length, 9);
  for (const fixture of fixtures.slice(1)) {
    assert.equal(Object.keys(fixture).filter(key => key !== 'id' && fixture[key] !== fixtures[0][key]).length, 1);
  }
  const samples = [4, 1, 2, 3];
  assert.deepEqual(summary(samples), { samples: 4, p50: 2, p95: 4, min: 1, max: 4, raw: samples });
  assert.deepEqual(samples, [4, 1, 2, 3]);
  for (const invalid of [[], [NaN], [Infinity], [-1]]) assert.throws(() => summary(invalid));
});

test('current storage benchmark uses isolated fixtures, exact delivery and explicit unknown scan counts', { timeout: 15_000 }, async () => {
  const sample = await measureFixture(Hive, createApp, { ...fixtures[0], messages: 2, foreignBacklog: 3 }, 2);
  assert.equal(sample.metrics.projectRoster.statementExecutions.max, 1);
  assert.equal(sample.metrics.projectChannels.statementExecutions.max, 2);
  for (const metric of Object.values(sample.metrics)) assert.equal(metric.rowsExamined, null);
  assert.equal(sample.metrics.delivery.logicalDrainMs.samples, 2);
  assert.ok(sample.metrics.delivery.responseBytes.max > 0);
  assert.ok(sample.metrics.humanSnapshot.serializedBytes.max > 0);
});

test('retained comparison keeps complete fixture metadata and unknown counters without cost claims', () => {
  const data = JSON.parse(readFileSync(new URL('../benchmarks/results/storage-scoping-v1.json', import.meta.url), 'utf8'));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.before.sourceCommit, '977c571a8749468e64ad7e52e7796d4c0f481fb1');
  assert.equal(data.after.sourceCommit, '2f4477d649662ccc3a502c9916fa178053a35bf8');
  for (const phase of ['before', 'after']) {
    assert.deepEqual(data[phase].results.map(row => row.fixture), fixtures);
    for (const row of data[phase].results) for (const metric of Object.values(row.metrics)) {
      if (metric.omitted) continue;
      assert.equal(metric.rowsExamined, null);
      for (const value of Object.values(metric)) if (value?.raw) {
        assert.equal(value.samples, value.raw.length);
        assert.ok(value.raw.length >= 12);
        assert.ok(value.min <= value.p50 && value.p50 <= value.p95 && value.p95 <= value.max);
      }
    }
  }
  assert.equal(data.after.results.find(row => row.fixture.id === 'foreign-agents-50000').metrics.projectRoster.statementExecutions.max, 1);
  assert.equal(data.ftsProbe.compileOptionEnableFts5, false);
});
