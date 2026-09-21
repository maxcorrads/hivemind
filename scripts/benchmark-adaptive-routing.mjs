import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from './benchmark-coordination.mjs';
import { validateRealTrial } from './benchmark-coordination-real.mjs';
import {
  appendRoutingDecision,
  evaluateAdaptiveRouting,
  normalizeRoutingInput,
  routingDecisionRecord,
  validateRoutingPolicy,
} from './adaptive-routing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function mean(values) {
  const xs = values.filter(finite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function loadPolicy(repoRoot, file) {
  const policyPath = file ?? path.join(repoRoot, 'benchmarks', 'coordination', 'v1', 'routing-policy-v1.json');
  assert.ok(existsSync(policyPath), `routing policy not found: ${policyPath}`);
  return validateRoutingPolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
}

function trialFiles(input) {
  return readdirSync(input).filter(name => /^trial-[a-f0-9]{16}\.json$/.test(name)).sort();
}

function readCohort(input) {
  const files = trialFiles(input);
  assert.ok(files.length > 0, 'no coordination trial files found');
  return files.map(name => validateRealTrial(
    JSON.parse(readFileSync(path.join(input, name), 'utf8')),
    { requireComplete: true },
  ));
}

function workloadKey(trial) {
  const versions = trial.versions ?? {};
  return [
    versions.hivemindRevision,
    versions.provider,
    versions.model,
    versions.host,
    versions.configuration,
    versions.promptVersion,
    versions.taskVersion,
    trial.fixture.id,
    trial.trial.seed,
    trial.trial.repeatIndex,
  ].join('::');
}

export function groupCoordinationWorkloads(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = workloadKey(trial);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ key, rows }));
}

export function routingInputForFixture(fixture, workload) {
  const dependencyEdges = fixture.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0);
  const rootTasks = fixture.tasks.filter(task => task.dependsOn.length === 0).length;
  const capabilitySet = new Set();
  for (const worker of fixture.workers) for (const capability of worker.capabilities ?? []) capabilitySet.add(capability);
  const request = [
    fixture.description,
    `Task graph: ${fixture.tasks.length} task(s), ${dependencyEdges} dependency edge(s), ${rootTasks} initially independent root task(s).`,
    `Scenario kind: ${fixture.kind}. Exercises: ${(fixture.exercises ?? []).join(', ') || 'none'}.`,
  ].join(' ');
  return normalizeRoutingInput({
    request,
    metadata: {
      workloadKey: workload.key,
      benchmarkFixtureId: fixture.id,
      benchmarkSchemaVersion: fixture.schemaVersion,
      kind: fixture.kind,
      exercises: fixture.exercises ?? [],
      taskCount: fixture.tasks.length,
      dependencyEdges,
      rootTasks,
      workerCount: fixture.workers.length,
      distinctCapabilities: capabilitySet.size,
      injectedFaultCount: fixture.faults?.length ?? 0,
      totalRelativeEffort: fixture.tasks.reduce((sum, task) => sum + (Number(task.effort) || 0), 0),
    },
  });
}

function successful(rows) {
  return rows.filter(row => row.quality?.acceptancePassed === true);
}

function rowMetric(row, metric) {
  if (metric === 'tokens') return row.efficiency?.providerTokens;
  if (metric === 'cost') return row.efficiency?.providerCost;
  return row.timing?.wallMs;
}

function comparableProviderCost(rows) {
  if (!rows.length || !rows.every(row => finite(row.efficiency?.providerCost))) return null;
  const currencies = new Set(rows.map(row => row.efficiency?.providerCurrency).filter(Boolean));
  if (currencies.size !== 1) return null;
  return {
    value: minimumMetric(rows, 'cost'),
    currency: [...currencies][0],
  };
}

function minimumMetric(rows, metric) {
  const values = rows.map(row => rowMetric(row, metric)).filter(finite);
  return values.length ? Math.min(...values) : null;
}

function cheapestWorkflow(rows) {
  const accepted = successful(rows);
  if (!accepted.length) return null;
  const withTokens = accepted.filter(row => finite(row.efficiency?.providerTokens));
  const candidates = withTokens.length === accepted.length ? withTokens : accepted.filter(row => finite(row.timing?.wallMs));
  if (!candidates.length) return accepted[0].trial.workflow;
  const metric = withTokens.length === accepted.length ? 'tokens' : 'wall';
  return [...candidates].sort((a, b) => rowMetric(a, metric) - rowMetric(b, metric))[0].trial.workflow;
}

