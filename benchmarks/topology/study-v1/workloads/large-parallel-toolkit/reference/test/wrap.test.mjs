import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapText } from '../src/wrap.mjs';

test('fills greedily and splits long words', () => {
  assert.equal(wrapText('The quick brown fox', 10), 'The quick\nbrown fox');
  assert.equal(wrapText('abcdefghij xy', 4), 'abcd\nefgh\nij\nxy');
  assert.equal(wrapText('a\n\n  \nb', 5), 'a\n\nb');
});
