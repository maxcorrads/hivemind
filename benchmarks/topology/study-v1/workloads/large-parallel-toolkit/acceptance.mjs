// study-v1 acceptance: large-parallel-toolkit. Usage: node acceptance.mjs <workspace>
// Prints {"passed": boolean, "defects": integer} on the last stdout line and exits 0 (non-zero only on a harness bug).
// Self-contained on purpose: the runner copies this file without its extension, so it uses no static imports and
// works as either module type. Hidden tests are written to a temporary directory, never into the workspace.
const fs = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { randomUUID } = process.getBuiltinModule('node:crypto');

const REQUIRED_TEST_FILES = ['test/lru-cache.test.mjs', 'test/semver.test.mjs', 'test/wrap.test.mjs', 'test/roman.test.mjs', 'test/token-bucket.test.mjs'];
const HIDDEN_TIMEOUT_MS = 40_000, AGENT_TESTS_TIMEOUT_MS = 40_000, CASE_TIMEOUT_MS = 5_000;

// Serialized with Function#toString and run in a child process: keep it free of outer references.
async function hiddenSuite(workspace, resultFile, caseTimeoutMs) {
  const { appendFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const assert = (await import('node:assert/strict')).default;
  const modules = { lru: 'src/lru-cache.mjs', semver: 'src/semver.mjs', wrap: 'src/wrap.mjs', roman: 'src/roman.mjs', bucket: 'src/token-bucket.mjs' };
  const cases = [];
  const test = (name, needs, fn) => cases.push({ name, needs, fn });

  // LRU cache
  test('lru-basic-get-set', ['lru'], ({ lru: { LRUCache } }) => {
    const c = new LRUCache({ maxEntries: 3 });
    assert.equal(c.set('a', 1), c);
    c.set('b', 2);
    assert.equal(c.get('a'), 1); assert.equal(c.get('zz'), undefined); assert.equal(c.size, 2);
  });
  test('lru-eviction-order-and-callback', ['lru'], ({ lru: { LRUCache } }) => {
    const evicted = [];
    const c = new LRUCache({ maxEntries: 2, onEvict: (k, v) => evicted.push([k, v]) });
    c.set('a', 1).set('b', 2); c.get('a'); c.set('c', 3); c.set('d', 4);
    assert.deepEqual(evicted, [['b', 2], ['a', 1]]);
    assert.deepEqual(c.keys(), ['d', 'c']);
  });
  test('lru-peek-and-has-keep-recency', ['lru'], ({ lru: { LRUCache } }) => {
    const c = new LRUCache({ maxEntries: 2 });
    c.set('a', 1).set('b', 2);
    assert.equal(c.peek('a'), 1); assert.equal(c.has('a'), true); assert.equal(c.has('x'), false);
    c.set('c', 3);
    assert.equal(c.has('a'), false); assert.deepEqual(c.keys(), ['c', 'b']);
  });
  test('lru-update-refreshes-without-evicting', ['lru'], ({ lru: { LRUCache } }) => {
    const evicted = [];
    const c = new LRUCache({ maxEntries: 2, onEvict: k => evicted.push(k) });
    c.set('a', 1).set('b', 2).set('a', 10);
    assert.deepEqual(evicted, []); assert.deepEqual(c.keys(), ['a', 'b']); assert.equal(c.get('a'), 10);
    c.set('c', 3);
    assert.deepEqual(evicted, ['b']);
  });
  test('lru-delete-and-clear-do-not-evict', ['lru'], ({ lru: { LRUCache } }) => {
    const evicted = [];
    const c = new LRUCache({ maxEntries: 3, onEvict: k => evicted.push(k) });
    c.set(1, 'x').set(2, 'y').set(3, 'z');
    assert.equal(c.delete(2), true); assert.equal(c.delete(2), false); assert.equal(c.size, 2);
    c.clear();
    assert.equal(c.size, 0); assert.deepEqual(c.keys(), []); assert.deepEqual(evicted, []);
  });
  test('lru-samevaluezero-keys', ['lru'], ({ lru: { LRUCache } }) => {
    const c = new LRUCache({ maxEntries: 5 });
    const obj = {};
    c.set(NaN, 'nan').set(0, 'zero').set(obj, 'o').set('1', 's');
    assert.equal(c.get(NaN), 'nan'); assert.equal(c.get(-0), 'zero'); assert.equal(c.get(obj), 'o'); assert.equal(c.get({}), undefined);
    assert.equal(c.get(1), undefined);
  });
  test('lru-invalid-max-entries', ['lru'], ({ lru: { LRUCache } }) => {
    for (const maxEntries of [0, -1, 1.5, '2', undefined, NaN, Infinity]) assert.throws(() => new LRUCache({ maxEntries }), RangeError, String(maxEntries));
  });
  // Semver
  test('semver-parse', ['semver'], ({ semver: s }) => {
    assert.deepEqual(s.parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(s.parse('0.0.0-alpha.1.x-y.0+build.001'), { major: 0, minor: 0, patch: 0, prerelease: ['alpha', 1, 'x-y', 0] });
    assert.deepEqual(s.parse('10.20.30-rc.1a'), { major: 10, minor: 20, patch: 30, prerelease: ['rc', '1a'] });
  });
  test('semver-parse-invalid', ['semver'], ({ semver: s }) => {
    for (const bad of ['1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', 'v1.2.3', ' 1.2.3', '1.2.3-', '1.2.3-01', '1.2.3-a..b', '1.2.3+', '1.2.3-a_b', '', 123, null]) {
      assert.throws(() => s.parse(bad), TypeError, String(bad));
    }
  });
  test('semver-compare-core', ['semver'], ({ semver: s }) => {
    assert.equal(s.compare('1.2.3', '1.2.3'), 0); assert.equal(s.compare('1.2.3', '1.10.0'), -1);
    assert.equal(s.compare('2.0.0', '1.99.99'), 1); assert.equal(s.compare('1.2.3+a', '1.2.3+b'), 0);
  });
  test('semver-compare-prerelease-precedence', ['semver'], ({ semver: s }) => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      assert.equal(s.compare(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
      assert.equal(s.compare(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
    }
    assert.equal(s.compare('1.0.0-1', '1.0.0-A'), -1); assert.equal(s.compare('1.0.0-B', '1.0.0-a'), -1);
  });
  test('semver-satisfies-operators', ['semver'], ({ semver: s }) => {
    assert.equal(s.satisfies('1.2.3', '1.2.3'), true); assert.equal(s.satisfies('1.2.3', '=1.2.3'), true);
    assert.equal(s.satisfies('1.2.4', '>1.2.3'), true); assert.equal(s.satisfies('1.2.3', '>1.2.3'), false);
    assert.equal(s.satisfies('1.2.3', '>=1.2.3 <1.3.0'), true); assert.equal(s.satisfies('1.3.0', '>=1.2.3 <1.3.0'), false);
    assert.equal(s.satisfies('0.9.0', '<=1.0.0'), true); assert.equal(s.satisfies('5.0.0', '*'), true);
    assert.equal(s.satisfies('1.2.3', '  >=1.0.0   <2.0.0  '), true);
  });
  test('semver-satisfies-caret-tilde', ['semver'], ({ semver: s }) => {
    const cases = [['1.9.9', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false], ['0.2.9', '^0.2.3', true],
      ['0.3.0', '^0.2.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
      ['0.1.5', '~0.1.2', true]];
    for (const [v, r, want] of cases) assert.equal(s.satisfies(v, r), want, `${v} ${r}`);
  });
  test('semver-satisfies-or-sets', ['semver'], ({ semver: s }) => {
    assert.equal(s.satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true); assert.equal(s.satisfies('2.1.0', '^1.0.0 || ^3.0.0'), false);
    assert.equal(s.satisfies('1.0.0', '<0.5.0||>=1.0.0 <1.0.1'), true);
  });
  test('semver-satisfies-prerelease-rule', ['semver'], ({ semver: s }) => {
    assert.equal(s.satisfies('1.2.4-beta', '>=1.2.0'), false);
    assert.equal(s.satisfies('1.2.4-beta', '>=1.2.4-alpha'), true);
    assert.equal(s.satisfies('1.2.4-alpha', '>=1.2.4-beta'), false);
    assert.equal(s.satisfies('1.2.3-rc.1', '^1.2.3-beta'), true);
    assert.equal(s.satisfies('1.3.0-rc.1', '^1.2.3-beta'), false);
    assert.equal(s.satisfies('2.0.0-alpha', '*'), false);
    assert.equal(s.satisfies('2.0.0-alpha', '^1.0.0 || >=2.0.0-0 <3.0.0'), true);
  });
  test('semver-satisfies-invalid', ['semver'], ({ semver: s }) => {
    for (const bad of ['', 'abc', '>=1.2', '>= 1.2.3', '1.2.3 ||', '|| 1.2.3', '^', '~1', '>>1.2.3']) assert.throws(() => s.satisfies('1.2.3', bad), TypeError, bad);
    assert.throws(() => s.satisfies('1.2', '*'), TypeError);
  });
  // Wrap
  test('wrap-examples', ['wrap'], ({ wrap: w }) => {
    assert.equal(w.wrapText('The quick brown fox', 10), 'The quick\nbrown fox');
    assert.equal(w.wrapText('abcdefghij xy', 4), 'abcd\nefgh\nij\nxy');
    assert.equal(w.wrapText('abcdefg h', 4), 'abcd\nefg\nh');
    assert.equal(w.wrapText('abcdef g', 4), 'abcd\nef g');
  });
  test('wrap-exact-fit-and-collapse', ['wrap'], ({ wrap: w }) => {
    assert.equal(w.wrapText('aaaa bbbb', 9), 'aaaa bbbb');
    assert.equal(w.wrapText('aaaa bbbb', 8), 'aaaa\nbbbb');
    assert.equal(w.wrapText('  one\ttwo\n three  ', 80), 'one two three');
  });
  test('wrap-paragraphs', ['wrap'], ({ wrap: w }) => {
    assert.equal(w.wrapText('first para\nstill first\n\n \t \n\nsecond', 11), 'first para\nstill first\n\nsecond');
    assert.equal(w.wrapText('\n\nonly\n\n', 3), 'onl\ny');
  });
  test('wrap-long-word-after-text', ['wrap'], ({ wrap: w }) => {
    assert.equal(w.wrapText('hi abcdefgh', 4), 'hi\nabcd\nefgh');
    assert.equal(w.wrapText('hi abcdefghi j', 4), 'hi\nabcd\nefgh\ni j');
    assert.equal(w.wrapText('x y z', 1), 'x\ny\nz');
  });
  test('wrap-empty-and-errors', ['wrap'], ({ wrap: w }) => {
    assert.equal(w.wrapText('', 5), ''); assert.equal(w.wrapText(' \n\t\n', 5), '');
    assert.throws(() => w.wrapText(null, 5), TypeError);
    for (const width of [0, -1, 2.5, '5', NaN]) assert.throws(() => w.wrapText('a', width), RangeError, String(width));
  });
  // Roman
  test('roman-to', ['roman'], ({ roman: r }) => {
    const cases = [[1, 'I'], [4, 'IV'], [9, 'IX'], [14, 'XIV'], [40, 'XL'], [90, 'XC'], [400, 'CD'], [944, 'CMXLIV'], [1994, 'MCMXCIV'], [2024, 'MMXXIV'], [3999, 'MMMCMXCIX']];
    for (const [n, text] of cases) assert.equal(r.toRoman(n), text, String(n));
  });
  test('roman-to-invalid', ['roman'], ({ roman: r }) => {
    for (const bad of [0, -1, 4000, 1.5, '5', NaN, null]) assert.throws(() => r.toRoman(bad), RangeError, String(bad));
  });
  test('roman-from-round-trip', ['roman'], ({ roman: r }) => {
    for (let n = 1; n <= 3999; n++) assert.equal(r.fromRoman(r.toRoman(n)), n);
  });
  test('roman-from-invalid', ['roman'], ({ roman: r }) => {
    for (const bad of ['IIII', 'VX', 'IC', 'MMMM', 'iv', '', 'XM', 'VV', 'IXI', 'CMC', ' X', 'X ', 'IL', 'DD', 'LXL']) assert.throws(() => r.fromRoman(bad), SyntaxError, bad);
    assert.throws(() => r.fromRoman(4), TypeError);
  });
  // Token bucket
  test('bucket-starts-full-and-removes', ['bucket'], ({ bucket: { TokenBucket } }) => {
    let t = 1000;
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 2, now: () => t });
    assert.equal(b.available(), 5); assert.equal(b.tryRemove(3), true); assert.equal(b.available(), 2);
    assert.equal(b.tryRemove(3), false); assert.equal(b.available(), 2); assert.equal(b.tryRemove(), true); assert.equal(b.available(), 1);
  });
  test('bucket-refill-and-cap', ['bucket'], ({ bucket: { TokenBucket } }) => {
    let t = 0;
    const b = new TokenBucket({ capacity: 4, refillPerSecond: 2, now: () => t });
    b.tryRemove(4);
    t = 250; assert.equal(b.available(), 0.5);
    t = 1250; assert.equal(b.available(), 2.5);
    t = 100_000; assert.equal(b.available(), 4);
  });
  test('bucket-ms-until-available', ['bucket'], ({ bucket: { TokenBucket } }) => {
    let t = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 4, now: () => t });
    assert.equal(b.msUntilAvailable(3), 0);
    b.tryRemove(3);
    assert.equal(b.msUntilAvailable(), 250); assert.equal(b.msUntilAvailable(3), 750);
    t = 125; assert.equal(b.msUntilAvailable(1), 125); assert.equal(b.available(), 0.5);
    const slow = new TokenBucket({ capacity: 1, refillPerSecond: 3, now: () => t });
    slow.tryRemove(1); assert.equal(slow.msUntilAvailable(1), 334);
  });
  test('bucket-zero-refill', ['bucket'], ({ bucket: { TokenBucket } }) => {
    let t = 0;
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 0, now: () => t });
    b.tryRemove(2); t = 1e9;
    assert.equal(b.available(), 0); assert.equal(b.msUntilAvailable(), Infinity); assert.equal(b.tryRemove(), false);
  });
  test('bucket-clock-backwards', ['bucket'], ({ bucket: { TokenBucket } }) => {
    let t = 10_000;
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, now: () => t });
    b.tryRemove(10);
    t = 5000; assert.equal(b.available(), 0);
    t = 7000; assert.equal(b.available(), 2);
  });
  test('bucket-validation', ['bucket'], ({ bucket: { TokenBucket } }) => {
    for (const capacity of [0, -1, Infinity, NaN, '5']) assert.throws(() => new TokenBucket({ capacity, refillPerSecond: 1 }), RangeError, String(capacity));
    for (const refillPerSecond of [-1, Infinity, NaN, '1']) assert.throws(() => new TokenBucket({ capacity: 1, refillPerSecond }), RangeError, String(refillPerSecond));
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => 0 });
    for (const count of [0, -1, 3, NaN, Infinity]) {
      assert.throws(() => b.tryRemove(count), RangeError, String(count));
      assert.throws(() => b.msUntilAvailable(count), RangeError, String(count));
    }
    assert.equal(b.available(), 2);
  });
  test('bucket-default-clock', ['bucket'], ({ bucket: { TokenBucket } }) => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 0 });
    assert.equal(b.tryRemove(), true); assert.equal(b.tryRemove(), false);
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

  console.log(JSON.stringify({ workload: 'large-parallel-toolkit', hiddenCases: hidden.total, hiddenPassed: hidden.passed, agentTestFiles: tests.length, failures }));
  console.log(JSON.stringify({ passed: failures.length === 0, defects: failures.length }));
}

main();
