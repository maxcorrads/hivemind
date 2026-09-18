import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverTests } from './run-tests.mjs';

test('discovery includes nested TS and TSX tests and excludes non-tests', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hive-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'nested'));
  for (const file of ['a.test.ts', 'nested/b.test.tsx', 'c.tsx', 'd.test.ts.disabled']) {
    writeFileSync(path.join(root, file), '');
  }
  assert.deepEqual(discoverTests(root), [path.join(root, 'a.test.ts'), path.join(root, 'nested/b.test.tsx')]);
  assert.deepEqual(discoverTests(path.join(root, 'missing')), []);
});
