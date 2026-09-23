import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { evaluateAdaptiveTopology, topologyQuestions, MAX_PLAN_WORKERS, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';

function snapshot(usable = 3, only = false): TopologyEvaluationSnapshot {
  return { request: 'Complete this phase.', project: { slug: 'test', name: 'Test' },
    current: { topology: 'brain_multi_room', workerBudget: 2, desiredTopology: null, desiredWorkers: null },
    capacity: { workers: { total: usable, online: usable, busyOther: 0, busyCurrent: 0, free: usable,
      usableForExecution: usable, available: [] }, activeTasks: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    execution: { orchestratedOnly: only, lockedTopology: null, lockScope: 'none' },
    tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    recentCoordinationEvents: [], trigger: { kind: 'brain_message' }, previousDecision: null };
}

test('offered plans are every consistent plan for actual capacity, including zero capacity and orchestrated-only mode', () => {
  for (const usable of [0, 1, 2, 3, 8, 300]) for (const only of [false, true]) {
    const input = snapshot(usable, only); input.current = null;
    const { plans, questions } = topologyQuestions(input);
    const expected = [
      ...(!only || usable === 0 ? ['single'] : []), ...(usable >= 1 ? ['brain_one_worker'] : []),
      ...Array.from({ length: Math.max(0, Math.min(usable, MAX_PLAN_WORKERS) - 1) }, (_, i) => [`brain_multi_dm_${i + 2}`, `brain_multi_room_${i + 2}`]).flat(),
      ...(usable === 0 || (only && usable === 1) ? ['capacity_blocked'] : []),
    ];
    assert.deepEqual(Object.keys(plans), expected, `usable=${usable} only=${only}`);
    assert.ok(Object.keys(plans).length <= 18 && Object.values(plans).every(text => text.length > 20));
    assert.deepEqual(Object.keys(questions), ['single_agent_sufficiency', 'complexity', 'parallelizability', 'coupling',
      'specialization_need', 'coordination_need', 'plan']);
    assert.ok(!('target_topology' in questions) && !('worker_budget' in questions));
  }
  // A running plan above the cap stays offered, so the cap alone never forces a de-escalation.
  const above = snapshot(12); above.current = { topology: 'brain_multi_dm', workerBudget: 11, desiredTopology: null, desiredWorkers: null };
  const plans = Object.keys(topologyQuestions(above).plans);
  assert.ok(plans.includes('brain_multi_dm_11') && plans.includes('brain_multi_room_11') && !plans.includes('brain_multi_dm_9'));
  assert.ok(plans.includes('brain_multi_room_8'));
  assert.throws(() => topologyQuestions(snapshot(-1)));
  assert.throws(() => topologyQuestions(snapshot(1.5)));
});

test('every plan kind parses into its topology and worker count and accounts for usage', async () => {
  for (const [usable, only, target, workers] of [
    [0, false, 'capacity_blocked', 0], [0, false, 'single', 0], [0, true, 'capacity_blocked', 0],
    [1, false, 'brain_one_worker', 1], [1, true, 'capacity_blocked', 0], [1, true, 'brain_one_worker', 1],
    [3, false, 'brain_multi_dm', 3], [3, true, 'brain_multi_room', 2], [3, false, 'single', 0],
    [20, false, 'brain_multi_dm', 8], [20, true, 'brain_multi_room', 8], [2, false, 'brain_multi_dm', 2],
  ] as const) {
    const input = snapshot(usable, only);
    let offered: string[] = [];
    const result = await evaluateAdaptiveTopology(input, { apiKey: 'unit-fixture' }, {
      fetchImpl: async (_url, init) => {
        assert.equal(init?.redirect, 'error');
        assert.ok(String(init?.body).includes('Complete this phase.'));
        offered = Object.keys(JSON.parse(String(init?.body)).questions.plan.criteria);
        return Response.json(jevTopologyResponse(String(init?.body), target, workers));
      },
    });
    assert.equal(result.providerStatus, 'ok', `${target}·${workers}: ${result.error}`);
    assert.equal(result.contractVersion, 'adaptive-routing-v3');
    assert.equal(result.targetTopology, target === 'capacity_blocked' ? 'single' : target);
    assert.equal(result.targetWorkers, workers);
    assert.equal(result.needsOrchestration, target !== 'single');
    assert.equal(result.error, null);
    assert.equal(result.model, 'jev-topology-fixture');
    assert.equal(result.inputTokens, 80);
    assert.equal(result.outputTokens, 20);
    assert.ok(offered.length >= 2);
  }
  // A running plan above the cap can be kept.
  const above = snapshot(12); above.current = { topology: 'brain_multi_room', workerBudget: 10, desiredTopology: null, desiredWorkers: null };
  const kept = await evaluateAdaptiveTopology(above, { apiKey: 'unit-fixture' }, {
    fetchImpl: async (_url, init) => Response.json(jevTopologyResponse(String(init?.body), 'brain_multi_room', 10)) });
  assert.equal(kept.providerStatus, 'ok'); assert.equal(kept.targetWorkers, 10);
});

test('confidence is the lowest of the plan and signal answers', async () => {
  for (const [question, value] of [['plan', 0.7], ['coupling', 0.61], ['single_agent_sufficiency', 0.65]] as const) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture' }, {
      fetchImpl: async (_url, init) => {
        const payload = jevTopologyResponse(String(init?.body), 'brain_multi_dm', 3) as { answers: Record<string, { confidence: number }> };
        payload.answers[question]!.confidence = value;
        return Response.json(payload);
      },
    });
    assert.equal(result.confidence, value, question);
  }
});

