import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { loadFixtures } from './benchmark-coordination.mjs';
import {
  REAL_AGENT_PROMPT_VERSION,
  expectedTaskOutputs,
  validateRealTrial,
} from './benchmark-coordination-real.mjs';

export const BENCHMARK_PORT = 7420;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const RUNNER_SCHEMA_VERSION = 1;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function hostExecutable(host, env = process.env) {
  if (host === 'codex') {
    const value = String(env.CODEX_BIN ?? '').trim();
    return value || 'codex';
  }
  if (host === 'opencode') {
    const value = String(env.OPENCODE_BIN ?? '').trim();
    return value || 'opencode';
  }
  throw new Error(`Unsupported real-agent host: ${host}`);
}

export function codexExecutable(env = process.env) {
  return hostExecutable('codex', env);
}

export function parseProviderTokens(text) {
  const matches = [...String(text).matchAll(/tokens used\s*\n\s*([0-9][0-9.,]*)/gi)];
  if (!matches.length) return null;
  const digits = matches.at(-1)[1].replace(/[.,]/g, '');
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseReasoningEffort(configuration) {
  const match = /(?:^|[;,\s])reasoning=([a-z0-9_-]+)/i.exec(String(configuration));
  return match?.[1] ?? null;
}

export function codexArgs(trial) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--model', trial.versions.model,
  ];
  const effort = parseReasoningEffort(trial.versions.configuration);
  if (effort) args.push('--config', `model_reasoning_effort="${effort}"`);
  args.push(
    '--config', 'agents.enabled=false',
    '--config', 'web_search="disabled"',
    '--config', 'memories.use_memories=false',
    '--config', 'memories.generate_memories=false',
    '--sandbox', 'workspace-write',
    '-',
  );
  return args;
}

export function opencodeArgs(trial, prompt) {
  assert.equal(trial.versions.host, 'opencode');
  assert.match(trial.versions.configuration, /(^|[;,\s])auto(?:=true)?($|[;,\s])/i,
    'OpenCode pilot configuration must record --auto as configuration=auto');
  return [
    '--pure',
    'run',
    '--standalone',
    '--model', trial.versions.model,
    '--auto',
    '--format', 'json',
    prompt,
  ];
}

export function hostInvocation(trial, prompt, baseEnv, repoRoot, withHivemind) {
  if (trial.versions.host === 'codex') {
    return { args: codexArgs(trial), stdin: prompt, env: baseEnv };
  }
  if (trial.versions.host === 'opencode') {
    const config = {
      tools: { task: false },
      ...(withHivemind ? {
        mcp: {
          hivemind: {
            type: 'local',
            command: [process.execPath, '--import', 'tsx', path.join(repoRoot, 'src/cli.ts'), 'mcp'],
            cwd: repoRoot,
            enabled: true,
            environment: {
              HIVEMIND_URL: baseEnv.HIVEMIND_URL,
              HIVEMIND_HOME: baseEnv.HIVEMIND_HOME,
            },
          },
        },
      } : {}),
    };
    return {
      args: opencodeArgs(trial, prompt),
      stdin: null,
      env: {
        ...baseEnv,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      },
    };
  }
  throw new Error(`Unsupported real-agent host: ${trial.versions.host}`);
}

export function strictTrialFiles(dir) {
  return readdirSync(dir).filter(name => /^trial-[a-f0-9]{16}\.json$/.test(name)).sort();
}

export function expectedArtifact(trial, fixture) {
  return {
    schemaVersion: 1,
    fixtureId: fixture.id,
    seed: trial.trial.seed,
    repeatIndex: trial.trial.repeatIndex,
    taskOutputs: expectedTaskOutputs(fixture, trial.trial.seed, trial.trial.repeatIndex),
  };
}

