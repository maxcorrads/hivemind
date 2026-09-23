import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, parse, satisfies } from '../src/semver.mjs';

test('parses and compares', () => {
  assert.deepEqual(parse('1.2.3-alpha.1+b'), { major: 1, minor: 2, patch: 3, prerelease: ['alpha', 1] });
  assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
  assert.throws(() => parse('01.2.3'), TypeError);
});

test('matches ranges', () => {
  assert.equal(satisfies('1.4.0', '^1.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('1.2.4-beta', '>=1.2.0'), false);
});
