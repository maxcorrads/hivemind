import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULT_SCHEMA_VERSION = 1;
export const FIXTURE_SCHEMA_VERSION = 1;
export const DEFAULT_SEED = 29;
export const DEFAULT_REPEAT = 1;
export const REQUIRED_EXERCISES = Object.freeze([
  'structured_tasks',
  'checkpoint_handoff',
  'claims_dependencies',
  'worker_routing',
  'collaboration_rooms',
]);
export const REQUIRED_FIXTURE_IDS = Object.freeze([
  'independent-implementation',
  'shared-interface-coupled',
  'reviewer-disagreement',
  'blocked-worker-recovery',
  'offline-dropped-delivery',
  'noisy-room',
  'room-peer-clarification',
  'worktree-conflict',
]);
export const WORKFLOWS = Object.freeze([
  'single_worker',
  'brain_one_worker',
  'brain_multi_dm',
  'brain_multi_room',
]);

const PROFILES = Object.freeze({
  single_worker: Object.freeze({ workers: 1, assignTicks: 0, reviewTicks: 0, setupTicks: 0, setupBytes: 0,
    structuredTasks: false, checkpointHandoff: false, claimsDependencies: false, routing: false, room: false }),
  brain_one_worker: Object.freeze({ workers: 1, assignTicks: 1, reviewTicks: 1, setupTicks: 1, setupBytes: 180,
    structuredTasks: true, checkpointHandoff: true, claimsDependencies: true, routing: true, room: false }),
  brain_multi_dm: Object.freeze({ workers: 3, assignTicks: 1, reviewTicks: 1, setupTicks: 2, setupBytes: 320,
    structuredTasks: true, checkpointHandoff: true, claimsDependencies: true, routing: true, room: false }),
  brain_multi_room: Object.freeze({ workers: 3, assignTicks: 1, reviewTicks: 1, setupTicks: 3, setupBytes: 720,
    structuredTasks: true, checkpointHandoff: true, claimsDependencies: true, routing: true, room: true }),
});

function ensureInteger(value, name, min = 0) {
  assert.ok(Number.isInteger(value) && value >= min, `${name} must be an integer >= ${min}`);
  return value;
}

function ensureStringArray(value, name) {
  assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0), `${name} must be a non-empty-string array`);
  return value;
}

