// End-to-end tests of the live host with fake seats: every trial spawns a real isolated `hivemind serve` whose TypeSafe
// calls are answered by a local fixture (network to anything but loopback throws), and fake `opencode` seats that
// speak the agent HTTP API. No provider, credential or paid call is involved.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareStudy, validateStudy } from './benchmark-topology.mjs';
import { exportRun, parseArgs, prepareRun, runStudy, sha256 } from './topology-study-runner.mjs';
import { createHivemindHost, liveUsage } from './topology-study-host.mjs';
import { createWatcher, windowName } from './topology-study-watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repoRoot = path.resolve(here, '..');
const REVISION = 'c'.repeat(40);
const versions = { hivemindRevision: REVISION, provider: 'fixture', model: 'fixture-model', host: 'opencode/1.0.0-fake',
  configuration: 'auto', policyVersion: 'topology-policy-v2.1', jevModel: 'jev-fixture-pin' };
const ACCEPTANCE = `import { readFileSync } from 'node:fs';
import path from 'node:path';
let value = '';
try { value = readFileSync(path.join(process.argv[2], 'result.txt'), 'utf8').trim(); } catch { value = ''; }
console.log(JSON.stringify({ passed: value === 'sort 3 1 2', defects: value === 'sort 3 1 2' ? 0 : 1 }));
`;

/** Picks a seed whose randomized order starts with `first`, so a test reaches that condition without extra trials. */
function seedStartingWith(config, first) {
  for (let k = 1; k < 500; k++) {
    const seed = Math.imul(k, 2654435761) >>> 0;
    if (prepareStudy({ ...config, seed }).trials[0].condition === first) return seed;
  }
  throw new Error('no seed');
}

