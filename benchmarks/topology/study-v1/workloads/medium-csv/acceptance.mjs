// study-v1 acceptance: medium-csv. Usage: node acceptance.mjs <workspace>
// Prints {"passed": boolean, "defects": integer} on the last stdout line and exits 0 (non-zero only on a harness bug).
// Self-contained on purpose: the runner copies this file without its extension, so it uses no static imports and
// works as either module type. Hidden tests are written to a temporary directory, never into the workspace.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { randomUUID } = process.getBuiltinModule('node:crypto');

const REQUIRED_TEST_FILES = ['test/parse.test.mjs', 'test/stringify.test.mjs', 'test/records.test.mjs'];
const HIDDEN_TIMEOUT_MS = 40_000, AGENT_TESTS_TIMEOUT_MS = 40_000, CASE_TIMEOUT_MS = 5_000;

// Serialized with Function#toString and run in a child process: keep it free of outer references.
async function hiddenSuite(workspace, resultFile, caseTimeoutMs) {
  const { appendFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const assert = (await import('node:assert/strict')).default;
  const modules = { parse: 'src/csv/parse.mjs', stringify: 'src/csv/stringify.mjs', records: 'src/csv/records.mjs' };
  const cases = [];
  const test = (name, needs, fn) => cases.push({ name, needs, fn });

  test('parse-simple', ['parse'], ({ parse: p }) => { assert.deepEqual(p.parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]); });
  test('parse-trailing-newline-and-crlf', ['parse'], ({ parse: p }) => {
    assert.deepEqual(p.parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(p.parseCsv('a\n'), [['a']]);
  });
  test('parse-empty-input-and-lines', ['parse'], ({ parse: p }) => {
    assert.deepEqual(p.parseCsv(''), []);
    assert.deepEqual(p.parseCsv('a\n\nb\n'), [['a'], [''], ['b']]);
    assert.deepEqual(p.parseCsv('\n'), [['']]);
  });
  test('parse-empty-fields', ['parse'], ({ parse: p }) => { assert.deepEqual(p.parseCsv(',a,\n,'), [['', 'a', ''], ['', '']]); });
  test('parse-quoted-specials', ['parse'], ({ parse: p }) => {
    assert.deepEqual(p.parseCsv('"a,b","c\r\nd","e""f"\n'), [['a,b', 'c\r\nd', 'e"f']]);
    assert.deepEqual(p.parseCsv('"",x'), [['', 'x']]);
  });
  test('parse-lone-cr-is-data', ['parse'], ({ parse: p }) => { assert.deepEqual(p.parseCsv('a\rb,c'), [['a\rb', 'c']]); });
  test('parse-ragged-rows', ['parse'], ({ parse: p }) => { assert.deepEqual(p.parseCsv('a,b,c\nd'), [['a', 'b', 'c'], ['d']]); });
  test('parse-custom-delimiter', ['parse'], ({ parse: p }) => { assert.deepEqual(p.parseCsv('a;"b;c";d,e\n', { delimiter: ';' }), [['a', 'b;c', 'd,e']]); });
  test('parse-syntax-errors', ['parse'], ({ parse: p }) => {
    for (const bad of ['a"b', '"abc', 'x,"a"b', '"a" ,b']) assert.throws(() => p.parseCsv(bad), SyntaxError, JSON.stringify(bad));
  });
  test('parse-argument-errors', ['parse'], ({ parse: p }) => {
    assert.throws(() => p.parseCsv(42), TypeError);
    for (const delimiter of ['"', '\n', '\r', ';;', '']) assert.throws(() => p.parseCsv('a', { delimiter }), RangeError, JSON.stringify(delimiter));
  });
  test('stringify-plain-and-types', ['stringify'], ({ stringify: s }) => {
    assert.equal(s.stringifyCsv([['a', 1, true, null, undefined, 10n]]), 'a,1,true,,,10\n');
    assert.equal(s.stringifyCsv([]), '');
  });
  test('stringify-quoting-rules', ['stringify'], ({ stringify: s }) => {
    assert.equal(s.stringifyCsv([['a,b', 'q"q', 'l\nm', 'c\rr', ' lead', 'trail ', 'mid dle']]),
      '"a,b","q""q","l\nm","c\rr"," lead","trail ",mid dle\n');
  });
  test('stringify-options', ['stringify'], ({ stringify: s }) => {
    assert.equal(s.stringifyCsv([['a;b', 'c,d'], ['e']], { delimiter: ';', newline: '\r\n' }), '"a;b";c,d\r\ne\r\n');
    assert.throws(() => s.stringifyCsv([['a']], { newline: '\r' }), RangeError);
    assert.throws(() => s.stringifyCsv([['a']], { delimiter: '"' }), RangeError);
  });
  test('stringify-type-errors', ['stringify'], ({ stringify: s }) => {
    assert.throws(() => s.stringifyCsv('a'), TypeError);
    assert.throws(() => s.stringifyCsv(['a']), TypeError);
    for (const value of [{}, ['x'], Symbol('s'), () => 1]) assert.throws(() => s.stringifyCsv([[value]]), TypeError);
  });
  test('round-trip', ['parse', 'stringify'], ({ parse: p, stringify: s }) => {
    const rows = [['id', 'text', ''], ['1', 'he said "hi", then left', ' x '], ['2', 'line1\r\nline2\nline3', '"'], [''], ['a\rb', ';', ',']];
    assert.deepEqual(p.parseCsv(s.stringifyCsv(rows)), rows);
    assert.deepEqual(p.parseCsv(s.stringifyCsv(rows, { delimiter: ';', newline: '\r\n' }), { delimiter: ';' }), rows);
  });
  test('records-basic', ['records'], ({ records: r }) => {
    const out = r.toRecords([['name', 'city'], ['Ada', ' London '], ['Bob', '']]);
    assert.deepEqual(out, [{ name: 'Ada', city: ' London ' }, { name: 'Bob', city: '' }]);
    assert.deepEqual(Object.keys(out[0]), ['name', 'city']);
    assert.deepEqual(r.toRecords([['only']]), []);
  });
  test('records-typed-values', ['records'], ({ records: r }) => {
    const rows = [['n', 'i', 'b', 's'], [' 1.5e2 ', '-7', 'TRUE', ' 5 '], ['.5', '+3', 'False', ''], ['', ' ', ' ', 'x']];
    assert.deepEqual(r.toRecords(rows, { types: { n: 'number', i: 'integer', b: 'boolean', s: 'string' } }), [
      { n: 150, i: -7, b: true, s: ' 5 ' }, { n: 0.5, i: 3, b: false, s: '' }, { n: null, i: null, b: null, s: 'x' }]);
  });
  test('records-conversion-errors', ['records'], ({ records: r }) => {
    const bad = [['number', 'abc'], ['number', '1,5'], ['number', 'Infinity'], ['number', '0x10'], ['integer', '1.0'],
      ['integer', '9007199254740993'], ['boolean', 'yes'], ['boolean', '1']];
    for (const [type, value] of bad) assert.throws(() => r.toRecords([['c'], [value]], { types: { c: type } }), TypeError, `${type} ${value}`);
  });
  test('records-header-errors', ['records'], ({ records: r }) => {
    assert.throws(() => r.toRecords([]), RangeError);
    assert.throws(() => r.toRecords([['a', 'a']]), SyntaxError);
    assert.throws(() => r.toRecords([['a', '']]), SyntaxError);
  });
  test('records-row-length-error-names-row', ['records'], ({ records: r }) => {
    assert.throws(() => r.toRecords([['a', 'b'], ['1', '2'], ['3']]), err => err instanceof RangeError && /row 3\b/.test(err.message));
  });
  test('records-types-option-errors', ['records'], ({ records: r }) => {
    assert.throws(() => r.toRecords([['a'], ['1']], { types: { b: 'number' } }), RangeError);
    assert.throws(() => r.toRecords([['a'], ['1']], { types: { a: 'date' } }), RangeError);
  });
  test('from-records', ['records'], ({ records: r }) => {
    assert.deepEqual(r.fromRecords([{ a: 1, b: null, c: true }, { a: 'x', c: undefined }]), [['a', 'b', 'c'], ['1', '', 'true'], ['x', '', '']]);
    assert.deepEqual(r.fromRecords([{ a: 1, b: 2 }], ['b', 'z']), [['b', 'z'], ['2', '']]);
    assert.deepEqual(r.fromRecords([], ['a']), [['a']]);
    assert.deepEqual(r.fromRecords([]), []);
  });
  test('end-to-end-pipeline', ['parse', 'stringify', 'records'], ({ parse: p, stringify: s, records: r }) => {
    const text = 'name,age,active\r\n"Lovelace, Ada",36,true\r\nBob,,FALSE\r\n';
    const records = r.toRecords(p.parseCsv(text), { types: { age: 'integer', active: 'boolean' } });
    assert.deepEqual(records, [{ name: 'Lovelace, Ada', age: 36, active: true }, { name: 'Bob', age: null, active: false }]);
    assert.equal(s.stringifyCsv(r.fromRecords(records)), 'name,age,active\n"Lovelace, Ada",36,true\nBob,,false\n');
  });

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

  console.log(JSON.stringify({ workload: 'medium-csv', hiddenCases: hidden.total, hiddenPassed: hidden.passed, agentTestFiles: tests.length, failures }));
  console.log(JSON.stringify({ passed: failures.length === 0, defects: failures.length }));
}

main();
