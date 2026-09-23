import assert from 'node:assert/strict';
import test from 'node:test';
import { LRUCache } from '../src/lru-cache.mjs';

test('evicts the least recently used entry', () => {
  const evicted = [];
  const cache = new LRUCache({ maxEntries: 2, onEvict: (k, v) => evicted.push([k, v]) });
  cache.set('a', 1).set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.deepEqual(cache.keys(), ['c', 'a']);
  assert.deepEqual(evicted, [['b', 2]]);
  assert.throws(() => new LRUCache({ maxEntries: 0 }), RangeError);
});
