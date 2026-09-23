import assert from 'node:assert/strict';
import test from 'node:test';
import { fromRoman, toRoman } from '../src/roman.mjs';

test('round-trips canonical numerals', () => {
  assert.equal(toRoman(1994), 'MCMXCIV');
  for (let n = 1; n <= 3999; n++) assert.equal(fromRoman(toRoman(n)), n);
  assert.throws(() => fromRoman('IIII'), SyntaxError);
});
