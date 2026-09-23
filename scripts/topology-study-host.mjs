// Live host for the #136 topology-study runner: one fresh isolated Hivemind server, home and workspace per trial,
// a brain plus exactly `freeWorkers` worker seats, and the Human request sent with the condition's routing settings.
//
// This module is loaded only by `run` (the paid path) and by fake-host tests. It never reads the Human's normal
// ~/.hivemind: every trial passes an explicit HIVEMIND_HOME inside the run directory.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { exportAdaptiveEvidence } from '../src/server/adaptive-evidence.ts';
import { Storage } from '../src/server/storage.ts';
import { TOPOLOGY_POLICY_VERSION } from '../src/shared/adaptive-topology-policy.ts';
import { validJevModel } from '../src/shared/jev-model.ts';
import { MCP_HEARTBEAT_MS, MCP_WAIT_POLL_MS } from '../src/shared/types.ts';
import { hostInvocation } from './run-coordination-pilot-codex.mjs';
import { createWatcher, watchEnabled } from './topology-study-watch.mjs';
import { createSeatDataDir, sweepStaleSeatDataDirs } from './opencode-seat-data.mjs';

export const JEV_KEY_ENV = 'HIVEMIND_STUDY_TYPESAFE_KEY';
const COLLECTOR_WARNINGS = ['Adaptive evidence recording unavailable', 'Adaptive evidence outcome unavailable'];

class HttpError extends Error {
  constructor(status, detail) { super(`HTTP ${status}`); this.status = status; this.detail = detail; }
}

export function brainPrompt(spec) {
  return [
    'Seat: brain',
    'You are the brain seat of a Hivemind topology-study trial. Use only the hivemind MCP tools and the workspace directory you were started in.',
    'Call join with role "brain" and then wait. The Human sends exactly one request in a direct message.',
    'Follow the Hivemind adaptive topology directive that accompanies it: respect the executionId, the applied topology and the worker budget; you choose subtasks and workers.',
    'Write every deliverable into the workspace. When the request is complete and every delegated task/thread is reconciled, mark the Human request thread done and stop.',
    'Do not read files outside the workspace and do not contact the Human for approval; nobody will answer.',
    `Trial ${spec.trialId}; attempt ${spec.attempt}.`,
  ].join('\n');
}
export function workerPrompt(spec, index) {
  return [
    'Seat: worker',
    `You are worker seat ${index + 1} of a Hivemind topology-study trial. Use only the hivemind MCP tools and the workspace directory you were started in.`,
    'Call join with role "worker" and seniority "senior", then wait. Do only the work a brain assigns to you, report the outcome in its thread, and call wait again.',
    'Do not read files outside the workspace.',
    `Trial ${spec.trialId}; attempt ${spec.attempt}.`,
  ].join('\n');
}

function gitCheckout(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' });
  return { revision: head.status === 0 ? head.stdout.trim() : null, clean: status.status === 0 && status.stdout.trim() === '' };
}