export function reviewArtifact(value, trial, fixture) {
  const expected = expectedArtifact(trial, fixture);
  const defects = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { acceptancePassed: false, defects: fixture.tasks.length + 1, issues: ['artifact is not an object'], expected };
  }
  for (const key of ['schemaVersion', 'fixtureId', 'seed', 'repeatIndex']) {
    if (value[key] !== expected[key]) defects.push(`${key}: expected ${JSON.stringify(expected[key])}`);
  }
  const outputs = value.taskOutputs && typeof value.taskOutputs === 'object' && !Array.isArray(value.taskOutputs)
    ? value.taskOutputs : {};
  for (const [taskId, wanted] of Object.entries(expected.taskOutputs)) {
    if (outputs[taskId] !== wanted) defects.push(`taskOutputs.${taskId} mismatch or missing`);
  }
  for (const taskId of Object.keys(outputs)) {
    if (!Object.hasOwn(expected.taskOutputs, taskId)) defects.push(`unexpected taskOutputs.${taskId}`);
  }
  return { acceptancePassed: defects.length === 0, defects: defects.length, issues: defects, expected };
}

export function seatPlan(trial, fixture) {
  const workflow = trial.trial.workflow;
  if (workflow === 'single_worker') return [{ id: 'single', role: 'single', worker: null }];
  const workers = workflow === 'brain_one_worker' ? fixture.workers.slice(0, 1) : fixture.workers.slice(0, 3);
  return [
    ...workers.map((worker, index) => ({ id: `worker-${index + 1}`, role: 'worker', worker })),
    { id: 'brain', role: 'brain', worker: null },
  ];
}

function workerCapabilityCard(trial, worker) {
  return {
    enabled: true,
    capabilities: worker.capabilities,
    modes: ['implementation', 'review'],
    model: trial.versions.model,
    host: trial.versions.host,
    availableContext: null,
    availability: 'available',
    maxInProgress: 1,
  };
}

export function buildWorkerPrompt(trial, worker, seatIndex) {
  return [
    'You are a finite-lifecycle worker in a controlled Hivemind coordination benchmark.',
    'Use the real Hivemind MCP tools. Do not simulate tool results.',
    `Join with role=worker, seniority=mid, focus=${worker.id}, project=chapter.`,
    `After joining, call set_capabilities with expectedRevision=0 and this exact card: ${JSON.stringify(workerCapabilityCard(trial, worker))}.`,
    'Then call wait and take work only from the benchmark brain.',
    'For assigned tasks, compute the requested SHA-256 output exactly from the assignment material and dependency outputs. Use a local hash command/tool if useful.',
    'Report task acceptance/result through Hivemind structured-task tools and include the computed hash as inspectable evidence in the result.',
    'Do not create BENCHMARK_RESULT.json; only the brain assembles the final artifact.',
    'Ignore unrelated room observations unless they are explicitly relevant to your task.',
    'After reporting work, wait again. If the brain sends the exact direct message BENCHMARK_STOP, exit immediately instead of waiting again.',
    'BENCHMARK_STOP is a Human-authorized finite-run lifecycle exception for this benchmark only.',
    `Seat index: ${seatIndex}. Trial blind id: ${trial.blindId}.`,
  ].join('\n');
}

