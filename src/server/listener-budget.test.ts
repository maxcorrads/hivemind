import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./serve.ts";

test('invalid listener ports fail before creating an owned database or timers', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-invalid-port-'));
  const home = path.join(dir, 'not-created');
  const previous = process.env.HIVEMIND_HOME;
  process.env.HIVEMIND_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HIVEMIND_HOME;
    else process.env.HIVEMIND_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const port of [-1, NaN, Infinity, 1.5, 65536])
    assert.throws(() => startServer({ port, telegram: false }), /integer|Invalid request/);
  assert.equal(existsSync(home), false);
});
