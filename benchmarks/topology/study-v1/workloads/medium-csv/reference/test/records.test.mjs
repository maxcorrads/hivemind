import assert from 'node:assert/strict';
import test from 'node:test';
import { fromRecords, toRecords } from '../src/csv/records.mjs';

test('converts typed columns', () => {
  const rows = [['name', 'age', 'admin'], ['Ada', ' 36 ', 'TRUE'], ['Bob', '', 'false']];
  assert.deepEqual(toRecords(rows, { types: { age: 'integer', admin: 'boolean' } }),
    [{ name: 'Ada', age: 36, admin: true }, { name: 'Bob', age: null, admin: false }]);
  assert.throws(() => toRecords([['a'], ['1', '2']]), /row 2/);
  assert.throws(() => toRecords([['a', 'a']]), SyntaxError);
});

test('builds rows from records', () => {
  assert.deepEqual(fromRecords([{ a: 1, b: null }]), [['a', 'b'], ['1', '']]);
  assert.deepEqual(fromRecords([]), []);
});