export function scoreRoutingPrediction(rows, prediction) {
  assert.ok(['single', 'orchestrated'].includes(prediction.strategy), 'prediction strategy must be single or orchestrated');
  const single = rows.find(row => row.trial.workflow === 'single_worker') ?? null;
  const orchestrated = rows.filter(row => row.trial.workflow !== 'single_worker');
  const accepted = successful(rows);
  const acceptedOrchestrated = successful(orchestrated);
  const singlePassed = single?.quality?.acceptancePassed === true;
  const orchestratedPassed = acceptedOrchestrated.length > 0;
  const underOrchestration = prediction.strategy === 'single' && !singlePassed && orchestratedPassed;

  const predictedRows = prediction.strategy === 'single'
    ? (single ? [single] : [])
    : acceptedOrchestrated;
  const predictedMeetsQuality = prediction.strategy === 'single' ? singlePassed : orchestratedPassed;

  const bestTokens = minimumMetric(accepted, 'tokens');
  const bestWallMs = minimumMetric(accepted, 'wall');
  const predictedTokens = predictedMeetsQuality ? minimumMetric(predictedRows, 'tokens') : null;
  const predictedWallMs = predictedMeetsQuality ? minimumMetric(predictedRows, 'wall') : null;
  const bestCost = comparableProviderCost(accepted);
  const predictedCost = predictedMeetsQuality ? comparableProviderCost(predictedRows) : null;
  const comparableCost = bestCost && predictedCost && bestCost.currency === predictedCost.currency;

  return {
    qualityTarget: 'deterministic acceptancePassed=true',
    cheapestSuccessfulWorkflow: cheapestWorkflow(rows),
    singleSufficient: singlePassed,
    orchestratedConditionSucceeded: orchestratedPassed,
    predictedStrategyMeetsQuality: predictedMeetsQuality,
    underOrchestration,
    routingRegretTokens: predictedTokens === null || bestTokens === null ? null : predictedTokens - bestTokens,
    routingRegretWallMs: predictedWallMs === null || bestWallMs === null ? null : predictedWallMs - bestWallMs,
    routingRegretProviderCost: comparableCost ? predictedCost.value - bestCost.value : null,
    routingRegretProviderCurrency: comparableCost ? bestCost.currency : null,
    observedWorkflows: rows.map(row => ({
      workflow: row.trial.workflow,
      acceptancePassed: row.quality?.acceptancePassed ?? null,
      defects: row.quality?.defects ?? null,
      reworkEvents: row.quality?.reworkEvents ?? null,
      duplicateWork: row.quality?.duplicateWork ?? null,
      clarificationRounds: row.coordination?.clarificationRounds ?? null,
      handoffCount: row.coordination?.handoffCount ?? null,
      recoveryEvents: row.coordination?.recoveryEvents ?? null,
      escalationEvents: 0,
      providerTokens: row.efficiency?.providerTokens ?? null,
      providerCost: row.efficiency?.providerCost ?? null,
      providerCurrency: row.efficiency?.providerCurrency ?? null,
      wallMs: row.timing?.wallMs ?? null,
    })).sort((a, b) => a.workflow.localeCompare(b.workflow)),
    note: prediction.strategy === 'orchestrated'
      ? 'Phase 1 does not select an orchestration topology; regret uses the cheapest observed successful orchestrated condition as a lower-bound orchestration cost.'
      : null,
  };
}