export function buildBrainPrompt(trial, fixture, workerCount, humanInstructionSeq = null) {
  const workflow = trial.trial.workflow;
  assert.notEqual(workflow, 'single_worker');
  if (workflow === 'brain_multi_room') {
    assert.ok(Number.isSafeInteger(humanInstructionSeq) && humanInstructionSeq > 0,
      'brain_multi_room requires a real Human instruction sequence');
  }
  const roomInstructions = workflow === 'brain_multi_room'
    ? [
        `A real Human-authored benchmark authorization message already exists in this project at message sequence ${humanInstructionSeq}. Use humanInstructionSeq=${humanInstructionSeq} on the initial room_event configure. Do not ask Human for another authorization.`,
        'Bootstrap the finite room deterministically: assign the first dependency-ready runbook task outside the room, then use that task ID as contract.originTaskId when configuring the room.',
        'Create one private collaboration channel with all benchmark workers as members. Do not invite a worker again if create_channel already included that worker.',
        'Configure one finite task-scoped room contract, then use its current contractVersion and stable actionKey values on remaining room-bound structured assignments.',
        fixture.id === 'noisy-room'
          ? 'Before the first peer clarification, post exactly 12 unrelated progress observations labelled noise-01 through noise-12 in that room; do not turn them into assignments.'
          : 'Do not add unrelated room traffic.',
      ]
    : [
        'Use task DMs only for worker coordination. Do not create a collaboration room.',
        'Any room-only noise instruction is not applicable in this workflow.',
      ];
  return [
    'You are the finite-lifecycle coordinating brain in a controlled Hivemind benchmark.',
    'Use the real Hivemind MCP tools. Do not simulate tool results.',
    'Join with role=brain, focus=benchmark, project=chapter.',
    `Exactly ${workerCount} benchmark worker seat(s) have already been started. Call agents once and use only workers in project chapter whose focus starts with worker-.`,
    'The benchmark runbook in this initial host prompt is already the Human task for this finite trial.',
    'After join, do not call wait before processing this initial Human task; the normal first-wait standing-order behavior resumes only when you actually need mail from workers.',
    'Do not perform worker task outputs yourself: coordinate workers, assign structured tasks, collect their results, verify submitted hashes when reviewing them, and request changes when evidence is wrong.',
    'Preserve the runbook dependency graph. Include each task baseInput and current dependency outputs in its assignment so the worker can compute the exact material.',
    'Use advisory capability/routing data when the runbook calls for worker routing.',
    ...roomInstructions,
    'When every task has an accepted result, write BENCHMARK_RESULT.json in the current workspace with the exact final JSON artifact required by the runbook.',
    'Then send the exact direct message BENCHMARK_STOP to every benchmark worker, print a concise final report, and exit.',
    'For this controlled benchmark only, exiting after BENCHMARK_STOP is a Human-authorized exception to the normal long-lived wait lifecycle.',
    '',
    '--- BEGIN BENCHMARK RUNBOOK ---',
    trial.runbook.prompt,
    '--- END BENCHMARK RUNBOOK ---',
  ].join('\n');
}

export function buildSinglePrompt(trial) {
  return [
    'You are the only model session in this controlled benchmark condition.',
    'Do not use Hivemind, native subagents, or delegation.',
    'Complete the runbook yourself in the current workspace.',
    'Write BENCHMARK_RESULT.json with the exact final JSON artifact required by the runbook, print a concise final report, and exit.',
    '',
    '--- BEGIN BENCHMARK RUNBOOK ---',
    trial.runbook.prompt,
    '--- END BENCHMARK RUNBOOK ---',
  ].join('\n');
}

export function humanRoomInstructionBody(trial) {
  return [
    `Benchmark authorization for ${trial.blindId}.`,
    'Human authorizes the coordinating brain to create and configure one finite task-scoped collaboration room for this trial only.',
    'Use only the benchmark workers in project chapter, preserve the generated runbook scope and dependencies, and do not grant broader authority.',
    'The room may be archived after the benchmark tasks are reviewed and the final result artifact is produced.',
  ].join(' ');
}