test('a plan that was not offered is rejected as plan_not_offered, keeping the resolved model and usage', async () => {
  for (const choice of ['brain_multi_dm_9', 'brain_multi_dm_1', 'workers_2', 'brain_one_worker_2', 'made_up', 'single']) {
    const exchanges: Array<{ error: string | null; received: unknown }> = [];
    const result = await evaluateAdaptiveTopology(snapshot(12, true), { apiKey: 'never-log-secret' }, {
      onExchange: exchange => exchanges.push(exchange),
      fetchImpl: async (_url, init) => {
        const payload = jevTopologyResponse(String(init?.body), 'brain_multi_dm', 2) as any;
        payload.answers.plan.choice = choice;
        payload.model = 'jev-1.13.0'; payload.usage = { input_tokens: 2851, output_tokens: 248 };
        return Response.json(payload);
      },
    });
    assert.equal(result.providerStatus, 'unavailable', choice);
    assert.equal(result.error, 'plan_not_offered', choice);
    assert.equal(result.reason, 'response_rejected_preserve_current');
    assert.equal(result.model, 'jev-1.13.0');
    assert.equal(result.inputTokens, 2851); assert.equal(result.outputTokens, 248);
    assert.equal(result.targetTopology, 'brain_multi_room'); assert.equal(result.targetWorkers, 2);
    assert.equal(exchanges.length, 1); assert.equal(exchanges[0]!.error, 'plan_not_offered'); assert.ok(exchanges[0]!.received);
    assert.doesNotMatch(JSON.stringify(result), /never-log-secret/);
  }
});

test('malformed or inconsistent provider replies are rejected with a specific reason and preserve current mode', async () => {
  const mutations: Array<[string, (payload: any) => unknown, string, boolean]> = [
    ['null envelope', () => null, 'malformed_response', false], ['array envelope', () => [], 'malformed_response', false],
    ['missing model', p => ({ ...p, model: null }), 'model_missing', false],
    ['oversize model', p => ({ ...p, model: 'x'.repeat(201) }), 'model_missing', false],
    ['missing usage', p => ({ ...p, usage: undefined }), 'missing_usage', true],
    ['negative usage', p => ({ ...p, usage: { input_tokens: -1, output_tokens: 0 } }), 'missing_usage', true],
    ['bad output usage', p => ({ ...p, usage: { input_tokens: 1, output_tokens: 1.5 } }), 'missing_usage', true],
    ['missing answers', p => ({ ...p, answers: undefined }), 'malformed_answer:single_agent_sufficiency', true],
    ['missing plan', p => { delete p.answers.plan; return p; }, 'malformed_answer:plan', true],
    ['missing confidence', p => { delete p.answers.plan.confidence; return p; }, 'malformed_answer:plan', true],
    ['negative confidence', p => { p.answers.plan.confidence = -1; return p; }, 'malformed_answer:plan', true],
    ['non-string plan', p => { p.answers.plan.choice = 3; return p; }, 'malformed_answer:plan', true],
    ['bad type', p => { p.answers.complexity.type = 'choice'; return p; }, 'malformed_answer:complexity', true],
    ['bad score', p => { p.answers.complexity.score = 3; return p; }, 'malformed_answer:complexity', true],
    ['unknown sufficiency', p => { p.answers.single_agent_sufficiency.choice = 'maybe'; return p; }, 'malformed_answer:single_agent_sufficiency', true],
    ['missing distribution', p => { p.answers.coupling.probabilities = null; return p; }, 'probabilities_invalid:coupling', true],
    ['wrong distribution keys', p => { p.answers.plan.probabilities = { x: 0.5, y: 0.5 }; return p; }, 'probabilities_invalid:plan', true],
    ['probability negative', p => { p.answers.complexity.probabilities['0'] = -1; return p; }, 'probabilities_invalid:complexity', true],
    ['probability sum', p => { p.answers.complexity.probabilities = { '0': 1, '1': 1, '2': 1 }; return p; }, 'probabilities_invalid:complexity', true],
    ['choice not maximum', p => { p.answers.plan.choice = 'brain_multi_dm_2'; return p; }, 'probabilities_invalid:plan', true],
    ['contradictory sufficiency', p => {
      p.answers.plan = { type: 'choice', choice: 'single', confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(p.answers.plan.probabilities).map(k => [k, k === 'single' ? 0.95 : 0.01])) };
      p.answers.single_agent_sufficiency = { type: 'choice', choice: 'insufficient', confidence: 0.99,
        probabilities: { insufficient: 0.99, sufficient: 0.01 } };
      return p;
    }, 'plan_contradicts_sufficiency', true],
  ];
  for (const [label, mutate, code, withModel] of mutations) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'never-log-secret' }, {
      fetchImpl: async (_url, init) => Response.json(mutate(jevTopologyResponse(String(init?.body), 'brain_multi_room', 2))),
    });
    assert.equal(result.providerStatus, 'unavailable', label);
    assert.equal(result.error, code, label);
    assert.equal(result.reason, 'response_rejected_preserve_current', label);
    assert.equal(result.model !== null, withModel, label);
    assert.equal(result.targetTopology, 'brain_multi_room', label);
    assert.equal(result.targetWorkers, 2);
    assert.equal(result.confidence, null);
    assert.doesNotMatch(JSON.stringify(result), /never-log-secret|made_up/);
  }
  // Sufficient, yet a delegating plan: coherent (delegation can still pay off), so it is accepted.
  const delegating = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture' }, {
    fetchImpl: async (_url, init) => {
      const payload = jevTopologyResponse(String(init?.body), 'brain_one_worker', 1) as any;
      payload.answers.single_agent_sufficiency = { type: 'choice', choice: 'sufficient', confidence: 0.9, probabilities: { sufficient: 0.9, insufficient: 0.1 } };
      return Response.json(payload);
    },
  });
  assert.equal(delegating.providerStatus, 'ok'); assert.equal(delegating.singleSufficient, true); assert.equal(delegating.needsOrchestration, false);
});

