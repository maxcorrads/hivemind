import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { evaluateAdaptiveTopology, topologyQuestions, MAX_PLAN_WORKERS, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { contradictoryJevAnswer, jevTopologyResponse } from './fixtures/jev-topology.ts';

function snapshot(usable = 3): TopologyEvaluationSnapshot {
  return { request: 'Complete this phase.', project: { slug: 'test', name: 'Test' },
    capacity: { workers: { total: usable, online: usable, busyOther: 0, busyCurrent: 0, free: usable,
      usableForExecution: usable, available: [] }, activeTasks: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    recentCoordinationEvents: [], trigger: { kind: 'brain_message' }, previousDecision: null };
}

test('offered plans are every consistent plan for actual capacity, including zero capacity', () => {
  for (const usable of [0, 1, 2, 3, 8, 300]) {
    const input = snapshot(usable);
    const { plans, questions } = topologyQuestions(input);
    const expected = [
      'single', ...(usable >= 1 ? ['brain_one_worker'] : []),
      ...Array.from({ length: Math.max(0, Math.min(usable, MAX_PLAN_WORKERS) - 1) }, (_, i) => [`brain_multi_dm_${i + 2}`, `brain_multi_room_${i + 2}`]).flat(),
      ...(usable === 0 ? ['capacity_blocked'] : []),
    ];
    assert.deepEqual(Object.keys(plans), expected, `usable=${usable}`);
    assert.ok(Object.keys(plans).length <= 17 && Object.values(plans).every(text => text.length > 20));
    assert.deepEqual(Object.keys(questions), ['single_agent_sufficiency', 'complexity', 'parallelizability', 'coupling',
      'specialization_need', 'coordination_need', 'plan']);
    assert.ok(!('target_topology' in questions) && !('worker_budget' in questions));
  }
  // No mode is applied (#211), so nothing above the cap is ever offered.
  const plans = Object.keys(topologyQuestions(snapshot(12)).plans);
  assert.ok(plans.includes('brain_multi_room_8') && !plans.includes('brain_multi_dm_9'));
  const question = topologyQuestions(snapshot(3)).questions.plan as { instructions: Record<string, unknown> };
  assert.deepEqual(Object.keys(question.instructions), ['question', 'free_workers', 'already_working_for_this_brain', 'usable_workers']);
  assert.throws(() => topologyQuestions(snapshot(-1)));
  assert.throws(() => topologyQuestions(snapshot(1.5)));
});

test('every plan kind parses into its topology and worker count and accounts for usage', async () => {
  for (const [usable, target, workers] of [
    [0, 'capacity_blocked', 0], [0, 'single', 0], [1, 'brain_one_worker', 1], [3, 'brain_multi_dm', 3],
    [3, 'brain_multi_room', 2], [3, 'single', 0], [20, 'brain_multi_dm', 8], [20, 'brain_multi_room', 8], [2, 'brain_multi_dm', 2],
  ] as const) {
    const input = snapshot(usable);
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
  for (const choice of ['brain_multi_dm_9', 'brain_multi_dm_1', 'workers_2', 'brain_one_worker_2', 'made_up']) {
    const exchanges: Array<{ error: string | null; received: unknown }> = [];
    const result = await evaluateAdaptiveTopology(snapshot(12), { apiKey: 'never-log-secret' }, {
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
    assert.equal(result.reason, 'response_rejected');
    assert.equal(result.model, 'jev-1.13.0');
    assert.equal(result.inputTokens, 2851); assert.equal(result.outputTokens, 248);
    assert.equal(result.targetTopology, 'single'); assert.equal(result.targetWorkers, 0);
    assert.equal(exchanges.length, 1); assert.equal(exchanges[0]!.error, 'plan_not_offered'); assert.ok(exchanges[0]!.received);
    assert.doesNotMatch(JSON.stringify(result), /never-log-secret/);
  }
});

test('malformed or inconsistent provider replies are rejected with a specific reason', async () => {
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
  ];
  for (const [label, mutate, code, withModel] of mutations) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'never-log-secret' }, {
      fetchImpl: async (_url, init) => Response.json(mutate(jevTopologyResponse(String(init?.body), 'brain_multi_room', 2))),
    });
    assert.equal(result.providerStatus, 'unavailable', label);
    assert.equal(result.error, code, label);
    assert.equal(result.reason, 'response_rejected', label);
    assert.equal(result.model !== null, withModel, label);
    assert.equal(result.targetTopology, 'single', label);
    assert.equal(result.targetWorkers, 0);
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
  assert.equal(delegating.incoherent, null);
});

test('a Single plan that contradicts "insufficient" is accepted as a valid but incoherent answer, not rejected', async () => {
  const exchanges: Array<{ error: string | null }> = [];
  const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture' }, {
    onExchange: exchange => exchanges.push(exchange),
    fetchImpl: async (_url, init) => Response.json(contradictoryJevAnswer(jevTopologyResponse(String(init?.body), 'brain_multi_room', 2, 0.99))),
  });
  assert.equal(result.providerStatus, 'ok');
  assert.equal(result.incoherent, 'plan_vs_sufficiency');
  assert.equal(result.reason, 'incoherent_plan_vs_sufficiency');
  assert.equal(result.error, null); assert.equal(exchanges[0]!.error, null);
  assert.equal(result.targetTopology, 'single'); assert.equal(result.targetWorkers, 0);
  // Jev's own (high) confidence is kept for transparency; routing treats the answer as uncertain regardless.
  assert.equal(result.confidence, 0.99);
  assert.equal(result.singleSufficient, false);
  // With no usable worker, Single is the only feasible plan: "insufficient" is then coherent.
  const alone = await evaluateAdaptiveTopology(snapshot(0), { apiKey: 'unit-fixture' }, {
    fetchImpl: async (_url, init) => Response.json(contradictoryJevAnswer(jevTopologyResponse(String(init?.body), 'single', 0))),
  });
  assert.equal(alone.providerStatus, 'ok'); assert.equal(alone.incoherent, null);
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
    assert.equal(result.providerStatus, 'unavailable'); assert.equal(result.targetWorkers, 0);
    assert.equal(result.error, code); assert.equal(result.model, null); assert.equal(result.inputTokens, null);
    assert.equal(result.reason, 'provider_unavailable');
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
  const failed = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { fetchImpl: async () => { throw new Error('secret-fixture'); } });
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
