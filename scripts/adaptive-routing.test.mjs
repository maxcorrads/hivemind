import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ROUTING_CONTRACT_VERSION,
  ROUTING_QUESTIONS,
  ROUTING_SIGNAL_IDS,
  appendRoutingDecision,
  decideRouting,
  evaluateAdaptiveRouting,
  routingDecisionRecord,
} from './adaptive-routing.mjs';
import {
  groupCoordinationWorkloads,
  scoreRoutingPrediction,
  summarizeRoutingRecords,
} from './benchmark-adaptive-routing.mjs';

const policy = {
  schemaVersion: 1,
  id: 'test-shadow-v1',
  contractVersion: ROUTING_CONTRACT_VERSION,
  mode: 'shadow',
  fallback: 'orchestrated',
  minConfidence: 0.6,
  singleSufficiencyConfidence: 0.8,
  singleMaxComplexity: 0.8,
  singleMaxCoordinationNeed: 0.8,
  singleMaxSpecializationNeed: 0.8,
  orchestratedMinCoordinationNeed: 1.25,
  orchestratedMinParallelPressure: 1.0,
  orchestratedMinSpecializationNeed: 1.25,
  calibrationStatus: 'test-only',
  calibrationCohorts: [],
  activationGate: {
    enabled: false,
    requiredEvidence: ['positive class', 'net savings'],
  },
};

function score(score, confidence = 0.9) {
  return {
    type: 'score',
    score,
    confidence,
    probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 },
  };
}

function signals(overrides = {}) {
  return {
    single_agent_sufficiency: {
      type: 'choice',
      choice: 'sufficient',
      confidence: 0.95,
      probabilities: { sufficient: 0.95, insufficient: 0.05 },
    },
    complexity: score(0.4),
    parallelizability: score(0.4),
    coupling: score(0.4),
    specialization_need: score(0.3),
    coordination_need: score(0.3),
    ...overrides,
  };
}

function providerPayload(answers = signals()) {
  return {
    model: 'jev-fixture',
    answers,
    usage: { input_tokens: 120, output_tokens: 36 },
  };
}

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

function trial(workflow, {
  passed = true,
  tokens = 100,
  wallMs = 1000,
  cost = null,
  currency = null,
  defects = 0,
  rework = 0,
  duplicate = 0,
  clarifications = 0,
  handoffs = 0,
  recovery = 0,
} = {}) {
  return {
    trial: { workflow },
    quality: {
      acceptancePassed: passed,
      defects,
      reworkEvents: rework,
      duplicateWork: duplicate,
    },
    coordination: {
      clarificationRounds: clarifications,
      handoffCount: handoffs,
      recoveryEvents: recovery,
    },
    efficiency: {
      providerTokens: tokens,
      providerCost: cost,
      providerCurrency: currency,
    },
    timing: { wallMs },
  };
}

test('routing contract defines six independent atomic TypeSafe questions', () => {
  assert.deepEqual(Object.keys(ROUTING_QUESTIONS), [...ROUTING_SIGNAL_IDS]);
  assert.equal(ROUTING_SIGNAL_IDS.length, 6);
  assert.equal(ROUTING_QUESTIONS.single_agent_sufficiency.type, 'choice');
  for (const id of ROUTING_SIGNAL_IDS.filter(id => id !== 'single_agent_sufficiency')) {
    assert.equal(ROUTING_QUESTIONS[id].type, 'score');
    assert.equal(ROUTING_QUESTIONS[id].criteria.length, 3);
  }
});

test('deterministic policy selects high-confidence single when one session is sufficient', () => {
  const result = decideRouting(signals(), policy);
  assert.equal(result.strategy, 'single');
  assert.equal(result.reason, 'high_confidence_single_sufficient');
  assert.equal(result.fallbackUsed, false);
});

test('deterministic policy selects orchestration when coordination pressure is high', () => {
  const result = decideRouting(signals({
    single_agent_sufficiency: {
      type: 'choice',
      choice: 'insufficient',
      confidence: 0.95,
      probabilities: { sufficient: 0.05, insufficient: 0.95 },
    },
    coordination_need: score(1.8),
  }), policy);
  assert.equal(result.strategy, 'orchestrated');
  assert.equal(result.reason, 'coordination_pressure');
  assert.equal(result.fallbackUsed, false);
});

