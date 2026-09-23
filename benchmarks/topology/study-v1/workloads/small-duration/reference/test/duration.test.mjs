import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../src/duration.mjs';

test('parses components in descending order', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration(' 2d 4h '), 187_200_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('1m 0.5s'), 60_500);
});

test('rejects invalid input', () => {
  assert.throws(() => parseDuration(5), TypeError);
  for (const bad of ['', '30m1h', '1m1m', '1 h', '-1s', '1h 30']) assert.throws(() => parseDuration(bad), RangeError, bad);
});
