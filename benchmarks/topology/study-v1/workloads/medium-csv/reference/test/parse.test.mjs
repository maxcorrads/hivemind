import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../src/csv/parse.mjs';

test('parses quoted fields and separators', () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"x ""y""",z\n'), [['a', 'b,c'], ['x "y"', 'z']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']]);
});

test('rejects malformed quotes', () => {
  assert.throws(() => parseCsv('a"b'), SyntaxError);
  assert.throws(() => parseCsv('"ab'), SyntaxError);
  assert.throws(() => parseCsv('"a"b'), SyntaxError);
  assert.throws(() => parseCsv('a', { delimiter: '"' }), RangeError);
});
