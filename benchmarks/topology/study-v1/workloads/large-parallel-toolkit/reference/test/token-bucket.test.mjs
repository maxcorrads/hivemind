import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenBucket } from '../src/token-bucket.mjs';

test('refills over time', () => {
  let t = 0;
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => t });
  assert.equal(bucket.tryRemove(2), true);
  assert.equal(bucket.tryRemove(), false);
  assert.equal(bucket.msUntilAvailable(), 1000);
  t = 500;
  assert.equal(bucket.available(), 0.5);
});