export async function seedHumanRoomInstruction(trial) {
  assert.equal(trial.trial.workflow, 'brain_multi_room');
  const base = `http://127.0.0.1:${BENCHMARK_PORT}`;
  const snapshotResponse = await fetch(`${base}/api/ui/snapshot`, { signal: AbortSignal.timeout(3_000) });
  if (!snapshotResponse.ok) throw new Error(`Cannot read benchmark Human snapshot: HTTP ${snapshotResponse.status}`);
  const snapshot = await snapshotResponse.json();
  const project = snapshot.projects?.find(value => value.slug === 'chapter');
  assert.ok(project, 'benchmark project chapter is missing');
  const channel = snapshot.channels?.find(value => value.projectId === project.id && String(value.name).toLowerCase() === 'general');
  assert.ok(channel, 'benchmark project #general channel is missing');
  const body = humanRoomInstructionBody(trial);
  const response = await fetch(`${base}/api/ui/channels/${encodeURIComponent(channel.id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `benchmark-authority-${trial.trialId}`, body }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Cannot seed benchmark Human authority: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const payload = await response.json();
  const seq = payload.message?.seq;
  assert.ok(Number.isSafeInteger(seq) && seq > 0, 'benchmark Human authority message has no positive seq');
  return { seq, channelId: channel.id, messageId: payload.message.id, body };
}

function appendTail(current, chunk, limit = 1_000_000) {
  const joined = current + chunk.toString('utf8');
  return joined.length > limit ? joined.slice(-limit) : joined;
}

function startSeat({ binary, args, cwd, stdin, stdoutPath, stderrPath, env, timeoutMs }) {
  mkdirSync(path.dirname(stdoutPath), { recursive: true });
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx' });
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutTail = '', stderrTail = '', timedOut = false;
  child.stdout.on('data', chunk => { stdoutTail = appendTail(stdoutTail, chunk); stdoutFile.write(chunk); });
  child.stderr.on('data', chunk => { stderrTail = appendTail(stderrTail, chunk); stderrFile.write(chunk); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin ?? undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  }, timeoutMs);
  timer.unref();
  const done = new Promise(resolve => {
    let spawnError = null;
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stdoutFile.end();
      stderrFile.end();
      resolve({
        code,
        signal,
        timedOut,
        error: spawnError ? String(spawnError.message ?? spawnError) : null,
        stdoutTail,
        stderrTail,
        providerTokens: parseProviderTokens(stdoutTail + '\n' + stderrTail),
      });
    });
  });
  return { child, done };
}

async function serverPortOccupied() {
  try {
    const response = await fetch(`http://127.0.0.1:${BENCHMARK_PORT}/api/health`, { signal: AbortSignal.timeout(700) });
    return response.status >= 100;
  } catch {
    return false;
  }
}