/** Starts `hivemind serve` on an ephemeral loopback port with an isolated HIVEMIND_HOME. */
async function startIsolatedServer({ repoRoot, home, logPath, imports, env, timeoutMs = 30_000 }) {
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', ...imports.flatMap(file => ['--import', file]), path.join(repoRoot, 'src/cli.ts'), 'serve', '--port', '0'],
    { cwd: repoRoot, env: { ...env, HIVEMIND_HOME: home, HIVEMIND_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exited = false;
  child.on('close', () => { exited = true; log.end(); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hivemind server did not start')), timeoutMs);
    const onData = chunk => {
      log.write(chunk); output += chunk.toString('utf8');
      const match = /hivemind on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('close', code => { clearTimeout(timer); reject(new Error(`Hivemind server exited with ${code}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}`, exited: () => exited };
}
async function stopChild(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await closed; clearTimeout(timer);
}

async function humanClient(base) {
  const session = await fetch(`${base}/api/ui/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' } });
  if (!session.ok) throw new HttpError(session.status, 'session');
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]?.trim();
  if (!cookie) throw new Error('No Human session cookie');
  const headers = { origin: base, cookie, 'x-hivemind-ui': '1', 'content-type': 'application/json' };
  const call = async (method, route, body) => {
    const init = { method, headers, signal: AbortSignal.timeout(120_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${base}${route}`, init);
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, text.slice(0, 200));
    return JSON.parse(text);
  };
  return { get: route => call('GET', route), post: (route, body) => call('POST', route, body), put: (route, body) => call('PUT', route, body) };
}

/** OpenCode `step_finish.part.tokens.total` is cumulative per seat: keep the latest valid value, readable mid-run for budgets. */
export function liveUsage() {
  let pending = '', latest = null;
  const consume = line => {
    if (!line.trim().startsWith('{')) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const value = event?.type === 'step_finish' ? event?.part?.tokens?.total : undefined;
    if (Number.isSafeInteger(value) && value >= 0) latest = value;
  };
  return {
    push(chunk) { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''; lines.forEach(consume); },
    finish() { if (pending) consume(pending); pending = ''; return latest; },
    latest: () => latest,
  };
}

function startSeat({ command, args, stdin, env, cwd, attemptDir, name, logName = name, clock = Date.now, dataDir = null }) {
  const out = createWriteStream(path.join(attemptDir, `${logName}.stdout.log`), { flags: 'wx', mode: 0o600 });
  const err = createWriteStream(path.join(attemptDir, `${logName}.stderr.log`), { flags: 'wx', mode: 0o600 });
  const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const usage = liveUsage();
  let spawnError = null, stderrTail = '', rateLimited = false, pendingOut = '';
  // Stall watchdog input: when the seat last wrote anything, and the type/time of its last opencode event.
  const startedAt = clock();
  let lastOutputAt = startedAt, lastEvent = null, lastEventAt = null;
  // Provider throttling shows up as opencode `error` events or on stderr; agent text and tool output are never scanned
  // (a workload may legitimately talk about rate limits).
  const scanOut = chunk => {
    const lines = (pendingOut + chunk.toString('utf8')).split(/\r?\n/);
    pendingOut = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (typeof event?.type === 'string') { lastEvent = event.type; lastEventAt = clock(); }
      if (event?.type === 'error' && RATE_LIMIT_ERROR.test(JSON.stringify(event.error ?? ''))) rateLimited = true;
    }
  };
  child.stdout.on('data', chunk => { lastOutputAt = clock(); out.write(chunk); usage.push(chunk); scanOut(chunk); });
  child.stderr.on('data', chunk => {
    err.write(chunk); stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8_192);
    if (RATE_LIMIT_ERROR.test(chunk.toString('utf8'))) rateLimited = true;
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin ?? undefined);
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.on('close', () => {
    out.end(); err.end(); usage.finish();
    // The seat's private opencode data (database, logs, auth symlink) never outlives the seat.
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    resolve();
  }));
  return { name, child, closed, spawnError: () => spawnError, tokens: () => usage.latest(), stderrTail: () => stderrTail, rateLimited: () => rateLimited,
    activity: () => ({ lastOutputAt, lastEvent, lastEventAt }), agentId: null,
    exited: () => child.exitCode !== null || child.signalCode !== null };
}

export { createSeatDataDir, SEAT_DATA_PREFIX, sweepStaleSeatDataDirs } from './opencode-seat-data.mjs';

/**
 * Hive activity window. A seat blocked in `hivemind wait` long-polls every MCP_WAIT_POLL_MS (20 s) and the server
 * records presence at most every 15 s, so its lastSeenAt is never older than ~35 s. The MCP process also pings every
 * MCP_HEARTBEAT_MS (150 s) whatever the model is doing, so presence refreshed only by that ping is NOT activity.
 */
export const HIVE_ACTIVE_MS = 60_000;
if (!(MCP_WAIT_POLL_MS + 15_000 < HIVE_ACTIVE_MS && HIVE_ACTIVE_MS < MCP_HEARTBEAT_MS)) throw new Error('HIVE_ACTIVE_MS no longer separates wait polls from heartbeats');

/**
 * Provider stall: a running seat that has written nothing on stdout for longer than stallTimeoutMs and is not active in
 * the hive (no wait poll or tool call within HIVE_ACTIVE_MS). OpenCode has no stream timeout, so a hung provider stream
 * would otherwise hold the trial until the wall budget. An idle seat waiting for mail is never a stall.
 */
export function findStalledSeat({ now, stallTimeoutMs, seats, hiveActiveMs = HIVE_ACTIVE_MS }) {
  for (const seat of seats) {
    if (seat.exited) continue;
    const silentMs = now - (seat.lastOutputAt ?? 0);
    const hiveActive = seat.hiveSeenAt !== null && seat.hiveSeenAt !== undefined && now - seat.hiveSeenAt <= hiveActiveMs;
    if (silentMs > stallTimeoutMs && !hiveActive) {
      return { reason: 'provider_stall', seat: seat.name, openStep: seat.lastEvent === 'step_start', lastEvent: seat.lastEvent ?? null,
        lastEventAt: seat.lastEventAt ?? null, lastOutputAt: seat.lastOutputAt ?? null, hiveSeenAt: seat.hiveSeenAt ?? null,
        detectedAt: now, silentMs, stallTimeoutMs };
    }
  }
  return null;
}

/** OpenCode keeps one local SQLite store per user; seats started at the same instant can fail on its lock. */
export const SEAT_LOCK_ERROR = /database is locked/i;
/** Provider throttling or quota exhaustion reported by a seat; the runner then schedules one block at a time. */
export const RATE_LIMIT_ERROR = /\b429\b|rate[ _-]?limit|too many requests|quota/i;

// Process-wide: concurrent trials never start two opencode processes at the same instant. The lock is held from a
// seat's spawn until it joins, exits or `seatLaunchHoldMs` passes, whichever comes first.
let seatLaunchChain = Promise.resolve();
export function withSeatLaunchLock(fn) {
  const run = seatLaunchChain.then(fn, fn);
  seatLaunchChain = run.then(() => undefined, () => undefined);
  return run;
}

function readEvidence(dbPath, executionId) {
  if (!existsSync(dbPath)) return { evidence: null, jevAttempts: 0 };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    // One read transaction, so counters and detail belong to the same snapshot (as in export-topology-evidence.mjs).
    return Storage.for(db).transaction(() => {
      const calls = table('jev_calls') ? Number(db.prepare('SELECT COUNT(*) AS n FROM jev_calls').get().n) : 0;
      const recorded = table('adaptive_evidence_runs') ? Number(db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get().n) : 0;
      let evidence = null;
      if (executionId) { try { evidence = exportAdaptiveEvidence(db, executionId); } catch { evidence = null; } }
      return { evidence, jevAttempts: Math.max(calls, recorded) };
    }, { immediate: false });
  } finally { db.close(); }
}

/** The retained raw home must not keep the TypeSafe key after the trial. */
function scrubCredential(home) {
  const file = path.join(home, 'adaptive-routing.json');
  if (!existsSync(file)) return;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.apiKey) writeFileSync(file, JSON.stringify({ ...value, apiKey: '[redacted-after-trial]' }, null, 2) + '\n', { mode: 0o600 });
  } catch { writeFileSync(file, '{"redacted":true}\n', { mode: 0o600 }); }
}

async function runAcceptance(acceptancePath, workspace, timeoutMs) {
  const child = spawn(process.execPath, [acceptancePath, workspace], { cwd: workspace, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-65_536); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0) return null;
  try {
    const verdict = JSON.parse(stdout.trim().split('\n').at(-1));
    return typeof verdict.passed === 'boolean' && Number.isSafeInteger(verdict.defects) && verdict.defects >= 0
      ? { passed: verdict.passed, defects: verdict.defects } : null;
  } catch { return null; }
}

/**
 * @param {object} options
 * @param {string} options.repoRoot   checkout whose `src/cli.ts` serves each trial
 * @param {object} options.plan       run.json (host name/version and requested Jev model)
 * @param {object} options.env        environment; the TypeSafe key is read from HIVEMIND_STUDY_TYPESAFE_KEY
 * @param {string[]} [options.seatCommand]   defaults to $OPENCODE_BIN or `opencode`
 * @param {string[]} [options.serverImports] extra --import modules for the trial server (tests: a fake Jev)
 * @param {object} [options.seatEnv]  extra seat environment (tests: fake seat control)
 * @param {'live'|'synthetic'} [options.evidenceKind] tests using fake seats must label their output synthetic
 * @param {number} [options.joinTimeoutMs]  bound for the whole sequential seat start-up (all seats online)
 * @param {number} [options.seatLockRetries]  retries of a seat that exits on opencode's "database is locked" before joining
 * @param {number} [options.seatRetryBackoffMs]  wait before such a retry
 * @param {number} [options.seatLaunchHoldMs]  longest time the process-wide launch lock is held for one seat start
 * @param {number} [options.stallTimeoutMs]  a seat silent on stdout and in the hive for longer is a provider stall
 * @param {() => number} [options.clock]  wall clock for seat activity (tests)
 * @param {number} [options.hiveActiveMs]  presence newer than this counts as hive activity (tests shorten it)
 * @param {boolean} [options.isolateSeatData]  private opencode data dir per seat (auth.json symlinked, never copied)
 * @param {boolean} [options.watch]  open the live tmux viewer (also HIVEMIND_STUDY_WATCH=1); never affects trials
 * @param {object} [options.watcher]  injected viewer (tests)
 */
export function createHivemindHost({ repoRoot, plan, env, seatCommand, serverImports = [], seatEnv = {}, serverEnv = {},
  evidenceKind = 'live', probeCheckout = gitCheckout, joinTimeoutMs = 600_000, pollMs = 500, acceptanceTimeoutMs = 120_000,
  seatLockRetries = 1, seatRetryBackoffMs = 2_000, seatLaunchHoldMs = 5_000, watch = false, watcher = null,
  stallTimeoutMs = 300_000, hiveActiveMs = HIVE_ACTIVE_MS, clock = Date.now, isolateSeatData = true, seatDataRoot = os.tmpdir() }) {
  if (plan.host.name !== 'opencode') throw new Error('Only the opencode seat host is wired for live runs');
  const command = seatCommand ?? [String(env.OPENCODE_BIN ?? '').trim() || 'opencode'];
  const jevKey = String(env[JEV_KEY_ENV] ?? '').trim();
  // Seats and the trial server never receive the study's TypeSafe key through their environment.
  const baseEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== JEV_KEY_ENV));
  // Optional live tmux viewer (read-only log followers); best effort and outside the evidence path.
  const viewer = watcher ?? createWatcher({ enabled: watchEnabled({ watch, env }), env });
  if (isolateSeatData) sweepStaleSeatDataDirs(seatDataRoot);

  function probeVersion() {
    const found = spawnSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8', timeout: 15_000,
      env: { ...baseEnv, ...seatEnv, OPENCODE_DISABLE_AUTOUPDATE: 'true' } });
    const version = found.status === 0 ? found.stdout.trim().split(/\s+/).at(-1) : null;
    return version && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version) ? version : null;
  }

  /**
   * Reports what this host will actually apply. Provider/model/configuration are the values passed to the seat CLI
   * (the resolved provider model is not observable from opencode output); the binary version, checkout, policy
   * version, Jev model setting and credentials are probed.
   */
  async function preflight({ versions }) {
    const version = probeVersion();
    const configuration = /(^|[;,\s])auto(?:=true)?($|[;,\s])/i.test(versions.configuration) ? versions.configuration : null;
    return { checkout: probeCheckout(repoRoot),
      versions: { provider: versions.provider, model: versions.model, configuration, host: version ? `${plan.host.name}/${version}` : null,
        policyVersion: TOPOLOGY_POLICY_VERSION },
      jevRequestedModel: validJevModel(plan.jev.requestedModel) ? plan.jev.requestedModel : null,
      credentials: { jev: jevKey.length > 0 } };
  }

  async function executeTrial(spec, signal) {
    const imports = serverImports.map(file => path.resolve(file));
    let server = null;
    const seats = [];
    const artifacts = ['server.log'];
    const aborted = (reason, drift = [], detail = null) => ({ phase: 'aborted_before_request', reason, drift, detail,
      rateLimited: seats.some(seat => seat.rateLimited()) });
    let requestSent = false;
    const cleanup = async () => {
      await Promise.all(seats.map(seat => stopChild(seat.child)));
      await Promise.all(seats.map(seat => seat.closed));
      if (server) await stopChild(server.child);
      scrubCredential(spec.home);
      viewer.trialEnded(spec);
    };
    viewer.trialStarted(spec);
    try {
      try { server = await startIsolatedServer({ repoRoot, home: spec.home, logPath: path.join(spec.attemptDir, 'server.log'), imports, env: { ...baseEnv, ...serverEnv } }); }
      catch { return aborted('server_start_failed'); }
      const human = await humanClient(server.base);
      const pinned = plan.jev.pinned ? { model: spec.jevRequestedModel } : {};
      if (spec.jevEnabled) {
        if (!jevKey) return aborted('missing_jev_credentials');
        await human.put('/api/ui/adaptive-routing', { enabled: true, apiKey: jevKey, ...pinned });
      } else await human.put('/api/ui/adaptive-routing', { enabled: false, ...pinned });
      const settings = await human.get('/api/ui/adaptive-routing');
      const drift = [];
      if (settings.enabled !== spec.jevEnabled) drift.push({ field: 'jev.enabled', expected: spec.jevEnabled, actual: settings.enabled });
      if (spec.jevEnabled && settings.model !== spec.jevRequestedModel) drift.push({ field: 'jev.requestedModel', expected: spec.jevRequestedModel, actual: settings.model });
      if (drift.length) return aborted('config_drift', drift);

      const identities = path.join(spec.attemptDir, 'agent-identities');
      const seatBase = { ...baseEnv, ...seatEnv, HIVEMIND_URL: server.base, HIVEMIND_HOME: identities, OPENCODE_DISABLE_AUTOUPDATE: 'true' };
      const dataLog = [];
      const launch = (name, prompt, logName = name) => {
        // opencode addresses models as provider/model; the manifest pins them separately.
        const versions = { ...spec.versions, host: plan.host.name, model: `${spec.versions.provider}/${spec.versions.model}` };
        const data = isolateSeatData ? createSeatDataDir({ env: baseEnv, tmpRoot: seatDataRoot }) : null;
        const invocation = hostInvocation({ versions }, prompt, { ...seatBase, ...data?.env }, repoRoot, true, spec.workspace);
        artifacts.push(`${logName}.stdout.log`, `${logName}.stderr.log`);
        dataLog.push({ seat: logName, isolated: Boolean(data), authLinked: data?.authLinked ?? null });
        return startSeat({ command, args: invocation.args, stdin: invocation.stdin, env: invocation.env, cwd: spec.workspace,
          attemptDir: spec.attemptDir, name, logName, clock, dataDir: data?.dir ?? null });
      };
      const online = async role => (await human.get('/api/ui/snapshot')).agents.filter(a => a.role === role && a.online);

      // Seats start one at a time and each must be online before the next starts, so opencode processes never race on
      // opencode's own local database at startup. A seat that exits on that lock before joining is retried once after a
      // short backoff; any other exit, or a second lock failure, is a genuine `seats_did_not_join`. The whole sequence
      // is bounded by joinTimeoutMs, and every start/retry is retained in seat-launch.json.
      const deadline = Date.now() + joinTimeoutMs;
      const planned = [['brain', brainPrompt(spec), 'brain'],
        ...Array.from({ length: spec.freeWorkers }, (_, i) => [`worker-${i + 1}`, workerPrompt(spec, i), 'worker'])];
      const launchLog = [];
      const writeLaunchLog = () => writeFileSync(path.join(spec.attemptDir, 'seat-launch.json'),
        JSON.stringify({ sequential: true, seats: launchLog, opencodeData: dataLog }, null, 2) + '\n', { mode: 0o600 });
      artifacts.push('seat-launch.json');
      let brain = null;
      for (const [name, prompt, role] of planned) {
        const beforeIds = new Set((await online(role)).map(a => a.id));
        const before = beforeIds.size; // this seat has joined once its role count grows past this
        const entry = { seat: name, starts: 1, retries: [], joined: false, failure: null, lockWaitMs: [] };
        launchLog.push(entry);
        // `register` records the spawned process immediately, so cleanup stops it even if polling fails while locked.
        const startLocked = (logName, register) => {
          const queued = Date.now();
          return withSeatLaunchLock(async () => {
            entry.lockWaitMs.push(Date.now() - queued);
            const started = launch(name, prompt, logName), heldUntil = Date.now() + seatLaunchHoldMs;
            register(started);
            while (Date.now() < heldUntil && !started.exited() && !signal?.aborted && (await online(role)).length <= before) await delay(pollMs);
            return started;
          });
        };
        let seat = await startLocked(name, spawned => seats.push(spawned));
        for (;;) {
          if (signal?.aborted) { writeLaunchLog(); return aborted('interrupted_before_request'); }
          const lost = seats.slice(0, -1).find(earlier => earlier.exited());
          if (lost) {
            launchLog.find(e => e.seat === lost.name).failure = 'exited_after_join';
            writeLaunchLog();
            return aborted('seats_did_not_join', [], `${lost.name} exited_after_join`);
          }
          const present = await online(role);
          if (present.length > before) {
            entry.joined = true;
            seat.agentId = present.find(a => !beforeIds.has(a.id))?.id ?? null;
            if (role === 'brain') brain = present[0];
            break;
          }
          if (seat.exited()) {
            await seat.closed;
            const locked = SEAT_LOCK_ERROR.test(seat.stderrTail());
            if (!locked || entry.retries.length >= seatLockRetries || Date.now() + seatRetryBackoffMs >= deadline) {
              entry.failure = locked ? 'database_locked' : 'exited_before_join';
              writeLaunchLog();
              return aborted('seats_did_not_join', [], `${name} ${entry.failure} (exit ${seat.child.exitCode ?? seat.child.signalCode})`);
            }
            entry.retries.push({ reason: 'database_locked', exitCode: seat.child.exitCode, backoffMs: seatRetryBackoffMs });
            await delay(seatRetryBackoffMs);
            entry.starts++;
            seat = await startLocked(`${name}.retry-${entry.retries.length}`, spawned => { seats[seats.length - 1] = spawned; });
            continue;
          }
          if (Date.now() >= deadline) {
            entry.failure = 'join_timeout';
            writeLaunchLog();
            return aborted('seats_did_not_join', [], `${name} join_timeout`);
          }
          await delay(pollMs);
        }
      }
      writeLaunchLog();
      if (!brain) return aborted('seats_did_not_join');
      await delay(pollMs); // let any late join settle before verifying the exact count
      const settled = (await human.get('/api/ui/snapshot')).agents;
      const observedFreeWorkers = settled.filter(a => a.role === 'worker' && a.online).length;
      if (observedFreeWorkers !== spec.freeWorkers || settled.filter(a => a.role === 'brain').length !== 1)
        return aborted('capacity_mismatch', [{ field: 'freeWorkers', expected: spec.freeWorkers, actual: observedFreeWorkers }]);

      const dm = await human.post('/api/ui/dms', { name: brain.name });
      const body = readFileSync(spec.inputPath, 'utf8');
      const started = performance.now();
      requestSent = true;
      let sent;
      try {
        sent = await human.post(`/api/ui/channels/${encodeURIComponent(dm.channel.id)}/messages`, {
          requestId: `study-${spec.trialId}-${spec.attempt}-${randomUUID()}`, body, routing: spec.routing, lockScope: spec.lockScope });
      } catch (error) {
        // A rejected request (4xx) never started; anything else may have reached the server: reconcile, never resend.
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) return aborted('request_rejected');
        return { phase: 'ambiguous', reason: 'lost_request_response' };
      }
      const executionId = sent.adaptiveState?.executionId ?? null;
      const initialTopology = sent.adaptiveState?.currentTopology ?? null;
      const channelRoute = `/api/ui/channels/${encodeURIComponent(dm.channel.id)}/adaptive-routing`;
      const lockEvents = view => new Set(view.events.filter(e => e.kind === 'lock' && e.executionId === executionId).map(e => e.id));
      const initialLocks = lockEvents(await human.get(channelRoute));

      let outcome = null, interruption = null, wallMs = null, completed = false, brainGoneAt = null, stall = null;
      const checkStall = async () => {
        const now = clock();
        const quiet = seats.filter(seat => !seat.exited() && now - seat.activity().lastOutputAt > stallTimeoutMs);
        if (!quiet.length) return null;
        let agents = [];
        try { agents = (await human.get('/api/ui/snapshot')).agents; } catch { agents = []; }
        const seen = new Map(agents.map(a => [a.id, a.lastSeenAt]));
        return findStalledSeat({ now, stallTimeoutMs, hiveActiveMs, seats: quiet.map(seat => ({ name: seat.name, exited: seat.exited(), ...seat.activity(),
          hiveSeenAt: seat.agentId ? seen.get(seat.agentId) ?? null : null })) });
      };
      const knownTokens = () => seats.reduce((sum, seat) => sum + (seat.tokens() ?? 0), 0);
      while (outcome === null) {
        const elapsed = performance.now() - started;
        if (signal?.aborted) { outcome = 'interrupted'; interruption = 'signal'; wallMs = elapsed; break; }
        if (elapsed > spec.limits.wallMs) { outcome = 'interrupted'; interruption = 'wall_budget'; wallMs = elapsed; break; }
        if (knownTokens() > spec.limits.workloadTokens) { outcome = 'interrupted'; interruption = 'token_budget'; wallMs = elapsed; break; }
        if (server.exited()) { outcome = 'harness_failed'; wallMs = elapsed; break; }
        stall = await checkStall();
        if (stall) { outcome = 'harness_failed'; wallMs = performance.now() - started; break; }
        let view;
        try { view = await human.get(channelRoute); } catch { outcome = 'harness_failed'; wallMs = performance.now() - started; break; }
        const execution = view.executions.find(e => e.executionId === executionId);
        if (execution?.completedAt) { completed = true; wallMs = performance.now() - started; break; }
        if (seats[0].exited()) {
          brainGoneAt ??= Date.now();
          if (Date.now() - brainGoneAt > pollMs * 4) { outcome = 'harness_failed'; wallMs = performance.now() - started; break; }
        }
        await delay(pollMs);
      }
      const finalView = await human.get(channelRoute).catch(() => null);
      const routingOverrides = finalView ? [...lockEvents(finalView)].filter(id => !initialLocks.has(id)).length : 0;
      await Promise.all(seats.map(seat => stopChild(seat.child)));
      await Promise.all(seats.map(seat => seat.closed));
      await stopChild(server.child);
      const { evidence, jevAttempts } = readEvidence(path.join(spec.home, 'hive.db'), spec.jevEnabled ? executionId : null);
      const log = readFileSync(path.join(spec.attemptDir, 'server.log'), 'utf8');
      const collectorWarnings = COLLECTOR_WARNINGS.reduce((n, text) => n + log.split(text).length - 1, 0);
      let acceptance = null;
      if (stall) { writeFileSync(path.join(spec.attemptDir, 'stall.json'), JSON.stringify(stall, null, 2) + '\n', { mode: 0o600 }); artifacts.push('stall.json'); }
      if (completed) {
        acceptance = await runAcceptance(spec.acceptancePath, spec.workspace, acceptanceTimeoutMs);
        outcome = acceptance === null ? 'harness_failed' : acceptance.passed ? 'passed' : 'quality_failed';
      }
      return { phase: 'completed', observedFreeWorkers, jevEnabled: settings.enabled, jevRequestedModel: settings.model ?? null,
        jevAttempts, initialTopology, routingOverrides, outcome, interruption, wallMs,
        seatUsage: seats.map(seat => ({ seat: seat.name, tokens: seat.tokens() })),
        // opencode output does not expose a resolved provider model we can verify; unknown, never assumed.
        resolvedWorkloadModels: null, acceptance, routerEvidence: spec.jevEnabled ? evidence : null, collectorWarnings, artifacts,
        rateLimited: seats.some(seat => seat.rateLimited()), stall };
    } catch (error) {
      // Before the Human request, nothing ran: retain the attempt as aborted. After it, the outcome is unknown.
      if (!requestSent) return aborted('harness_setup_failed', [], String(error?.message ?? error));
      throw error;
    } finally { await cleanup(); }
  }

  return { kind: 'hivemind-opencode', evidenceKind, preflight, executeTrial };
}