function setup({ wallMs = 20_000, expectedResolvedModel = null, first = null, repeats = 1 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivemind-study-host-'));
  writeFileSync(path.join(dir, 'input.txt'), 'sort 3 1 2\n');
  writeFileSync(path.join(dir, 'acceptance.mjs'), ACCEPTANCE);
  const config = { evidenceKind: 'synthetic', versions, repeats, seed: 29, freeWorkers: 2,
    workloads: [{ id: 'sort-fixture', version: 'v1', inputDigest: sha256(readFileSync(path.join(dir, 'input.txt'))),
      acceptanceDigest: sha256(readFileSync(path.join(dir, 'acceptance.mjs'))) }],
    limits: { wallMs, workloadTokens: 1_000 } };
  if (first) config.seed = seedStartingWith(config, first);
  const study = prepareStudy(config);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(study));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ schemaVersion: 1, manifest: 'manifest.json',
    workloads: [{ id: 'sort-fixture', input: 'input.txt', acceptance: 'acceptance.mjs' }],
    host: { name: 'opencode', binaryVersion: '1.0.0-fake' }, jev: { expectedResolvedModel } }));
  const runDir = path.join(dir, 'run');
  prepareRun({ planPath: path.join(dir, 'plan.json'), runDir });
  const control = path.join(dir, 'seat-control.json');
  const setBehavior = (behavior, tokens = 40, extra = {}) => writeFileSync(control, JSON.stringify({ behavior, tokens, ...extra }));
  setBehavior('complete');
  const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const host = (serverEnv = {}, extra = {}) => createHivemindHost({ repoRoot, plan: run, evidenceKind: 'synthetic', ...extra,
    env: { PATH: process.env.PATH, HOME: dir, HIVEMIND_STUDY_TYPESAFE_KEY: 'fixture-key-not-a-secret' },
    seatCommand: [process.execPath, path.join(here, 'fixtures/topology-study-fake-seat.mjs')],
    serverImports: [path.join(here, 'fixtures/topology-study-fake-jev.mjs')], serverEnv,
    seatEnv: { FAKE_SEAT_CONTROL: control }, probeCheckout: () => ({ revision: REVISION, clean: true }),
    joinTimeoutMs: 20_000, pollMs: 100, acceptanceTimeoutMs: 10_000, seatRetryBackoffMs: 200 });
  const execute = (options = {}) => runStudy({ runDir, host: host(options.serverEnv, options.hostOptions), authorization: study.studyId, maxTrials: options.maxTrials ?? Infinity,
    concurrency: options.concurrency ?? 1, availableMemory: options.availableMemory ?? (() => 64 * 1024 ** 3) });
  return { dir, runDir, study, setBehavior, execute, control, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('live host runs all five conditions in isolated servers: Auto calls the fake Jev, fixed baselines never do', { timeout: 120_000 }, async () => {
  const ctx = setup();
  try {
    assert.deepEqual(await ctx.execute(), { status: 'complete', trialId: null, executed: 5 });
    const { study, report } = exportRun({ runDir: ctx.runDir });
    const coverage = validateStudy(study);
    assert.equal(coverage.completed, 5);
    assert.deepEqual(coverage.requestedModels, ['jev-fixture-pin']);
    assert.deepEqual(coverage.resolvedModels, ['jev-topology-fixture']);
    for (const trial of study.trials) {
      const o = trial.observed, auto = trial.condition === 'auto';
      assert.equal(o.outcome, 'passed', trial.condition);
      assert.equal(o.jevEnabled, auto);
      assert.equal(o.initialTopology, auto ? 'brain_one_worker' : trial.condition);
      assert.equal(o.workloadTokens, 40 + 2 * 20, 'brain final cumulative total plus each worker');
      assert.equal(o.instrumentationHealthy, true);
      assert.ok(o.wallMs > 0 && o.wallMs < 20_000);
      assert.equal(o.independentlyReviewed, false);
      if (auto) assert.equal(o.routerEvidence.overhead.totalInputTokens, 80);
      const attempt = path.join(ctx.runDir, o.evidenceRef);
      for (const file of ['server.log', 'brain.stdout.log', 'worker-2.stdout.log', 'workspace/result.txt', 'home/hive.db']) assert.ok(existsSync(path.join(attempt, file)), file);
      const settings = JSON.parse(readFileSync(path.join(attempt, 'home/adaptive-routing.json'), 'utf8'));
      assert.equal(settings.enabled, auto);
      assert.notEqual(settings.apiKey, 'fixture-key-not-a-secret', 'the retained raw home never keeps the key');
      if (auto) assert.equal(settings.model, 'jev-fixture-pin');
    }
    assert.equal(report.jev.resolvedModelPin, 'jev-topology-fixture');
    assert.ok(!JSON.stringify({ study, report }).includes(ctx.dir));
    assert.ok(!readFileSync(path.join(ctx.runDir, 'trials', study.trials[0].id, 'journal.jsonl'), 'utf8').includes('fixture-key-not-a-secret'));
  } finally { ctx.cleanup(); }
});

test('live host retains capacity changes, unknown usage, wall-budget interruptions, crashes and failed acceptance', { timeout: 120_000 }, async () => {
  const ctx = setup({ wallMs: 2_500 });
  try {
    ctx.setBehavior('double_join');
    const aborted = await ctx.execute();
    assert.deepEqual([aborted.status, aborted.reason], ['aborted_before_request', 'capacity_mismatch']);
    const expected = [['no_usage', 'passed'], ['hang', 'interrupted'], ['crash', 'harness_failed'], ['wrong_result', 'quality_failed'], ['complete', 'passed']];
    for (const [index, [behavior]] of expected.entries()) {
      ctx.setBehavior(behavior);
      assert.equal((await ctx.execute({ maxTrials: 1 })).status, index === expected.length - 1 ? 'complete' : 'paused', behavior);
    }
    const { study, report } = exportRun({ runDir: ctx.runDir });
    assert.deepEqual(study.trials.map(t => t.observed.outcome), expected.map(([, outcome]) => outcome));
    assert.deepEqual(report.trials[0].abortedAttempts.map(a => a.reason), ['capacity_mismatch']);
    const [unknown, hung, crashed, wrong] = study.trials.map(t => t.observed);
    assert.equal(unknown.workloadTokens, null); assert.equal(unknown.workloadUsageSource, 'unknown'); assert.equal(unknown.instrumentationHealthy, false);
    assert.equal(report.trials[1].budget.interruption, 'wall_budget'); assert.equal(report.trials[1].budget.wallExceeded, true);
    assert.equal(hung.defects, null);
    assert.equal(crashed.defects, null);
    assert.equal(wrong.defects, 1);
  } finally { ctx.cleanup(); }
});

test('live host withholds a Jev resolved-model drift and refuses Auto without credentials', { timeout: 60_000 }, async () => {
  const ctx = setup({ first: 'auto', expectedResolvedModel: 'jev-expected-v1' });
  try {
    const drift = await ctx.execute();
    assert.deepEqual([drift.status, drift.exclusions], ['configuration_drift', ['jev_resolved_model_drift']]);
    assert.equal(exportRun({ runDir: ctx.runDir }).study.trials[0].observed, null);
  } finally { ctx.cleanup(); }
  const missing = setup({ first: 'auto' });
  try {
    const run = JSON.parse(readFileSync(path.join(missing.runDir, 'run.json'), 'utf8'));
    const host = createHivemindHost({ repoRoot, plan: run, env: { PATH: process.env.PATH }, evidenceKind: 'synthetic',
      seatCommand: [process.execPath, path.join(here, 'fixtures/topology-study-fake-seat.mjs')],
      seatEnv: { FAKE_SEAT_CONTROL: path.join(missing.dir, 'seat-control.json') },
      probeCheckout: () => ({ revision: REVISION, clean: true }) });
    const result = await runStudy({ runDir: missing.runDir, host, authorization: missing.study.studyId });
    assert.equal(result.status, 'preflight_drift'); assert.ok(result.drift.some(d => d.field === 'credentials.jev'));
    assert.ok(!existsSync(path.join(missing.runDir, 'trials', missing.study.trials[0].id, 'attempt-001')));
  } finally { missing.cleanup(); }
});

test('a trial server lost while classifying the Human request leaves an ambiguous attempt that is never resent', { timeout: 60_000 }, async () => {
  const ctx = setup({ first: 'auto' });
  try {
    const lost = await ctx.execute({ serverEnv: { FAKE_JEV_CRASH: '1' } });
    assert.deepEqual([lost.status, lost.reason], ['ambiguous', 'lost_request_response']);
    const again = await ctx.execute();
    assert.deepEqual([again.status, again.reason], ['ambiguous', 'awaiting_reconciliation']);
    const trial = path.join(ctx.runDir, 'trials', ctx.study.trials[0].id);
    assert.ok(existsSync(path.join(trial, 'attempt-001', 'server.log')) && !existsSync(path.join(trial, 'attempt-002')));
    assert.equal(exportRun({ runDir: ctx.runDir }).report.trials[0].state, 'ambiguous');
  } finally { ctx.cleanup(); }
});

test('live usage keeps the latest cumulative seat total while the seat is running', () => {
  const usage = liveUsage();
  usage.push(Buffer.from('{"type":"step_finish","part":{"tokens":{"total":12}}}\n{"type":"step_'));
  assert.equal(usage.latest(), 12);
  usage.push(Buffer.from('finish","part":{"tokens":{"total":30}}}\nnot json\n'));
  assert.equal(usage.latest(), 30); assert.equal(usage.finish(), 30);
});

const traceOf = ctx => readFileSync(`${ctx.control}.trace`, 'utf8').trim().split('\n');
const launchOf = (ctx, trialId, attempt = 'attempt-001') =>
  JSON.parse(readFileSync(path.join(ctx.runDir, 'trials', trialId, attempt, 'seat-launch.json'), 'utf8')).seats;

test('seats start one at a time and a seat that hits opencode\'s database lock is retried once', { timeout: 60_000 }, async () => {
  const ctx = setup({ first: 'brain_multi_dm' });
  try {
    ctx.setBehavior('complete', 40, { lockFailOnce: ['brain', 'worker-2'] });
    assert.equal((await ctx.execute({ maxTrials: 1 })).status, 'paused');
    // Each seat is started only after the previous one is online; the locked starts are retried in place.
    assert.deepEqual(traceOf(ctx), ['start brain', 'start brain', 'joined brain', 'start worker-1', 'joined worker-1',
      'start worker-2', 'start worker-2', 'joined worker-2']);
    const trialId = ctx.study.trials[0].id;
    assert.deepEqual(launchOf(ctx, trialId).map(s => [s.seat, s.starts, s.retries.map(r => r.reason), s.joined, s.failure]), [
      ['brain', 2, ['database_locked'], true, null], ['worker-1', 1, [], true, null], ['worker-2', 2, ['database_locked'], true, null]]);
    const attempt = path.join(ctx.runDir, 'trials', trialId, 'attempt-001');
    assert.match(readFileSync(path.join(attempt, 'brain.stderr.log'), 'utf8'), /database is locked/);
    assert.ok(existsSync(path.join(attempt, 'brain.retry-1.stdout.log')) && existsSync(path.join(attempt, 'worker-2.retry-1.stderr.log')));
    const { study } = exportRun({ runDir: ctx.runDir });
    assert.equal(study.trials[0].observed.outcome, 'passed');
    assert.equal(study.trials[0].observed.workloadTokens, 40 + 2 * 20, 'usage comes from the seats that actually ran');
  } finally { ctx.cleanup(); }
});

test('a seat that keeps hitting the lock or exits for another reason is a genuine seats_did_not_join', { timeout: 60_000 }, async () => {
  const ctx = setup({ first: 'single' });
  try {
    const trialId = ctx.study.trials[0].id;
    ctx.setBehavior('complete', 40, { lockFailAlways: ['worker-1'] });
    const locked = await ctx.execute();
    assert.deepEqual([locked.status, locked.reason], ['aborted_before_request', 'seats_did_not_join']);
    assert.deepEqual(traceOf(ctx), ['start brain', 'joined brain', 'start worker-1', 'start worker-1'], 'worker-2 never starts');
    assert.deepEqual(launchOf(ctx, trialId).map(s => [s.seat, s.starts, s.failure]), [['brain', 1, null], ['worker-1', 2, 'database_locked']]);

    rmSync(`${ctx.control}.trace`);
    ctx.setBehavior('complete', 40, { exitBeforeJoin: ['worker-2'] });
    const exited = await ctx.execute();
    assert.deepEqual([exited.status, exited.reason], ['aborted_before_request', 'seats_did_not_join']);
    assert.deepEqual(launchOf(ctx, trialId, 'attempt-002').map(s => [s.seat, s.starts, s.failure]),
      [['brain', 1, null], ['worker-1', 1, null], ['worker-2', 1, 'exited_before_join']], 'an unrelated exit is never retried');
    const journal = readFileSync(path.join(ctx.runDir, 'trials', trialId, 'journal.jsonl'), 'utf8');
    assert.match(journal, /worker-1 database_locked/); assert.match(journal, /worker-2 exited_before_join/);
    assert.equal(exportRun({ runDir: ctx.runDir }).report.trials[0].abortedAttempts.length, 2);
  } finally { ctx.cleanup(); }
});

const fakeTmux = path.join(here, 'fixtures/topology-study-fake-tmux.mjs');
const tmuxCalls = log => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('--watch opens one tmux window per trial with a pane per seat and never changes outcomes', { timeout: 120_000 }, async () => {
  assert.deepEqual(parseArgs(['run', '--run-dir', 'r', '--authorize-paid-run', 's', '--watch', '--concurrency', '10']).options,
    { '--run-dir': 'r', '--authorize-paid-run': 's', '--watch': true, '--concurrency': '10' });
  const ctx = setup();
  try {
    const log = path.join(ctx.dir, 'tmux.log');
    const watcher = createWatcher({ enabled: true, env: {}, tmux: [process.execPath, fakeTmux, log, 'ok'],
      openTerminal: [process.execPath, fakeTmux, log, 'terminal'] });
    assert.deepEqual(await ctx.execute({ hostOptions: { watcher } }), { status: 'complete', trialId: null, executed: 5 });
    const { study } = exportRun({ runDir: ctx.runDir });
    for (const trial of study.trials) {
      assert.equal(trial.observed.outcome, 'passed'); assert.equal(trial.observed.workloadTokens, 80);
      assert.equal(trial.observed.instrumentationHealthy, true);
    }
    const calls = tmuxCalls(log);
    assert.equal(calls.filter(c => c[1] === 'new-session').length, 1, 'one shared session');
    assert.equal(calls.filter(c => c[0] === 'terminal').length, 1, 'a Terminal is opened once when no client is attached');
    for (const trial of ctx.study.trials) {
      const name = windowName({ condition: trial.condition, trialId: trial.id });
      assert.ok(calls.some(c => c[1] === 'new-window' && c.includes(name)), name);
      assert.ok(calls.some(c => c[1] === 'kill-window' && c.includes(`hivemind-study:${name}`)), `${name} closed`);
    }
    assert.deepEqual(calls.filter(c => c[1] === 'select-pane').map(c => c.at(-1)).slice(0, 4), ['brain', 'worker-1', 'worker-2', 'server']);
    assert.match(calls.find(c => c[1] === 'new-window').at(-1), /seat-log-viewer\.mjs' --dir '.*attempt-001' --seat 'brain'/);
  } finally { ctx.cleanup(); }

  const broken = setup({ first: 'auto' });
  try {
    const log = path.join(broken.dir, 'tmux.log');
    const watcher = createWatcher({ enabled: true, env: {}, tmux: [process.execPath, fakeTmux, log, 'fail'], openTerminal: null });
    assert.equal((await broken.execute({ maxTrials: 1, hostOptions: { watcher } })).status, 'paused');
    assert.equal(exportRun({ runDir: broken.runDir }).study.trials[0].observed.outcome, 'passed', 'a failing viewer never affects the trial');
    const journal = readFileSync(path.join(broken.runDir, 'trials', broken.study.trials[0].id, 'journal.jsonl'), 'utf8');
    assert.ok(!/tmux|watch/i.test(journal), 'the viewer leaves no trace in the journal');
  } finally { broken.cleanup(); }
});

const journalRecords = (ctx, trialId) => readFileSync(path.join(ctx.runDir, 'trials', trialId, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('concurrent blocks share the load, and seat launches stay serialized across every running trial', { timeout: 180_000 }, async () => {
  const ctx = setup({ repeats: 2 });
  try {
    assert.deepEqual(await ctx.execute({ concurrency: 10 }), { status: 'complete', trialId: null, executed: 10 });
    const { study, report } = exportRun({ runDir: ctx.runDir });
    assert.ok(study.trials.every(t => t.observed.outcome === 'passed'));
    // Across all ten trials (two blocks at once), no opencode seat starts until the previous one has joined.
    const trace = readFileSync(`${ctx.control}.trace-trials`, 'utf8').trim().split('\n').map(l => l.split(' '));
    assert.equal(trace.filter(([kind]) => kind === 'start').length, 30);
    for (let i = 0; i < trace.length; i += 2) assert.deepEqual([trace[i][0], trace[i + 1][0], trace[i + 1][1]], ['start', 'joined', trace[i][1]], `launch ${i / 2}`);
    assert.equal(new Set(trace.map(([, seat]) => seat.split('/')[0])).size, 10);
    for (const [index, t] of report.trials.entries()) {
      assert.equal(t.load.concurrency, 10); assert.equal(t.load.blockIndex, Math.floor(index / 5));
      assert.ok(t.load.concurrentWith.length >= 4 && !t.load.concurrentWith.includes(t.id), `${t.id} overlapped its block`);
      assert.equal(journalRecords(ctx, t.id).find(r => r.type === 'started').concurrency, 10);
    }
    assert.ok(report.trials.some(t => t.load.concurrentWith.some(id => report.trials.find(o => o.id === id).load.blockIndex !== t.load.blockIndex)),
      'two blocks ran side by side');
    assert.deepEqual(report.concurrency.downgrades, []);
  } finally { ctx.cleanup(); }
});

test('a provider 429 reported by a seat downgrades later scheduling to one block without touching running trials', { timeout: 180_000 }, async () => {
  const ctx = setup({ repeats: 3 });
  try {
    ctx.setBehavior('complete', 40, { rateLimited: true });
    assert.equal((await ctx.execute({ concurrency: 10 })).status, 'complete');
    const { study, report } = exportRun({ runDir: ctx.runDir });
    assert.ok(study.trials.every(t => t.observed.outcome === 'passed'), 'running trials are never killed');
    assert.equal(report.concurrency.downgrades[0].reason, 'rate_limited');
    assert.deepEqual([report.concurrency.downgrades[0].from, report.concurrency.downgrades[0].to], [10, 5]);
    assert.ok(journalRecords(ctx, study.trials[0].id).find(r => r.type === 'completed').rateLimited);
    assert.ok(report.trials.slice(10).every(t => t.load.concurrency === 5), 'the third block ran alone');
  } finally { ctx.cleanup(); }
});