test('medium confidence stays above the uncertainty floor but uses the ambiguous fallback', () => {
  const result = decideRouting(signals({
    single_agent_sufficiency: {
      type: 'choice',
      choice: 'sufficient',
      confidence: 0.7,
      probabilities: { sufficient: 0.7, insufficient: 0.3 },
    },
    complexity: score(1.0, 0.7),
    parallelizability: score(1.0, 0.7),
    coupling: score(1.0, 0.7),
    specialization_need: score(1.0, 0.7),
    coordination_need: score(1.0, 0.7),
  }), policy);
  assert.equal(result.strategy, 'orchestrated');
  assert.equal(result.reason, 'ambiguous_policy_fallback');
  assert.equal(result.fallbackUsed, true);
});

test('low confidence uses explicit conservative fallback', () => {
  const result = decideRouting(signals({ complexity: score(0.4, 0.2) }), policy);
  assert.equal(result.strategy, 'orchestrated');
  assert.equal(result.reason, 'low_confidence_fallback');
  assert.equal(result.fallbackUsed, true);
});

test('explicit strategy fast path bypasses Jev and never calls fetch', async () => {
  let called = false;
  const result = await evaluateAdaptiveRouting({
    request: 'Run exactly one session for this request.',
    explicitStrategy: 'single',
  }, {
    policy,
    provider: 'typesafe',
    apiKey: 'should-not-be-used',
    fetchImpl: async () => { called = true; throw new Error('unexpected'); },
  });
  assert.equal(called, false);
  assert.equal(result.provider.status, 'bypassed');
  assert.equal(result.prediction.strategy, 'single');
  assert.equal(result.prediction.eligibleForActiveRouting, false);
});

test('disabled or unavailable provider cannot prevent a routing decision', async () => {
  const disabled = await evaluateAdaptiveRouting({ request: 'Do some work.' }, { policy, provider: 'off' });
  assert.equal(disabled.prediction.strategy, 'orchestrated');
  assert.equal(disabled.provider.error, 'disabled');

  const missing = await evaluateAdaptiveRouting({ request: 'Do some work.' }, {
    policy,
    provider: 'typesafe',
    apiKey: null,
  });
  assert.equal(missing.prediction.strategy, 'orchestrated');
  assert.equal(missing.provider.error, 'missing_credentials');
});

