// The live host of the paired topology study is legacy since #211 (Jev is advisory-only; nothing enforces a fixed
// topology any more). It refuses to run trials; the runner's credential-free actions still work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHivemindHost, LEGACY_HOST_MESSAGE, liveUsage } from './topology-study-host.mjs';

test('the live host refuses to run: fixed topologies are no longer enforced (#211)', () => {
  assert.throws(() => createHivemindHost({}), new RegExp(LEGACY_HOST_MESSAGE.slice(0, 60).replace(/[()]/g, '\\$&')));
  assert.match(LEGACY_HOST_MESSAGE, /removed in #211/);
  assert.match(LEGACY_HOST_MESSAGE, /release before #211/);
});

test('live usage keeps the latest cumulative seat total while the seat is running', () => {
  const usage = liveUsage();
  usage.push(Buffer.from('{"type":"step_finish","part":{"tokens":{"total":12}}}\n{"type":"step_'));
  assert.equal(usage.latest(), 12);
  usage.push(Buffer.from('finish","part":{"tokens":{"total":30}}}\nnot json\n'));
  assert.equal(usage.latest(), 30); assert.equal(usage.finish(), 30);
});