test('HTTP errors, empty bodies, malformed JSON, size budgets and request failures are bounded, specific fallbacks', async () => {
  const transports: Array<[() => Response, string]> = [
    [() => new Response('private diagnostic', { status: 401 }), 'http_401'],
    [() => new Response('private diagnostic', { status: 503 }), 'http_503'],
    [() => new Response(null), 'malformed_response'], [() => new Response('{'), 'malformed_response'],
    [() => new Response('x'.repeat(128 * 1024 + 1)), 'response_too_large'],
  ];
  for (const [transport, code] of transports) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { fetchImpl: async () => transport() });
    assert.equal(result.providerStatus, 'unavailable'); assert.equal(result.targetWorkers, 2);
    assert.equal(result.error, code); assert.equal(result.model, null); assert.equal(result.inputTokens, null);
    assert.equal(result.reason, 'provider_unavailable_preserve_current');
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
  }
  for (const timeoutMs of [0, -1, 10_001, 1.5]) {
    let called = false;
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { timeoutMs, fetchImpl: async () => { called = true; throw new Error('must not call'); } });
    assert.equal(called, false); assert.equal(result.providerStatus, 'unavailable'); assert.equal(result.error, 'invalid_timeout');
  }
  const badModel = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key', model: 'https://evil.example/x' }, { fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(badModel.error, 'invalid_model_setting');
  const badCapacity = snapshot(); badCapacity.capacity.workers.usableForExecution = -1;
  assert.equal((await evaluateAdaptiveTopology(badCapacity, { apiKey: 'fixture-key' }, { fetchImpl: async () => { throw new Error('must not call'); } })).error, 'invalid_snapshot');
  const big = snapshot(); big.request = 'x'.repeat(64 * 1024);
  let called = false;
  const tooBig = await evaluateAdaptiveTopology(big, { apiKey: 'fixture-key' }, { fetchImpl: async () => { called = true; throw new Error('must not call'); } });
  assert.equal(called, false); assert.equal(tooBig.providerStatus, 'unavailable'); assert.equal(tooBig.error, 'request_too_large');
  const initial = snapshot(); initial.current = null;
  const failed = await evaluateAdaptiveTopology(initial, { apiKey: 'fixture-key' }, { fetchImpl: async () => { throw new Error('secret-fixture'); } });
  assert.equal(failed.targetTopology, 'single'); assert.equal(failed.targetWorkers, 0); assert.equal(failed.error, 'network');
  assert.doesNotMatch(JSON.stringify(failed), /secret-fixture/);
  const broken = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, {
    fetchImpl: async (_url, init) => Response.json(jevTopologyResponse(String(init?.body), 'brain_multi_room', 2)),
    onExchange: exchange => { if (exchange.error === null) throw new Error('log unavailable'); },
  });
  assert.equal(broken.providerStatus, 'unavailable'); assert.equal(broken.error, 'internal_error');
});

test('timeout and shutdown cancellation interrupt the in-flight provider call', async () => {
  const waiting: typeof fetch = async (_url, init) => {
    await delay(1000, undefined, { signal: init?.signal ?? undefined });
    throw new Error('Should have aborted');
  };
  const timeout = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { timeoutMs: 1, fetchImpl: waiting });
  assert.equal(timeout.providerStatus, 'unavailable'); assert.match(timeout.reason, /timeout/); assert.equal(timeout.error, 'timeout');
  const controller = new AbortController(); controller.abort();
  const stopped = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { signal: controller.signal, fetchImpl: waiting });
  assert.equal(stopped.providerStatus, 'unavailable'); assert.equal(stopped.error, 'cancelled');
});
