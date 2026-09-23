// study-v1 acceptance: small-duration. Usage: node acceptance.mjs <workspace>
// Prints {"passed": boolean, "defects": integer} on the last stdout line and exits 0 (non-zero only on a harness bug).
// Self-contained on purpose: the runner copies this file without its extension, so it uses no static imports and
// works as either module type. Hidden tests are written to a temporary directory, never into the workspace.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { randomUUID } = process.getBuiltinModule('node:crypto');

const REQUIRED_TEST_FILES = ['test/duration.test.mjs'];
const HIDDEN_TIMEOUT_MS = 40_000, AGENT_TESTS_TIMEOUT_MS = 40_000, CASE_TIMEOUT_MS = 5_000;

// Serialized with Function#toString and run in a child process: keep it free of outer references.
async function hiddenSuite(workspace, resultFile, caseTimeoutMs) {
  const { appendFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const assert = (await import('node:assert/strict')).default;
  const modules = { duration: 'src/duration.mjs' };
  const cases = [];
  const test = (name, needs, fn) => cases.push({ name, needs, fn });

  test('hour-minute', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('1h30m'), 5_400_000); });
  test('whitespace-trim-and-separator', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration(' 2d 4h '), 187_200_000); });
  test('fractional-seconds', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('1.5s'), 1500); });
  test('milliseconds-unit', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('250ms'), 250); assert.equal(d.parseDuration('1ms'), 1); });
  test('minute-and-fraction', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('1m 0.5s'), 60_500); });
  test('all-units', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('1d2h3m4s5ms'), 93_784_005); });
  test('zero-and-fractional-hours', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('0s'), 0); assert.equal(d.parseDuration('2.5h'), 9_000_000); });
  test('rounding', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('0.4ms'), 0); assert.equal(d.parseDuration('0.5ms'), 1); assert.equal(d.parseDuration('1.0006s'), 1001); });
  test('multiple-whitespace-separators', ['duration'], ({ duration: d }) => { assert.equal(d.parseDuration('1h\t 5m   2s'), 3_902_000); });
  test('type-error', ['duration'], ({ duration: d }) => {
    for (const bad of [5, null, undefined, {}, ['1h']]) assert.throws(() => d.parseDuration(bad), TypeError);
  });
  test('empty-is-range-error', ['duration'], ({ duration: d }) => { for (const bad of ['', '   ']) assert.throws(() => d.parseDuration(bad), RangeError); });
  test('order-and-duplicates', ['duration'], ({ duration: d }) => { for (const bad of ['30m1h', '1m1m', '1ms1s', '1s 1d']) assert.throws(() => d.parseDuration(bad), RangeError, bad); });
  test('missing-unit-or-number', ['duration'], ({ duration: d }) => { for (const bad of ['1h 30', 'h', '5', 'ms']) assert.throws(() => d.parseDuration(bad), RangeError, bad); });
  test('space-between-number-and-unit', ['duration'], ({ duration: d }) => { assert.throws(() => d.parseDuration('1 h'), RangeError); });
  test('number-format', ['duration'], ({ duration: d }) => { for (const bad of ['-1s', '+1s', '.5s', '1.s', '1e3ms', '1.5.2s']) assert.throws(() => d.parseDuration(bad), RangeError, bad); });
  test('unknown-or-uppercase-unit', ['duration'], ({ duration: d }) => { for (const bad of ['1H', '5x', '2w', '1hr']) assert.throws(() => d.parseDuration(bad), RangeError, bad); });

  // Synchronous file appends survive process.exit (and a workspace module that exits early).
  const say = line => appendFileSync(resultFile, `${line}\n`);
  say(`TOTAL ${cases.length}`);
  const loaded = {};
  for (const [key, rel] of Object.entries(modules)) {
    try { loaded[key] = await import(pathToFileURL(join(workspace, rel)).href); } catch { loaded[key] = null; }
  }
  for (const c of cases) {
    let ok = false;
    if (c.needs.every(key => loaded[key])) {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(() => c.fn(loaded)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('case timeout')), caseTimeoutMs); })]);
        ok = true;
      } catch { ok = false; } finally { clearTimeout(timer); }
    }
    say(`${ok ? 'PASS' : 'FAIL'} ${c.name}`);
  }
  say('DONE');
  process.exit(0);
}

function listTests(workspace) {
  const dir = path.join(workspace, 'test'), out = [];
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(abs, e.name), `${rel}/${e.name}`);
      else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(`${rel}/${e.name}`);
    }
  };
  walk(dir, 'test');
  return out.sort();
}

function main() {
  const workspace = path.resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Usage: node acceptance.mjs <workspace>');
  const env = { PATH: process.env.PATH ?? '' };
  const failures = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-study-accept-'));
  let hidden = { total: 0, passed: 0 };
  try {
    const script = path.join(tmp, 'hidden-suite.mjs'), resultFile = path.join(tmp, `results-${randomUUID()}.txt`);
    fs.writeFileSync(script, `(${hiddenSuite.toString()})(process.argv[2], process.argv[3], ${CASE_TIMEOUT_MS});\n`);
    spawnSync(process.execPath, [script, workspace, resultFile], { cwd: tmp, env, stdio: 'ignore',
      timeout: HIDDEN_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const lines = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').split('\n') : [];
    const totalLine = lines.find(l => l.startsWith('TOTAL '));
    if (!totalLine) throw new Error('Hidden suite did not start');
    hidden.total = Number(totalLine.slice(6));
    const seen = new Map();
    for (const l of lines) {
      const m = /^(PASS|FAIL) (.+)$/.exec(l);
      if (m && !seen.has(m[2])) seen.set(m[2], m[1] === 'PASS');
    }
    hidden.passed = [...seen.values()].filter(Boolean).length;
    for (const [name, ok] of seen) if (!ok) failures.push(`hidden:${name}`);
    if (seen.size < hidden.total) failures.push(...Array.from({ length: hidden.total - seen.size }, (_, i) => `hidden:not-run-${i + 1}`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const tests = listTests(workspace);
  for (const required of REQUIRED_TEST_FILES) if (!tests.includes(required)) failures.push(`missing:${required}`);
  if (!tests.length) failures.push('agent-tests:none');
  else {
    const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: workspace, env, stdio: 'ignore',
      timeout: AGENT_TESTS_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (run.status !== 0) failures.push('agent-tests:failing');
  }

  console.log(JSON.stringify({ workload: 'small-duration', hiddenCases: hidden.total, hiddenPassed: hidden.passed, agentTestFiles: tests.length, failures }));
  console.log(JSON.stringify({ passed: failures.length === 0, defects: failures.length }));
}

main();