export function validateFixture(fixture) {
  assert.equal(fixture.schemaVersion, FIXTURE_SCHEMA_VERSION, 'unsupported fixture schemaVersion');
  assert.match(fixture.id, /^[a-z0-9][a-z0-9-]+$/);
  assert.ok(['parallelizable', 'coupled', 'recovery', 'communication'].includes(fixture.kind), 'unknown fixture kind');
  assert.ok(typeof fixture.description === 'string' && fixture.description.length > 0);
  if (fixture.instructions !== undefined) ensureStringArray(fixture.instructions, 'instructions');
  ensureStringArray(fixture.exercises, 'exercises');
  assert.ok(fixture.exercises.every(item => REQUIRED_EXERCISES.includes(item) || ['delivery_recovery'].includes(item)), 'unknown exercise');
  assert.ok(Array.isArray(fixture.tasks) && fixture.tasks.length >= 1 && fixture.tasks.length <= 12);
  const ids = new Set();
  for (const task of fixture.tasks) {
    assert.match(task.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(task.id), `duplicate task id ${task.id}`); ids.add(task.id);
    ensureInteger(task.effort, `${task.id}.effort`, 1);
    ensureStringArray(task.scope, `${task.id}.scope`);
    assert.ok(Array.isArray(task.dependsOn), `${task.id}.dependsOn must be an array`);
    ensureInteger(task.clarifications ?? 0, `${task.id}.clarifications`, 0);
    if (task.requiredCapability !== undefined) assert.match(task.requiredCapability, /^[a-z0-9][a-z0-9._+-]*$/);
  }
  for (const task of fixture.tasks) for (const dependency of task.dependsOn) {
    assert.ok(ids.has(dependency), `${task.id} depends on unknown task ${dependency}`);
    assert.notEqual(dependency, task.id, `${task.id} cannot depend on itself`);
  }
  const byId = new Map(fixture.tasks.map(task => [task.id, task]));
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    assert.ok(!visiting.has(id), `dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const task of fixture.tasks) visit(task.id);
  assert.ok(Array.isArray(fixture.workers) && fixture.workers.length >= 1 && fixture.workers.length <= 8);
  for (const worker of fixture.workers) {
    assert.match(worker.id, /^[a-z][a-z0-9-]*$/);
    ensureStringArray(worker.capabilities, `${worker.id}.capabilities`);
  }
  assert.ok(Array.isArray(fixture.faults), 'faults must be an array');
  for (const fault of fixture.faults) {
    assert.ok(['block', 'offline', 'dropped_delivery', 'unsupported_completion'].includes(fault.type), `unknown fault ${fault.type}`);
    assert.ok(ids.has(fault.taskId), `fault references unknown task ${fault.taskId}`);
    ensureInteger(fault.penaltyTicks, `${fault.type}.penaltyTicks`, 1);
  }
  ensureInteger(fixture.budgets.maxVirtualTicks, 'budgets.maxVirtualTicks', 1);
  ensureInteger(fixture.budgets.maxCommunicationBytes, 'budgets.maxCommunicationBytes', 1);
  return fixture;
}

function xorshift32(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function seededShuffle(items, seed) {
  const random = xorshift32(seed); const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const overlaps = (left, right) => left.some(a => right.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));

function topoDepth(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const memo = new Map();
  const depth = id => {
    if (memo.has(id)) return memo.get(id);
    const task = byId.get(id); assert.ok(task);
    const value = task.effort + (task.dependsOn.length ? Math.max(...task.dependsOn.map(depth)) : 0);
    memo.set(id, value); return value;
  };
  return Math.max(...tasks.map(task => depth(task.id)));
}

function topologicalTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const remaining = new Set(tasks.map(task => task.id));
  const done = new Set(); const ordered = [];
  while (remaining.size) {
    const ready = tasks.filter(task => remaining.has(task.id) && task.dependsOn.every(id => done.has(id)));
    assert.ok(ready.length, 'validated task graph unexpectedly has no ready node');
    for (const task of ready) { ordered.push(task); remaining.delete(task.id); done.add(task.id); }
  }
  assert.equal(ordered.length, byId.size);
  return ordered;
}

function pickWorkers(fixture, profile, tasks) {
  const available = fixture.workers.slice(0, Math.max(1, Math.min(profile.workers, fixture.workers.length)));
  let cursor = 0;
  return tasks.map(task => {
    if (profile.routing && task.requiredCapability) {
      const matching = available.find(worker => worker.capabilities.includes(task.requiredCapability));
      if (matching) return matching;
    }
    const worker = available[cursor++ % available.length];
    return worker;
  });
}

function schedule(fixture, profile) {
  const tasks = topologicalTasks(fixture.tasks);
  const workers = pickWorkers(fixture, profile, tasks);
  const completed = new Map();
  const workerFree = new Map(workers.map(worker => [worker.id, profile.setupTicks]));
  const intervals = [];
  let routingMisses = 0;
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]; const worker = workers[index];
    const dependencyReady = task.dependsOn.length ? Math.max(...task.dependsOn.map(id => completed.get(id) ?? 0)) : profile.setupTicks;
    const ready = Math.max(dependencyReady, workerFree.get(worker.id) ?? profile.setupTicks);
    const capabilityMiss = task.requiredCapability && !worker.capabilities.includes(task.requiredCapability);
    if (capabilityMiss) routingMisses++;
    const duration = task.effort + profile.assignTicks + profile.reviewTicks + (capabilityMiss ? 2 : 0);
    const finish = ready + duration;
    intervals.push({ task, worker, start: ready, finish, capabilityMiss });
    completed.set(task.id, finish); workerFree.set(worker.id, finish);
  }
  return { intervals, routingMisses, criticalPathFloor: topoDepth(tasks) };
}

function conflictMetrics(intervals, profile) {
  let conflicts = 0, reworkTicks = 0, duplicateWork = 0;
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    const a = intervals[i], b = intervals[j];
    const concurrent = a.start < b.finish && b.start < a.finish;
    if (!concurrent || !overlaps(a.task.scope, b.task.scope)) continue;
    const explicitlyOrdered = a.task.dependsOn.includes(b.task.id) || b.task.dependsOn.includes(a.task.id);
    if (explicitlyOrdered) continue;
    if (profile.claimsDependencies) {
      // Synthetic contract: claims serialize overlapping intent rather than claiming a measured speedup.
      reworkTicks += 1;
    } else {
      conflicts++; duplicateWork++; reworkTicks += Math.min(a.task.effort, b.task.effort);
    }
  }
  return { conflicts, reworkTicks, duplicateWork };
}

function communicationMetrics(fixture, profile, faults) {
  const assignments = profile.structuredTasks ? fixture.tasks.length : 0;
  const reviews = profile.structuredTasks ? fixture.tasks.length : 0;
  const clarifications = fixture.tasks.reduce((sum, task) => sum + (task.clarifications ?? 0), 0);
  const relaysPerClarification = profile.room ? 1 : profile.structuredTasks ? 2 : 1;
  const handoffFaults = faults.filter(fault => ['block', 'offline'].includes(fault.type)).length;
  const handoffs = profile.checkpointHandoff ? handoffFaults : 0;
  const dropped = faults.filter(fault => fault.type === 'dropped_delivery').length;
  const messages = assignments + reviews + clarifications * relaysPerClarification + handoffs * 2 + dropped * 2;
  const bytes = profile.setupBytes + assignments * 420 + reviews * 260 + clarifications * relaysPerClarification * 180 + handoffs * 520 + dropped * 160;
  return { messages, bytes, handoffs, clarifications, dropped, modelReturningWakeups: messages + dropped };
}

export function runSyntheticTrial(fixtureInput, workflow, seed = DEFAULT_SEED, trialIndex = 0) {
  const fixture = validateFixture(structuredClone(fixtureInput));
  assert.ok(WORKFLOWS.includes(workflow), `unknown workflow ${workflow}`);
  ensureInteger(seed, 'seed', 0); ensureInteger(trialIndex, 'trialIndex', 0);
  const profile = PROFILES[workflow];
  const scheduled = schedule(fixture, profile);
  const faults = fixture.faults;
  const conflict = conflictMetrics(scheduled.intervals, profile);
  const communication = communicationMetrics(fixture, profile, faults);
  const recoveryTicks = faults.filter(fault => ['block', 'offline', 'dropped_delivery'].includes(fault.type))
    .reduce((sum, fault) => sum + fault.penaltyTicks, 0);
  const blockerTicks = faults.filter(fault => fault.type === 'block').reduce((sum, fault) => sum + fault.penaltyTicks, 0);
  const unsupported = faults.filter(fault => fault.type === 'unsupported_completion').length;
  const caughtUnsupported = profile.reviewTicks > 0 ? unsupported : 0;
  const uncaughtUnsupported = unsupported - caughtUnsupported;
  const scheduleEnd = Math.max(...scheduled.intervals.map(interval => interval.finish));
  const criticalPathTicks = scheduleEnd + recoveryTicks + conflict.reworkTicks + caughtUnsupported * 2;
  const qualityPass = conflict.conflicts === 0 && uncaughtUnsupported === 0 && scheduled.routingMisses === 0;
  const defects = conflict.conflicts + uncaughtUnsupported + scheduled.routingMisses;
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    evidenceClass: 'synthetic_contract',
    warning: 'Synthetic fake-agent contract fixture. Virtual ticks/bytes validate accounting and scenario coverage; they are not evidence of model quality, real latency, productivity, or provider cost.',
    fixture: {
      id: fixture.id,
      version: fixture.schemaVersion,
      kind: fixture.kind,
      description: fixture.description,
      exercises: [...fixture.exercises],
      promptVersion: fixture.promptVersion,
      modelVersion: fixture.modelVersion,
    },
    trial: { workflow, seed, trialIndex },
    quality: {
      acceptancePassed: qualityPass,
      defects,
      duplicateWork: conflict.duplicateWork,
      unsupportedCompletionClaims: unsupported,
      unsupportedCompletionClaimsCaughtByReview: caughtUnsupported,
      conflictReworkTicks: conflict.reworkTicks,
      routingMisses: scheduled.routingMisses,
    },
    coordination: {
      assignmentToAcceptanceTicks: criticalPathTicks,
      blockerToDecisionTicks: blockerTicks || null,
      criticalPathTicks,
      theoreticalWorkCriticalPathTicks: scheduled.criticalPathFloor,
      recoveryTicks: recoveryTicks || null,
      handoffCount: communication.handoffs,
      clarificationRounds: communication.clarifications,
    },
    efficiency: {
      modelReturningWakeups: communication.modelReturningWakeups,
      communicationBytes: communication.bytes,
      contextExpansionCalls: communication.handoffs,
      providerTokens: null,
      providerCost: null,
      providerUsageReason: 'No provider is invoked by synthetic_contract fixtures.',
    },
    infrastructure: {
      sqlQueries: null,
      sqlRows: null,
      eventLoopDelayMs: null,
      deliveryLatencyMs: null,
      memoryBytes: null,
      queueDepth: null,
      reason: 'Phase-1 coordination fixtures do not execute the Hivemind runtime. Infrastructure-load evidence is tracked by the storage/inbox benchmarks.',
    },
    budget: {
      virtualTicks: criticalPathTicks,
      communicationBytes: communication.bytes,
      withinVirtualTickBudget: criticalPathTicks <= fixture.budgets.maxVirtualTicks,
      withinCommunicationBudget: communication.bytes <= fixture.budgets.maxCommunicationBytes,
    },
  };
  assert.ok(!('score' in result), 'benchmark must not collapse trade-offs into one score');
  return result;
}

export function fixtureDirectory(root = process.cwd()) {
  return path.join(root, 'benchmarks', 'coordination', 'v1', 'fixtures');
}

export function loadFixtures(root = process.cwd()) {
  const directory = fixtureDirectory(root);
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name =>
    validateFixture(JSON.parse(readFileSync(path.join(directory, name), 'utf8'))));
}

export function coverage(fixtures) {
  const seen = new Set(fixtures.flatMap(fixture => fixture.exercises));
  return Object.fromEntries(REQUIRED_EXERCISES.map(feature => [feature, seen.has(feature)]));
}

export function runMatrix(fixtures, { seed = DEFAULT_SEED, repeat = DEFAULT_REPEAT } = {}) {
  ensureInteger(repeat, 'repeat', 1);
  const trials = [];
  for (let trialIndex = 0; trialIndex < repeat; trialIndex++) {
    for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
      const fixture = fixtures[fixtureIndex];
      const orderSeed = seed + trialIndex * 10_000 + fixtureIndex;
      for (const workflow of seededShuffle(WORKFLOWS, orderSeed))
        trials.push(runSyntheticTrial(fixture, workflow, seed, trialIndex));
    }
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    evidenceClass: 'synthetic_contract',
    generatedBy: 'scripts/benchmark-coordination.mjs',
    seed,
    repeat,
    workflowOrderRandomizedWithSeed: true,
    coverage: coverage(fixtures),
    trials,
    interpretation: 'Compare quality, coordination and efficiency dimensions separately. Do not derive a single winner or generalize synthetic virtual ticks to real agents.',
  };
}

function parseArgs(argv) {
  const options = { all: false, fixture: null, workflow: null, seed: DEFAULT_SEED, repeat: DEFAULT_REPEAT, output: null, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--fixture') options.fixture = argv[++i];
    else if (arg === '--workflow') options.workflow = argv[++i];
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg === '--repeat') options.repeat = Number(argv[++i]);
    else if (arg === '--output') options.output = argv[++i];
    else if (arg === '--root') options.root = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); const fixtures = loadFixtures(options.root);
  assert.ok(fixtures.length >= 3 && fixtures.length <= 8, 'keep the deterministic phase-1 suite intentionally small');
  const missing = Object.entries(coverage(fixtures)).filter(([, present]) => !present).map(([feature]) => feature);
  assert.deepEqual(missing, [], `fixture suite is missing feature coverage: ${missing.join(', ')}`);
  const fixtureIds = new Set(fixtures.map(fixture => fixture.id));
  const missingFixtures = REQUIRED_FIXTURE_IDS.filter(id => !fixtureIds.has(id));
  assert.deepEqual(missingFixtures, [], `fixture suite is missing required scenarios: ${missingFixtures.join(', ')}`);
  let report;
  if (options.all || (!options.fixture && !options.workflow)) report = runMatrix(fixtures, options);
  else {
    assert.ok(options.fixture && options.workflow, '--fixture and --workflow must be supplied together');
    const fixture = fixtures.find(candidate => candidate.id === options.fixture);
    assert.ok(fixture, `Unknown fixture: ${options.fixture}`);
    report = runSyntheticTrial(fixture, options.workflow, options.seed, 0);
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) writeFileSync(options.output, json);
  else process.stdout.write(json);
  return report;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) main();