export function summarizeRoutingRecords(records, policy) {
  const checkedPolicy = validateRoutingPolicy(policy);
  const evaluations = records.map(record => record.evaluation).filter(Boolean);
  const providerOk = records.filter(record => record.result?.provider?.status === 'ok');
  const routerInputTokens = providerOk.map(record => record.result.provider.usage?.inputTokens);
  const routerOutputTokens = providerOk.map(record => record.result.provider.usage?.outputTokens);
  const routerLatency = providerOk.map(record => record.result.provider.latencyMs);
  const providerCosts = providerOk.map(record => record.result.provider.cost).filter(finite);
  const regretTokens = evaluations.map(item => item.routingRegretTokens).filter(finite);
  const regretWall = evaluations.map(item => item.routingRegretWallMs).filter(finite);
  const costRegretByCurrency = {};
  for (const evaluation of evaluations) {
    if (!finite(evaluation.routingRegretProviderCost) || !evaluation.routingRegretProviderCurrency) continue;
    const currency = evaluation.routingRegretProviderCurrency;
    const bucket = costRegretByCurrency[currency] ??= { observations: 0, aggregate: 0 };
    bucket.observations++;
    bucket.aggregate += evaluation.routingRegretProviderCost;
  }
  for (const bucket of Object.values(costRegretByCurrency)) bucket.mean = bucket.aggregate / bucket.observations;
  const singlePredictions = records.filter(record => record.result?.prediction?.strategy === 'single').length;
  const orchestratedPredictions = records.filter(record => record.result?.prediction?.strategy === 'orchestrated').length;
  const under = evaluations.filter(item => item.underOrchestration).length;
  return {
    schemaVersion: 1,
    evidenceClass: 'adaptive_routing_shadow_summary',
    contractVersion: 'adaptive-routing-v1',
    policyId: checkedPolicy.id,
    workloads: records.length,
    predictions: { single: singlePredictions, orchestrated: orchestratedPredictions },
    fallbackDecisions: records.filter(record => record.result?.prediction?.fallbackUsed).length,
    providerFailures: records.filter(record => record.result?.provider?.status === 'unavailable').length,
    underOrchestration: {
      count: under,
      rate: evaluations.length ? under / evaluations.length : null,
    },
    routingRegret: {
      tokenObservations: regretTokens.length,
      aggregateTokens: regretTokens.length ? regretTokens.reduce((sum, value) => sum + value, 0) : null,
      meanTokens: mean(regretTokens),
      wallObservations: regretWall.length,
      aggregateWallMs: regretWall.length ? regretWall.reduce((sum, value) => sum + value, 0) : null,
      meanWallMs: mean(regretWall),
      providerCostByCurrency: costRegretByCurrency,
    },
    routerOverhead: {
      providerCalls: providerOk.length,
      totalInputTokens: routerInputTokens.filter(finite).reduce((sum, value) => sum + value, 0),
      totalOutputTokens: routerOutputTokens.filter(finite).reduce((sum, value) => sum + value, 0),
      meanLatencyMs: mean(routerLatency),
      measuredProviderCost: providerCosts.length ? providerCosts.reduce((sum, value) => sum + value, 0) : null,
      providerCostObservations: providerCosts.length,
    },
    activationGate: checkedPolicy.activationGate,
    activeRoutingEligible: false,
    interpretation: 'Shadow-only evidence. The router prediction never changes the workflow executed by the benchmark. Do not enable active routing until the checked-in activation gate has empirical evidence, including positive-class under-orchestration cases.',
  };
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    input: null,
    output: null,
    decisions: null,
    repoRoot: root,
    policy: null,
    provider: 'off',
    model: null,
    timeoutMs: 2_000,
    costPerMillionTokens: null,
    costCurrency: 'USD',
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--input') options.input = path.resolve(argv[++index]);
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else if (arg === '--decisions') options.decisions = path.resolve(argv[++index]);
    else if (arg === '--root') options.repoRoot = path.resolve(argv[++index]);
    else if (arg === '--policy') options.policy = path.resolve(argv[++index]);
    else if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--cost-per-million-tokens') options.costPerMillionTokens = Number(argv[++index]);
    else if (arg === '--cost-currency') options.costCurrency = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  assert.ok(['shadow', 'score'].includes(options.command), 'Use shadow or score');
  return options;
}

function readDecisionRecords(file) {
  assert.ok(file && existsSync(file), '--decisions JSONL file is required');
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const policy = loadPolicy(options.repoRoot, options.policy);

  if (options.command === 'score') {
    const records = readDecisionRecords(options.decisions);
    const summary = summarizeRoutingRecords(records, policy);
    const json = JSON.stringify(summary, null, 2) + '\n';
    if (options.output) writeFileSync(options.output, json);
    else process.stdout.write(json);
    return summary;
  }

  assert.ok(options.input && existsSync(options.input), '--input coordination cohort directory is required');
  assert.ok(['off', 'typesafe'].includes(options.provider), '--provider must be off or typesafe');
  assert.ok(options.decisions, '--decisions output JSONL path is required');
  assert.ok(!existsSync(options.decisions), 'decisions output already exists; retain prior evidence or choose a new path');

  const trials = readCohort(options.input);
  const fixtureMap = new Map(loadFixtures(options.repoRoot).map(fixture => [fixture.id, fixture]));
  const records = [];
  for (const workload of groupCoordinationWorkloads(trials)) {
    const fixtureId = workload.rows[0].fixture.id;
    const fixture = fixtureMap.get(fixtureId);
    assert.ok(fixture, `unknown benchmark fixture ${fixtureId}`);
    const input = routingInputForFixture(fixture, workload);
    const result = await evaluateAdaptiveRouting(input, {
      policy,
      provider: options.provider,
      apiKey: process.env.TYPESAFE_API_KEY ?? null,
      model: options.model ?? undefined,
      timeoutMs: options.timeoutMs,
      costPerMillionTokens: options.costPerMillionTokens,
      costCurrency: options.costCurrency,
    });
    const evaluation = scoreRoutingPrediction(workload.rows, result.prediction);
    const record = {
      ...routingDecisionRecord(input, result, policy, {
        shadow: true,
        benchmarkObservedWorkflows: evaluation.observedWorkflows.map(row => row.workflow),
        behaviorChanged: false,
      }),
      evaluation,
    };
    appendRoutingDecision(options.decisions, record);
    records.push(record);
    process.stdout.write(JSON.stringify({
      workloadKey: workload.key,
      predicted: result.prediction.strategy,
      reason: result.prediction.reason,
      underOrchestration: evaluation.underOrchestration,
    }) + '\n');
  }

  const summary = summarizeRoutingRecords(records, policy);
  const output = options.output ?? path.join(options.input, 'routing-shadow-v1-summary.json');
  writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
