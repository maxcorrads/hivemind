import assert from 'node:assert/strict';
import test from 'node:test';
import { allocate, format, money, percentage } from '../src/money.mjs';

test('rounds percentages half to even', () => {
  assert.equal(percentage(money(1005, 'EUR'), 10).amount, 100);
  assert.equal(percentage(money(1015, 'EUR'), 10).amount, 102);
  assert.equal(percentage(money(-1005, 'EUR'), 10).amount, -100);
});

test('allocates by largest remainder', () => {
  assert.deepEqual(allocate(money(100, 'EUR'), [1, 1, 1]).map(m => m.amount), [34, 33, 33]);
  assert.equal(format(money(-5, 'EUR')), '-0.05 EUR');
});
