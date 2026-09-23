// Proves the study-v1 acceptance checks (#29) are discriminative before any paid trial: each passes its reference
// solution, fails an empty workspace and reports partial defects for a deliberately broken variant. Acceptance runs
// exactly as the runner invokes it: an extensionless copy, `node <acceptance> <workspace>`, only PATH in env.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const study = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../benchmarks/topology/study-v1');
const plan = JSON.parse(readFileSync(path.join(study, 'plan.json'), 'utf8'));

/** Deliberately broken variants: one realistic mistake each, so only part of the hidden suite should fail. */
const BROKEN = {
  'small-duration': { file: 'src/duration.mjs', from: 'if (rank <= lastRank)', to: 'if (rank < lastRank)', expect: 'hidden:order-and-duplicates' },
  'medium-csv': { file: 'src/csv/stringify.mjs', from: " || text.startsWith(' ') || text.endsWith(' ')", to: '', expect: 'hidden:stringify-quoting-rules' },
  'large-parallel-toolkit': { file: 'src/roman.mjs', from: "text === '' || !CANONICAL.test(text)", to: "text === ''", expect: 'hidden:roman-from-invalid' },
  // Coupled: a wrong rounding rule in the shared money module also breaks a dependent module (tax).
  'large-coupled-invoicing': { file: 'src/money.mjs', from: 'return money(divideHalfEven(m.amount * percent, 100), m.currency);',
    to: 'return money(Math.round((m.amount * percent) / 100), m.currency);', expect: 'hidden:tax-lines-and-categories' },
};

function treeDigest(dir) {
  const hash = createHash('sha256');
  const walk = rel => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(file).update(readFileSync(path.join(dir, file)));
    }
  };
  walk('.');
  return hash.digest('hex');
}

async function accept(acceptance, workspace) {
  const started = Date.now();
  const { stdout } = await run(process.execPath, [acceptance, workspace], { cwd: workspace, env: { PATH: process.env.PATH ?? '' }, timeout: 120_000 });
  const lines = stdout.trim().split('\n');
  return { verdict: JSON.parse(lines.at(-1)), detail: JSON.parse(lines.at(-2)), ms: Date.now() - started };
}

test('the plan ships only the request and acceptance artifacts to seats', () => {
  assert.deepEqual(plan.workloads.map(w => w.id), Object.keys(BROKEN));
  for (const w of plan.workloads) {
    assert.deepEqual(Object.keys(w).sort(), ['acceptance', 'id', 'input']);
    assert.equal(w.input, `workloads/${w.id}/request.txt`);
    assert.equal(w.acceptance, `workloads/${w.id}/acceptance.mjs`);
    assert.ok(!readFileSync(path.join(study, w.input), 'utf8').includes('reference'), 'request must not point at the reference solution');
  }
});

for (const w of plan.workloads) {
  test(`acceptance for ${w.id} passes the reference, fails empty and counts partial defects`, async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'hm-study-v1-proof-'));
    try {
      // The runner copies the check as `workloads/<dir>/acceptance`, with no extension and no package.json nearby.
      const acceptance = path.join(tmp, 'acceptance');
      writeFileSync(acceptance, readFileSync(path.join(study, w.acceptance)));
      const reference = path.join(tmp, 'reference'), empty = path.join(tmp, 'empty'), broken = path.join(tmp, 'broken');
      cpSync(path.join(study, 'workloads', w.id, 'reference'), reference, { recursive: true });
      cpSync(reference, broken, { recursive: true });
      mkdirSync(empty);
      const mutation = BROKEN[w.id], target = path.join(broken, mutation.file), source = readFileSync(target, 'utf8');
      assert.ok(source.includes(mutation.from), `mutation anchor missing in ${mutation.file}`);
      writeFileSync(target, source.replace(mutation.from, mutation.to));

      const before = treeDigest(reference);
      const [ref, none, bad] = await Promise.all([accept(acceptance, reference), accept(acceptance, empty), accept(acceptance, broken)]);
      assert.equal(treeDigest(reference), before, 'acceptance must not modify the workspace');

      assert.deepEqual(ref.verdict, { passed: true, defects: 0 });
      assert.ok(ref.detail.hiddenCases >= 15 && ref.detail.hiddenPassed === ref.detail.hiddenCases);
      assert.equal(none.verdict.passed, false);
      assert.ok(none.verdict.defects > none.detail.hiddenCases, 'empty workspace fails every hidden case and the missing tests');
      assert.equal(none.detail.hiddenPassed, 0);
      assert.equal(bad.verdict.passed, false);
      assert.ok(bad.verdict.defects > 0 && bad.verdict.defects < ref.detail.hiddenCases / 2, `broken variant should be partial: ${bad.verdict.defects}`);
      assert.ok(bad.detail.failures.includes(mutation.expect), `expected ${mutation.expect} in ${bad.detail.failures}`);
      for (const r of [ref, none, bad]) assert.ok(r.ms < 100_000, 'acceptance must stay within the host acceptance timeout');
      console.log(JSON.stringify({ workload: w.id, hiddenCases: ref.detail.hiddenCases, reference: ref.verdict, empty: none.verdict,
        broken: { ...bad.verdict, failures: bad.detail.failures } }));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}
