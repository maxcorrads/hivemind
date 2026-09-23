import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../src/csv/parse.mjs';
import { stringifyCsv } from '../src/csv/stringify.mjs';

test('quotes only when needed', () => {
  assert.equal(stringifyCsv([['a', 'b,c', 'say "hi"', ' pad'], [1, true, null]]), 'a,"b,c","say ""hi"""," pad"\n1,true,\n');
  assert.equal(stringifyCsv([]), '');
  assert.throws(() => stringifyCsv([[{}]]), TypeError);
});

test('round-trips through parseCsv', () => {
  const rows = [['x', 'multi\nline', ''], ['"', ';', 'end ']];
  assert.deepEqual(parseCsv(stringifyCsv(rows, { newline: '\r\n' })), rows);
});