async function startIsolatedServer(repoRoot, runDir) {
  if (await serverPortOccupied()) {
    throw new Error(`Port ${BENCHMARK_PORT} is already serving Hivemind. Stop the normal local Hivemind server before running the isolated benchmark.`);
  }
  const home = path.join(runDir, 'hive-home');
  mkdirSync(home, { recursive: true });
  const logPath = path.join(runDir, 'hivemind-server.log');
  const log = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'src/cli.ts'), 'serve', '--port', String(BENCHMARK_PORT)],
    { cwd: repoRoot, env: { ...process.env, HIVEMIND_HOME: home, HIVEMIND_PORT: String(BENCHMARK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let exited = false, exitCode = null;
  child.on('close', code => { exited = true; exitCode = code; log.end(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Hivemind benchmark server exited during startup with code ${exitCode}; see ${logPath}`);
    try {
      const response = await fetch(`http://127.0.0.1:${BENCHMARK_PORT}/api/health`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return { child, home, logPath };
    } catch {
      // startup in progress
    }
    await delay(150);
  }
  child.kill('SIGTERM');
  throw new Error(`Hivemind benchmark server did not become healthy on port ${BENCHMARK_PORT}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (server.child.exitCode === null && Date.now() < deadline) await delay(100);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function waitForWorkerJoins(dbPath, expected, seats, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failed = [];
    for (const seat of seats) {
      if (seat.child.exitCode !== null) failed.push(seat);
    }
    if (failed.length) throw new Error('A worker process exited before all benchmark workers joined');
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE role = 'worker'").get();
          if (Number(row.n) >= expected) return;
        } finally {
          db.close();
        }
      } catch {
        // schema may still be starting
      }
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${expected} benchmark workers to join`);
}

function parseArgs(argv) {
  const options = {
    input: null,
    repoRoot: root,
    trialId: null,
    dryRun: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--input') options.input = path.resolve(argv[++index]);
    else if (arg === '--repo-root') options.repoRoot = path.resolve(argv[++index]);
    else if (arg === '--trial') options.trialId = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--timeout-minutes') options.timeoutMs = Number(argv[++index]) * 60_000;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  assert.ok(options.input, '--input trial directory is required');
  assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs >= 60_000 && options.timeoutMs <= 4 * 60 * 60 * 1000,
    '--timeout-minutes must be between 1 and 240');
  return options;
}

function readPilot(input, repoRoot) {
  const manifest = JSON.parse(readFileSync(path.join(input, 'manifest.json'), 'utf8'));
  assert.equal(manifest.evidenceClass, 'real_agent_manifest');
  assert.equal(manifest.preset?.id, 'pilot-v1', 'runner currently supports the versioned pilot-v1 preset only');
  assert.equal(manifest.trials.length, 24, 'pilot-v1 manifest must contain 24 trials');
  assert.equal(manifest.versions.promptVersion, REAL_AGENT_PROMPT_VERSION,
    `pilot must be prepared with promptVersion ${REAL_AGENT_PROMPT_VERSION}; regenerate it after updating the repo`);
  const files = strictTrialFiles(input);
  assert.equal(files.length, 24, 'pilot-v1 directory must contain exactly 24 trial JSON files');
  const trials = new Map(files.map(name => {
    const value = JSON.parse(readFileSync(path.join(input, name), 'utf8'));
    validateRealTrial(value);
    return [value.trialId, { value, file: path.join(input, name) }];
  }));
  for (const row of manifest.trials) assert.ok(trials.has(row.trialId), `manifest trial missing: ${row.trialId}`);
  const fixtures = new Map(loadFixtures(repoRoot).map(fixture => [fixture.id, fixture]));
  return { manifest, trials, fixtures };
}

function nextAttemptDir(input, trialId) {
  const base = path.join(input, 'runs', trialId);
  mkdirSync(base, { recursive: true });
  const existing = readdirSync(base).filter(name => /^attempt-\d{3}$/.test(name)).sort();
  const number = existing.length ? Number(existing.at(-1).slice(8)) + 1 : 1;
  const dir = path.join(base, `attempt-${String(number).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: false });
  return dir;
}

function runMetaPath(input, trialId) {
  return path.join(input, `run-${trialId}.json`);
}

function writeMeta(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function commandVersion(binary) {
  const found = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  return (found.stdout || found.stderr || '').trim() || null;
}

function totalTokens(results) {
  const values = results.map(result => result.providerTokens);
  if (!values.length || values.some(value => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

async function runTrial(options, trial, fixture, binary, binaryVersion) {
  const plan = seatPlan(trial, fixture);
  if (options.dryRun) {
    return {
      skipped: false,
      dryRun: true,
      plan: plan.map(seat => ({ id: seat.id, role: seat.role, focus: seat.worker?.id ?? null })),
    };
  }

  const metaFile = runMetaPath(options.input, trial.trialId);
  if (existsSync(metaFile)) {
    const previous = JSON.parse(readFileSync(metaFile, 'utf8'));
    return { skipped: true, reason: `trial already attempted with state=${previous.state}; retain it rather than silently rerunning` };
  }

  const attemptDir = nextAttemptDir(options.input, trial.trialId);
  const workspace = path.join(attemptDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'BENCHMARK.md'), trial.runbook.prompt + '\n');

  const meta = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    trialId: trial.trialId,
    blindId: trial.blindId,
    state: 'running',
    startedAt: null,
    completedAt: null,
    wallMs: null,
    host: trial.versions.host,
    hostVersion: binaryVersion,
    workflow: trial.trial.workflow,
    seats: plan.map(seat => ({ id: seat.id, role: seat.role, focus: seat.worker?.id ?? null })),
    acceptance: null,
    providerTokens: null,
    notes: [],
  };
  writeMeta(metaFile, meta);

  const started = Date.now();
  meta.startedAt = new Date(started).toISOString();
  writeMeta(metaFile, meta);

  let server = null;
  const runningSeats = [];
  const seatResults = [];
  let startupError = null;
  try {
    if (trial.trial.workflow === 'single_worker') {
      const prompt = buildSinglePrompt(trial);
      const invocation = hostInvocation(trial, prompt, { ...process.env }, options.repoRoot, false);
      const seat = startSeat({
        binary,
        args: invocation.args,
        cwd: workspace,
        stdin: invocation.stdin,
        stdoutPath: path.join(attemptDir, 'single.stdout.txt'),
        stderrPath: path.join(attemptDir, 'single.stderr.log'),
        env: invocation.env,
        timeoutMs: options.timeoutMs,
      });
      runningSeats.push({ id: 'single', ...seat });
      seatResults.push({ id: 'single', ...(await seat.done) });
    } else {
      server = await startIsolatedServer(options.repoRoot, attemptDir);
      const humanAuthority = trial.trial.workflow === 'brain_multi_room'
        ? await seedHumanRoomInstruction(trial)
        : null;
      if (humanAuthority) {
        meta.humanAuthority = {
          seq: humanAuthority.seq,
          channelId: humanAuthority.channelId,
          messageId: humanAuthority.messageId,
        };
        writeMeta(metaFile, meta);
      }
      const workers = plan.filter(seat => seat.role === 'worker');
      for (let index = 0; index < workers.length; index++) {
        const seat = workers[index];
        const prompt = buildWorkerPrompt(trial, seat.worker, index + 1);
        const baseEnv = {
          ...process.env,
          HIVEMIND_URL: `http://127.0.0.1:${BENCHMARK_PORT}`,
          HIVEMIND_HOME: path.join(attemptDir, 'agent-identities'),
        };
        const invocation = hostInvocation(trial, prompt, baseEnv, options.repoRoot, true);
        const proc = startSeat({
          binary,
          args: invocation.args,
          cwd: workspace,
          stdin: invocation.stdin,
          stdoutPath: path.join(attemptDir, `${seat.id}.stdout.txt`),
          stderrPath: path.join(attemptDir, `${seat.id}.stderr.log`),
          env: invocation.env,
          timeoutMs: options.timeoutMs,
        });
        runningSeats.push({ id: seat.id, ...proc });
      }
      await waitForWorkerJoins(path.join(server.home, 'hive.db'), workers.length, runningSeats);
      const brainSeat = plan.find(seat => seat.role === 'brain');
      const brainPrompt = buildBrainPrompt(trial, fixture, workers.length, humanAuthority?.seq ?? null);
      const brainEnv = {
        ...process.env,
        HIVEMIND_URL: `http://127.0.0.1:${BENCHMARK_PORT}`,
        HIVEMIND_HOME: path.join(attemptDir, 'agent-identities'),
      };
      const brainInvocation = hostInvocation(trial, brainPrompt, brainEnv, options.repoRoot, true);
      const brain = startSeat({
        binary,
        args: brainInvocation.args,
        cwd: workspace,
        stdin: brainInvocation.stdin,
        stdoutPath: path.join(attemptDir, 'brain.stdout.txt'),
        stderrPath: path.join(attemptDir, 'brain.stderr.log'),
        env: brainInvocation.env,
        timeoutMs: options.timeoutMs,
      });
      runningSeats.push({ id: brainSeat.id, ...brain });
      seatResults.push({ id: 'brain', ...(await brain.done) });

      const workerDeadline = Date.now() + 10_000;
      while (Date.now() < workerDeadline && runningSeats.some(seat => seat.id.startsWith('worker-') && seat.child.exitCode === null)) {
        await delay(200);
      }
      for (const seat of runningSeats.filter(seat => seat.id.startsWith('worker-'))) {
        if (seat.child.exitCode === null) {
          seat.child.kill('SIGTERM');
          setTimeout(() => seat.child.kill('SIGKILL'), 2_000).unref();
        }
      }
      for (const seat of runningSeats.filter(seat => seat.id.startsWith('worker-'))) {
        seatResults.push({ id: seat.id, ...(await seat.done) });
      }
    }
  } catch (error) {
    startupError = String(error?.message ?? error);
    for (const seat of runningSeats) {
      if (seat.child.exitCode === null) {
        seat.child.kill('SIGTERM');
        setTimeout(() => seat.child.kill('SIGKILL'), 2_000).unref();
      }
    }
    for (const seat of runningSeats) {
      if (!seatResults.some(result => result.id === seat.id)) seatResults.push({ id: seat.id, ...(await seat.done) });
    }
  } finally {
    await stopServer(server);
  }

  const completed = Date.now();
  const artifactPath = path.join(workspace, 'BENCHMARK_RESULT.json');
  let artifact = null, acceptance;
  if (existsSync(artifactPath)) {
    try {
      artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      acceptance = reviewArtifact(artifact, trial, fixture);
    } catch (error) {
      acceptance = { acceptancePassed: false, defects: fixture.tasks.length + 1,
        issues: [`BENCHMARK_RESULT.json parse failure: ${String(error?.message ?? error)}`],
        expected: expectedArtifact(trial, fixture) };
    }
  } else {
    acceptance = { acceptancePassed: false, defects: fixture.tasks.length + 1,
      issues: ['BENCHMARK_RESULT.json was not produced'], expected: expectedArtifact(trial, fixture) };
  }
  writeFileSync(path.join(attemptDir, 'acceptance.json'), JSON.stringify({ artifact, ...acceptance }, null, 2) + '\n');

  const providerTokens = totalTokens(seatResults);
  trial.timing = {
    startedAt: meta.startedAt,
    completedAt: new Date(completed).toISOString(),
    wallMs: completed - started,
  };
  trial.quality.acceptancePassed = acceptance.acceptancePassed;
  trial.quality.defects = acceptance.defects;
  trial.efficiency.providerTokens = providerTokens;
  trial.efficiency.providerCost = null;
  trial.efficiency.providerCurrency = null;
  trial.efficiency.providerUsageReason = providerTokens === null
    ? (trial.versions.host === 'opencode'
      ? 'OpenCode run output is retained, but this harness does not yet claim a parser-verified provider token aggregate; total remains null.'
      : 'At least one benchmark seat did not emit a parseable Codex CLI token count; total remains null.')
    : `Sum of CLI-reported token counts across ${seatResults.length} benchmark seat(s).`;
  writeFileSync(path.join(options.input, `${trial.trialId}.json`), JSON.stringify(trial, null, 2) + '\n');

  meta.state = startupError ? 'harness-failure' : 'executed-pending-review';
  meta.completedAt = trial.timing.completedAt;
  meta.wallMs = trial.timing.wallMs;
  meta.providerTokens = providerTokens;
  meta.acceptance = {
    passed: acceptance.acceptancePassed,
    defects: acceptance.defects,
    issues: acceptance.issues,
  };
  meta.seats = seatResults.map(result => ({
    id: result.id,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
    providerTokens: result.providerTokens,
  }));
  if (startupError) meta.notes.push(startupError);
  meta.notes.push('Trial remains pending until independent review fills rework/duplicate/coordination metrics and review fields.');
  writeMeta(metaFile, meta);
  return { skipped: false, meta };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { manifest, trials, fixtures } = readPilot(options.input, options.repoRoot);
  const binary = hostExecutable(manifest.versions.host);
  const binaryVersion = options.dryRun ? null : commandVersion(binary);
  if (!options.dryRun && !binaryVersion) {
    const override = manifest.versions.host === 'opencode' ? 'OPENCODE_BIN' : 'CODEX_BIN';
    throw new Error(`Cannot execute ${manifest.versions.host} CLI command from ${override}/default: ${binary}`);
  }
  const selected = options.trialId ? manifest.trials.filter(row => row.trialId === options.trialId) : manifest.trials;
  if (options.trialId) assert.equal(selected.length, 1, `Unknown --trial ${options.trialId}`);

  const summary = [];
  for (const row of selected) {
    const entry = trials.get(row.trialId);
    const fixture = fixtures.get(entry.value.fixture.id);
    assert.ok(fixture, `Unknown fixture ${entry.value.fixture.id}`);
    const result = await runTrial(options, entry.value, fixture, binary, binaryVersion);
    summary.push({ trialId: row.trialId, fixtureId: row.fixtureId, workflow: row.workflow, ...result });
    process.stdout.write(JSON.stringify(summary.at(-1)) + '\n');
  }
  return summary;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
