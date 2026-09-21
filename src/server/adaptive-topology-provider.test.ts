import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { evaluateAdaptiveTopology, topologyQuestions, MAX_CLASSIFIER_WORKERS, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
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

test('offered topology/budget choices represent actual capacity, including zero capacity and orchestrated-only mode', () => {
  for (const usable of [0, 1, 2, 3, 300]) for (const only of [false, true]) {
    const { topologies, budgets, questions } = topologyQuestions(snapshot(usable, only));
    assert.equal('single' in topologies, !only || usable === 0);
    assert.equal('brain_one_worker' in topologies, usable >= 1);
    assert.equal('brain_multi_room' in topologies, usable >= 2);
    assert.equal(budgets === null, usable === 0);
    if (budgets) { assert.equal(Object.keys(budgets).length, Math.min(usable, MAX_CLASSIFIER_WORKERS) + 1); assert.ok(!('workers_301' in budgets)); }
    assert.equal(Object.keys(questions).length, usable ? 8 : 7);
  }
  assert.throws(() => topologyQuestions(snapshot(-1)));
  assert.throws(() => topologyQuestions(snapshot(1.5)));
});

test('all valid provider topology choices preserve worker count and account for usage', async () => {
  for (const [usable, only, target, workers] of [
    [0, false, 'capacity_blocked', 0], [0, false, 'single', 0],
    [1, false, 'brain_one_worker', 1], [1, true, 'capacity_blocked', 0],
    [3, false, 'brain_multi_dm', 3], [3, true, 'brain_multi_room', 2],
  ] as const) {
    const input = snapshot(usable, only);
    const result = await evaluateAdaptiveTopology(input, { apiKey: 'unit-fixture' }, {
      fetchImpl: async (_url, init) => {
        assert.equal(init?.redirect, 'error');
        assert.ok(String(init?.body).includes('Complete this phase.'));
        return Response.json(jevTopologyResponse(String(init?.body), target, workers));
      },
    });
    assert.equal(result.providerStatus, 'ok', `${target}: ${result.reason}`);
    assert.equal(result.targetWorkers, workers);
    assert.equal(result.inputTokens, 80);
    assert.equal(result.outputTokens, 20);
  }
});

test('malformed or inconsistent provider replies preserve current mode without leaking raw errors', async () => {
  const mutations: Array<[string, (payload: any) => unknown]> = [
    ['null envelope', () => null], ['array envelope', () => []], ['missing model', p => ({ ...p, model: null })],
    ['oversize model', p => ({ ...p, model: 'x'.repeat(201) })], ['missing usage', p => ({ ...p, usage: undefined })],
    ['negative usage', p => ({ ...p, usage: { input_tokens: -1, output_tokens: 0 } })],
    ['bad output usage', p => ({ ...p, usage: { input_tokens: 1, output_tokens: 1.5 } })],
    ['missing answers', p => ({ ...p, answers: undefined })],
    ['missing confidence', p => { delete p.answers.target_topology.confidence; return p; }],
    ['negative confidence', p => { p.answers.target_topology.confidence = -1; return p; }],
    ['bad type', p => { p.answers.complexity.type = 'choice'; return p; }],
    ['bad score', p => { p.answers.complexity.score = 3; return p; }],
    ['missing distribution', p => { p.answers.coupling.probabilities = null; return p; }],
    ['unknown option', p => { p.answers.target_topology.choice = 'made_up'; return p; }],
    ['invented capacity', p => { p.answers.worker_budget.choice = 'workers_4'; return p; }],
    ['wrong distribution keys', p => { p.answers.target_topology.probabilities = { x: 0.5, y: 0.5 }; return p; }],
    ['probability negative', p => { p.answers.complexity.probabilities['0'] = -1; return p; }],
    ['probability sum', p => { p.answers.complexity.probabilities = { '0': 1, '1': 1, '2': 1 }; return p; }],
    ['choice not maximum', p => { p.answers.target_topology.choice = 'brain_multi_dm'; return p; }],
    ['mode/budget mismatch', p => { p.answers.target_topology.choice = 'single'; p.answers.worker_budget = {
      ...p.answers.worker_budget, choice: 'workers_2', probabilities: { workers_0: 0.01, workers_1: 0.01, workers_2: 0.97, workers_3: 0.01 },
    }; return p; }],
    ['contradictory sufficiency', p => { p.answers.single_agent_sufficiency = { type: 'choice', choice: 'insufficient', confidence: 0.99,
      probabilities: { insufficient: 0.99, sufficient: 0.01 } }; return p; }],
  ];
  for (const [label, mutate] of mutations) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'never-log-secret' }, {
      fetchImpl: async (_url, init) => Response.json(mutate(jevTopologyResponse(String(init?.body)))),
    });
    assert.equal(result.providerStatus, 'unavailable', label);
    assert.equal(result.targetTopology, 'brain_multi_room', label);
    assert.equal(result.targetWorkers, 2);
    assert.doesNotMatch(JSON.stringify(result), /never-log-secret|made_up/);
  }
});

test('HTTP errors, empty bodies, malformed JSON, size budgets and request failures are bounded fallbacks', async () => {
  const transports: Array<() => Response> = [
    () => new Response('private diagnostic', { status: 401 }),
    () => new Response(null), () => new Response('{'),
    () => new Response('x'.repeat(128 * 1024 + 1)),
  ];
  for (const transport of transports) {
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { fetchImpl: async () => transport() });
    assert.equal(result.providerStatus, 'unavailable'); assert.equal(result.targetWorkers, 2);
  }
  for (const timeoutMs of [0, -1, 10_001, 1.5]) {
    let called = false;
    const result = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { timeoutMs, fetchImpl: async () => { called = true; throw new Error('must not call'); } });
    assert.equal(called, false); assert.equal(result.providerStatus, 'unavailable');
  }
  const big = snapshot(); big.request = 'x'.repeat(64 * 1024);
  let called = false;
  const tooBig = await evaluateAdaptiveTopology(big, { apiKey: 'fixture-key' }, { fetchImpl: async () => { called = true; throw new Error('must not call'); } });
  assert.equal(called, false); assert.equal(tooBig.providerStatus, 'unavailable');
  const initial = snapshot(); initial.current = null;
  const failed = await evaluateAdaptiveTopology(initial, { apiKey: 'fixture-key' }, { fetchImpl: async () => { throw new Error('secret-fixture'); } });
  assert.equal(failed.targetTopology, 'single'); assert.equal(failed.targetWorkers, 0); assert.doesNotMatch(JSON.stringify(failed), /secret-fixture/);
});

test('timeout and shutdown cancellation interrupt the in-flight provider call', async () => {
  const waiting: typeof fetch = async (_url, init) => {
    await delay(1000, undefined, { signal: init?.signal ?? undefined });
    throw new Error('Should have aborted');
  };
  const timeout = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { timeoutMs: 1, fetchImpl: waiting });
  assert.equal(timeout.providerStatus, 'unavailable'); assert.match(timeout.reason, /timeout/);
  const controller = new AbortController(); controller.abort();
  const stopped = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'fixture-key' }, { signal: controller.signal, fetchImpl: waiting });
  assert.equal(stopped.providerStatus, 'unavailable');
});