test('TypeSafe response captures usage/latency shape and malformed replies fall back', async () => {
  const good = await evaluateAdaptiveRouting({ request: 'Small local fix.' }, {
    policy,
    provider: 'typesafe',
    apiKey: 'fixture-key',
    fetchImpl: async () => okResponse(providerPayload()),
  });
  assert.equal(good.provider.status, 'ok');
  assert.equal(good.provider.usage.inputTokens, 120);
  assert.equal(good.provider.usage.outputTokens, 36);
  assert.equal(good.provider.cost, null);
  assert.equal(good.prediction.strategy, 'single');

  const bad = await evaluateAdaptiveRouting({ request: 'Small local fix.' }, {
    policy,
    provider: 'typesafe',
    apiKey: 'fixture-key',
    fetchImpl: async () => okResponse({ model: 'jev-fixture', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.equal(bad.provider.error, 'malformed_response');
  assert.equal(bad.prediction.strategy, 'orchestrated');
});

test('provider network errors fall back instead of failing the request', async () => {
  const result = await evaluateAdaptiveRouting({ request: 'Network failure fixture.' }, {
    policy,
    provider: 'typesafe',
    apiKey: 'fixture-key',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.provider.error, 'network_error');
  assert.equal(result.prediction.strategy, 'orchestrated');
  assert.equal(result.prediction.fallbackUsed, true);
});

test('routing decision persistence redacts credential-shaped metadata', async () => {
  const result = await evaluateAdaptiveRouting({
    request: 'Inspect only prompt-level metadata.',
    metadata: {
      project: 'fixture',
      apiKey: 'do-not-persist',
      accessToken: 'also-do-not-persist',
      nested: { authorization: 'Bearer nope', safe: 'ok' },
    },
  }, { policy, provider: 'off' });
  const record = routingDecisionRecord({
    request: 'Inspect only prompt-level metadata.',
    metadata: {
      project: 'fixture',
      apiKey: 'do-not-persist',
      accessToken: 'also-do-not-persist',
      nested: { authorization: 'Bearer nope', safe: 'ok' },
    },
  }, result, policy, { shadow: true, behaviorChanged: false, providerTokens: 123 });
  assert.equal(record.input.metadata.apiKey, undefined);
  assert.equal(record.input.metadata.accessToken, undefined);
  assert.equal(record.input.metadata.nested.authorization, undefined);
  assert.equal(record.input.metadata.nested.safe, 'ok');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-routing-'));
  try {
    const file = path.join(dir, 'decisions.jsonl');
    appendRoutingDecision(file, record);
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /do-not-persist|Bearer nope|"apiKey"|"accessToken"|"authorization"/);
    assert.match(text, /"project":"fixture"/);
    assert.match(text, /"providerTokens":123/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay grouping never mixes different pinned benchmark cohorts', () => {
  const base = {
    fixture: { id: 'fixture-a' },
    trial: { workflow: 'single_worker', seed: 29, repeatIndex: 0 },
    versions: {
      hivemindRevision: 'rev-a',
      provider: 'provider-a',
      model: 'model-a',
      host: 'host-a',
      configuration: 'config-a',
      promptVersion: 'prompt-a',
      taskVersion: 'task-a',
    },
  };
  const same = structuredClone(base);
  same.trial.workflow = 'brain_one_worker';
  const other = structuredClone(base);
  other.versions.model = 'model-b';
  const groups = groupCoordinationWorkloads([base, same, other]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.rows.length).sort(), [1, 2]);
});

test('shadow scoring produces routing regret and under-orchestration separately', () => {
  const easyRows = [
    trial('single_worker', { passed: true, tokens: 20, wallMs: 100, cost: 0.02, currency: 'USD' }),
    trial('brain_one_worker', { passed: true, tokens: 80, wallMs: 400, cost: 0.08, currency: 'USD', rework: 1 }),
    trial('brain_multi_dm', { passed: true, tokens: 120, wallMs: 500, cost: 0.12, currency: 'USD', clarifications: 2, handoffs: 1 }),
    trial('brain_multi_room', { passed: true, tokens: 160, wallMs: 700, cost: 0.16, currency: 'USD', duplicate: 1 }),
  ];
  const easy = scoreRoutingPrediction(easyRows, { strategy: 'orchestrated' });
  assert.equal(easy.cheapestSuccessfulWorkflow, 'single_worker');
  assert.equal(easy.routingRegretTokens, 60);
  assert.equal(easy.routingRegretWallMs, 300);
  assert.equal(easy.routingRegretProviderCost, 0.06);
  assert.equal(easy.routingRegretProviderCurrency, 'USD');
  assert.equal(easy.underOrchestration, false);
  const dm = easy.observedWorkflows.find(row => row.workflow === 'brain_multi_dm');
  assert.equal(dm.clarificationRounds, 2);
  assert.equal(dm.handoffCount, 1);
  assert.equal(dm.escalationEvents, 0);

  const hardRows = [
    trial('single_worker', { passed: false, tokens: 25, wallMs: 120 }),
    trial('brain_one_worker', { passed: true, tokens: 90, wallMs: 350 }),
    trial('brain_multi_dm', { passed: true, tokens: 110, wallMs: 380 }),
  ];
  const hard = scoreRoutingPrediction(hardRows, { strategy: 'single' });
  assert.equal(hard.underOrchestration, true);
  assert.equal(hard.predictedStrategyMeetsQuality, false);
  assert.equal(hard.routingRegretTokens, null);
});

test('summary measures router overhead but keeps active routing gated off', () => {
  const record = {
    result: {
      provider: {
        status: 'ok',
        latencyMs: 25,
        usage: { inputTokens: 100, outputTokens: 20 },
        cost: null,
      },
      prediction: { strategy: 'single', fallbackUsed: false },
    },
    evaluation: {
      routingRegretTokens: 0,
      routingRegretWallMs: 0,
      routingRegretProviderCost: 0.05,
      routingRegretProviderCurrency: 'USD',
      underOrchestration: false,
    },
  };
  const summary = summarizeRoutingRecords([record], policy);
  assert.equal(summary.routerOverhead.totalInputTokens, 100);
  assert.equal(summary.routerOverhead.totalOutputTokens, 20);
  assert.equal(summary.routerOverhead.meanLatencyMs, 25);
  assert.deepEqual(summary.routingRegret.providerCostByCurrency.USD, {
    observations: 1,
    aggregate: 0.05,
    mean: 0.05,
  });
  assert.equal(summary.activeRoutingEligible, false);
  assert.equal(summary.activationGate.enabled, false);
});
