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
  coordinationPrivateFacts,
  expectedTaskOutputs,
  loadPilotPreset,
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
  const source = String(text);
  const codex = [...source.matchAll(/tokens used\s*\n\s*([0-9][0-9.,]*)/gi)];
  if (codex.length) {
    const digits = codex.at(-1)[1].replace(/[.,]/g, '');
    const value = Number(digits);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  let latest = null;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'step_finish') continue;
    const value = event?.part?.tokens?.total;
    if (!Number.isSafeInteger(value) || value < 0) continue;
    latest = value;
  }
  return latest;
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

export function opencodeArgs(trial, prompt, workdir) {
  assert.equal(trial.versions.host, 'opencode');
  assert.ok(path.isAbsolute(workdir), 'OpenCode benchmark workdir must be absolute');
  assert.match(trial.versions.configuration, /(^|[;,\s])auto(?:=true)?($|[;,\s])/i,
    'OpenCode pilot configuration must record --auto as configuration=auto');
  return [
    '--pure',
    'run',
    '--dir', workdir,
    '--model', trial.versions.model,
    '--auto',
    '--format', 'json',
    prompt,
  ];
}

export function hostInvocation(trial, prompt, baseEnv, repoRoot, withHivemind, workdir) {
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
      args: opencodeArgs(trial, prompt, workdir),
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

export function buildWorkerPrompt(trial, fixture, worker, seatIndex) {
  const facts = coordinationPrivateFacts(fixture, trial.trial.seed, trial.trial.repeatIndex);
  const ownFact = facts.find(fact => fact.workerId === worker.id);
  const partitionInstructions = ownFact ? [
    `Your private benchmark fact is exactly: ${ownFact.workerId}=${ownFact.value}`,
    'This fact exists only in your host prompt. Do not read parent attempt logs, benchmark source files, or another seat output to recover peer facts.',
    'Every task output in this fixture requires all worker facts in canonical worker-id order. The exact suffix is "|facts=" followed by WORKER_ID=FACT_VALUE pairs joined with commas. Never guess or derive missing facts.',
    'Do not proactively broadcast your private fact. Disclose it only when another benchmark participant asks a relevant explicit question.',
    'When you are assigned work, request every missing fact through Hivemind with eventType=question before computing the result.',
    trial.trial.workflow === 'brain_multi_room'
      ? 'In the collaboration room, address the worker who owns the missing fact directly; answer addressed peer questions with your exact fact.'
      : 'Worker-to-worker DMs are forbidden. Ask the brain to relay the question to the worker who owns the missing fact, and wait for the exact relayed answer.',
  ] : [];
  return [
    'You are a finite-lifecycle worker in a controlled Hivemind coordination benchmark.',
    'Use the real Hivemind MCP tools. Do not simulate tool results.',
    `Join with role=worker, seniority=mid, focus=${worker.id}, project=chapter.`,
    `After joining, call set_capabilities with expectedRevision=0 and this exact card: ${JSON.stringify(workerCapabilityCard(trial, worker))}.`,
    'Then call wait and take work only from the benchmark brain.',
    ...partitionInstructions,
    'For assigned tasks, compute the requested SHA-256 output exactly from the assignment material, dependency outputs, and any required partitioned facts. Use a local hash command/tool if useful.',
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
  const partitioned = coordinationPrivateFacts(fixture, trial.trial.seed, trial.trial.repeatIndex).length > 0;
  const partitionInstructions = !partitioned ? [] : [
    'This fixture is information-partitioned. Each benchmark worker received exactly one opaque private fact in its host prompt; you received no fact values.',
    'Do not inspect benchmark source files, parent attempt logs, or worker stdout to recover those facts.',
    'Assign capability-matched work across the benchmark workers rather than centralizing all tasks in one worker.',
    workflow === 'brain_multi_room'
      ? 'Let workers ask addressed peer questions and answer each other directly in the room; do not proactively collect/broadcast all facts through the brain.'
      : 'Workers cannot peer-DM. Relay explicit clarification questions and exact answers between the requesting worker and the fact-owning worker; do not invent or precompute fact values.',
    'A private fact should be disclosed only after a relevant explicit question, so the resulting coordination evidence measures actual clarification rather than proactive broadcast.',
  ];
  const roomInstructions = workflow === 'brain_multi_room'
    ? [
        `A real Human-authored benchmark authorization message already exists in this project at message sequence ${humanInstructionSeq}. Use humanInstructionSeq=${humanInstructionSeq} on the initial room_event configure. Do not ask Human for another authorization.`,
        'Bootstrap the finite room deterministically: assign the first dependency-ready runbook task outside the room solely to obtain contract.originTaskId, then configure the room immediately before expecting clarification work. If this fixture is information-partitioned, direct the origin worker to wait for room setup before asking peers for missing facts.',
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
    ...partitionInstructions,
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

export function buildSinglePrompt(trial, fixture) {
  const facts = coordinationPrivateFacts(fixture, trial.trial.seed, trial.trial.repeatIndex);
  const factInstructions = facts.length ? [
    'For fairness, the single-session condition receives the complete information set that is partitioned across worker seats in multi-agent conditions.',
    `Private benchmark facts: ${facts.map(fact => `${fact.workerId}=${fact.value}`).join(',')}`,
    'Use these exact facts in the canonical worker-id order required by the runbook.',
  ] : [];
  return [
    'You are the only model session in this controlled benchmark condition.',
    'Do not use Hivemind, native subagents, or delegation.',
    ...factInstructions,
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

export async function bootstrapBenchmarkHumanSession(base) {
  const response = await fetch(`${base}/api/ui/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Cannot bootstrap benchmark Human session: HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]?.trim();
  assert.ok(cookie, 'benchmark Human session did not return a cookie');
  return cookie;
}

export async function seedHumanRoomInstruction(trial) {
  assert.equal(trial.trial.workflow, 'brain_multi_room');
  const base = `http://127.0.0.1:${BENCHMARK_PORT}`;
  const cookie = await bootstrapBenchmarkHumanSession(base);
  const humanHeaders = { origin: base, cookie, 'x-hivemind-ui': '1' };
  const snapshotResponse = await fetch(`${base}/api/ui/snapshot`, {
    headers: humanHeaders,
    signal: AbortSignal.timeout(3_000),
  });
  if (!snapshotResponse.ok) throw new Error(`Cannot read benchmark Human snapshot: HTTP ${snapshotResponse.status}`);
  const snapshot = await snapshotResponse.json();
  const project = snapshot.projects?.find(value => value.slug === 'chapter');
  assert.ok(project, 'benchmark project chapter is missing');
  const channel = snapshot.channels?.find(value => value.projectId === project.id && String(value.name).toLowerCase() === 'general');
  assert.ok(channel, 'benchmark project #general channel is missing');
  const body = humanRoomInstructionBody(trial);
  const response = await fetch(`${base}/api/ui/channels/${encodeURIComponent(channel.id)}/messages`, {
    method: 'POST',
    headers: { ...humanHeaders, 'content-type': 'application/json' },
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

export function openCodeUsageAccumulator() {
  let pending = '', latest = null;
  const consume = line => {
    if (!line.trim().startsWith('{')) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type !== 'step_finish') return;
    const value = event?.part?.tokens?.total;
    if (!Number.isSafeInteger(value) || value < 0) return;
    latest = value;
  };
  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) consume(line);
    },
    finish() {
      if (pending) consume(pending);
      return latest;
    },
  };
}

function startSeat({ binary, args, cwd, stdin, stdoutPath, stderrPath, env, timeoutMs }) {
  mkdirSync(path.dirname(stdoutPath), { recursive: true });
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx' });
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutTail = '', stderrTail = '', timedOut = false;
  const openCodeUsage = openCodeUsageAccumulator();
  child.stdout.on('data', chunk => {
    stdoutTail = appendTail(stdoutTail, chunk);
    openCodeUsage.push(chunk);
    stdoutFile.write(chunk);
  });
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
        providerTokens: openCodeUsage.finish() ?? parseProviderTokens(stdoutTail + '\n' + stderrTail),
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

function readCohort(input, repoRoot) {
  const manifest = JSON.parse(readFileSync(path.join(input, 'manifest.json'), 'utf8'));
  assert.equal(manifest.evidenceClass, 'real_agent_manifest');
  assert.ok(manifest.preset?.id, 'runner requires a versioned benchmark preset');
  const preset = loadPilotPreset(repoRoot, manifest.preset.id);
  assert.equal(manifest.trials.length, preset.expectedTrials,
    `${preset.id} manifest must contain ${preset.expectedTrials} trials`);
  assert.deepEqual(new Set(manifest.workflows ?? manifest.trials.map(row => row.workflow)), new Set(preset.workflows),
    'manifest workflow set does not match preset');
  assert.equal(manifest.versions.promptVersion, REAL_AGENT_PROMPT_VERSION,
    `benchmark must be prepared with promptVersion ${REAL_AGENT_PROMPT_VERSION}; regenerate it after updating the repo`);
  const files = strictTrialFiles(input);
  assert.equal(files.length, preset.expectedTrials,
    `${preset.id} directory must contain exactly ${preset.expectedTrials} trial JSON files`);
  const trials = new Map(files.map(name => {
    const value = JSON.parse(readFileSync(path.join(input, name), 'utf8'));
    validateRealTrial(value);
    return [value.trialId, { value, file: path.join(input, name) }];
  }));
  for (const row of manifest.trials) assert.ok(trials.has(row.trialId), `manifest trial missing: ${row.trialId}`);
  const fixtures = new Map(loadFixtures(repoRoot).map(fixture => [fixture.id, fixture]));
  return { manifest, preset, trials, fixtures };
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

export function readCoordinationEvidence(dbPath) {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const roles = new Map(db.prepare('SELECT id, role FROM agents').all().map(row => [String(row.id), String(row.role)]));
    const rows = db.prepare(`SELECT m.event_type, m.author_id, m.recipients, c.type AS channel_type
      FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.event_type='question'`).all();
    let workerQuestions = 0, peerDirectedQuestions = 0, brainDirectedQuestions = 0, roomQuestions = 0, dmQuestions = 0;
    for (const row of rows) {
      if (row.channel_type === 'private') roomQuestions++;
      if (row.channel_type === 'dm') dmQuestions++;
      if (roles.get(String(row.author_id)) !== 'worker') continue;
      workerQuestions++;
      let recipients = [];
      try { recipients = JSON.parse(String(row.recipients ?? '[]')); } catch { recipients = []; }
      if (recipients.some(id => roles.get(String(id)) === 'worker' && String(id) !== String(row.author_id))) peerDirectedQuestions++;
      if (recipients.some(id => roles.get(String(id)) === 'brain')) brainDirectedQuestions++;
    }
    return {
      questionMessages: rows.length,
      workerQuestions,
      peerDirectedQuestions,
      brainDirectedQuestions,
      roomQuestions,
      dmQuestions,
    };
  } finally {
    db.close();
  }
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
      const prompt = buildSinglePrompt(trial, fixture);
      const invocation = hostInvocation(trial, prompt, { ...process.env }, options.repoRoot, false, workspace);
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
        const prompt = buildWorkerPrompt(trial, fixture, seat.worker, index + 1);
        const baseEnv = {
          ...process.env,
          HIVEMIND_URL: `http://127.0.0.1:${BENCHMARK_PORT}`,
          HIVEMIND_HOME: path.join(attemptDir, 'agent-identities'),
        };
        const invocation = hostInvocation(trial, prompt, baseEnv, options.repoRoot, true, workspace);
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
      const brainInvocation = hostInvocation(trial, brainPrompt, brainEnv, options.repoRoot, true, workspace);
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

  const coordinationEvidence = server ? readCoordinationEvidence(path.join(server.home, 'hive.db')) : null;
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
    ? 'At least one benchmark seat did not emit a parser-verified CLI token count; total remains null.'
    : `Sum of CLI-reported token counts across ${seatResults.length} benchmark seat(s).`;
  writeFileSync(path.join(options.input, `${trial.trialId}.json`), JSON.stringify(trial, null, 2) + '\n');

  meta.state = startupError ? 'harness-failure' : 'executed-pending-review';
  meta.completedAt = trial.timing.completedAt;
  meta.wallMs = trial.timing.wallMs;
  meta.providerTokens = providerTokens;
  meta.coordinationEvidence = coordinationEvidence;
  meta.acceptance = {
    passed: acceptance.acceptancePassed,
    defects: acceptance.defects,
    issues: acceptance.issues,
  };
  if (fixture.realAgent?.informationPartition && trial.trial.workflow !== 'single_worker' &&
    (coordinationEvidence?.workerQuestions ?? 0) === 0) {
    meta.notes.push('Information-partitioned fixture produced no worker question events; treat this trial as non-discriminative coordination evidence even if artifact acceptance passed.');
  }
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
  const { manifest, trials, fixtures } = readCohort(options.input, options.repoRoot);
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
