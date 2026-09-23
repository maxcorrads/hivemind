import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { AdaptiveCoordinationEvent } from './adaptive-topology.ts';
import { countRows } from './test-fixtures.ts';

function choice(selected: string, options: string[], confidence: number) {
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  return { type: 'choice', choice: selected, confidence,
    probabilities: Object.fromEntries(options.map(option => [option, option === selected ? confidence : rest])) };
}

function payload(topology: AdaptiveTopology, confidence = 0.95, workers = 2) {
  const single = topology === 'single';
  const score = (value: number) => ({ type: 'score', score: value, confidence,
    probabilities: { '0': value < 1 ? 0.9 : 0.05, '1': 0.05, '2': value < 1 ? 0.05 : 0.9 } });
  const budget = single ? 0 : topology === 'brain_one_worker' ? 1 : workers;
  return {
    model: 'jev-regression-fixture', usage: { input_tokens: 64, output_tokens: 24 },
    answers: {
      single_agent_sufficiency: choice(single ? 'sufficient' : 'insufficient', ['sufficient', 'insufficient'], confidence),
      complexity: score(single ? 0.2 : 1.8), parallelizability: score(single ? 0.2 : 1.8),
      coupling: score(topology === 'brain_multi_room' ? 1.8 : 0.2),
      specialization_need: score(single ? 0.2 : 1.8), coordination_need: score(single ? 0.2 : 1.8),
      target_topology: choice(topology, ['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'], confidence),
      worker_budget: choice(`workers_${budget}`, ['workers_0', 'workers_1', 'workers_2'], confidence),
    },
  };
}

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-regression-'));
  const hive = new Hive(path.join(home, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' });
  const workers = [0, 1].map(() => hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const dm = hive.openDm(human, brain.agent.name);
  const app = createApp(hive);
  let next = payload('single');
  let unavailable = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    calls++;
    if (unavailable) throw new Error('fixture offline');
    return Response.json(next);
  });
  saveAdaptiveRouting(home, { enabled: true, apiKey: 'fixture-not-a-live-key' });
  t.after(() => {
    hive.bus.removeAllListeners();
    hive.db.close();
    rmSync(home, { recursive: true, force: true });
  });
  let eventNumber = 0;
  const event = (kind: AdaptiveCoordinationEvent['kind'] = 'brain_message'): AdaptiveCoordinationEvent => ({
    kind, actorId: brain.agent.id, actorRole: 'brain', channelId: dm.id,
    summary: `coordination checkpoint ${++eventNumber}`,
  });
  const choose = (topology: AdaptiveTopology, confidence = 0.95) => { next = payload(topology, confidence); };
  const start = async (mode = 'auto', scope = 'none') => {
    const result = await hive.adaptiveTopology.routeHumanRequest(human,
      { channel: dm.id, body: 'Complete the bounded request.', requestId: `request-${eventNumber++}` }, mode, scope);
    assert.ok(result);
    return result;
  };
  return { hive, home, human, brain, workers, dm, app, event, choose, start,
    view: () => hive.adaptiveTopology.view(human, dm.id),
    recheck: () => hive.adaptiveTopology.revalidateForActor(brain.agent, event()),
    offline: (value: boolean) => { unavailable = value; }, calls: () => calls };
}

test('the first high-confidence escalation can jump directly from Single to Room', async t => {
  const f = fixture(t);
  await f.start();
  f.choose('brain_multi_room');
  const result = await f.hive.adaptiveTopology.beforeBrainAction(f.brain.agent, {
    ...f.event('delegation_attempt'), usesRoom: true, workerName: f.workers[0]!.agent.name, executionId: f.view().state!.executionId,
  });
  assert.equal(result?.currentTopology, 'brain_multi_room');
  assert.equal(result?.workerBudget, 2);
});

test('Room to Single needs two independently high-confidence confirmations, not a medium then high pair', async t => {
  const f = fixture(t);
  f.choose('brain_multi_room');
  await f.start();
  // Two unrelated retained-topology events remove any preceding transition cooldown.
  await f.recheck(); await f.recheck();
  f.choose('single', 0.70);
  await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  f.choose('single', 0.90);
  await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room', 'one high confirmation is not two');
  await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'single');
});

test('very low confidence never becomes permission to de-escalate merely by repetition', async t => {
  const f = fixture(t);
  f.choose('brain_multi_room'); await f.start();
  f.choose('single', 0.20);
  for (let i = 0; i < 6; i++) await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
});

test('one-request explicit Single remains authoritative while Jev recommends Room', async t => {
  const f = fixture(t);
  f.choose('brain_multi_room');
  const original = await f.start('single', 'none');
  for (let i = 0; i < 5; i++) await f.recheck();
  assert.equal(f.view().state?.executionId, original.state.executionId);
  assert.equal(f.view().state?.currentTopology, 'single');
  assert.equal(f.view().state?.recommendation?.targetTopology, 'brain_multi_room');
  assert.ok(f.calls() >= 6, 'Human override does not disable monitoring');
});

test('provider failure keeps the mode and warning; successful evaluation clears the warning', async t => {
  const f = fixture(t);
  f.choose('brain_multi_room'); await f.start();
  f.offline(true); await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  assert.match(f.view().state?.warning ?? '', /unavailable/i);
  f.offline(false); await f.recheck();
  assert.equal(f.view().state?.warning, null);
});

test('every revalidation is Human-visible without becoming an agent message or inbox item', async t => {
  const f = fixture(t);
  await f.start();
  const count = () => countRows(f.hive, 'messages');
  const beforeMessages = count();
  const beforeEvents = f.view().events.length;
  await f.recheck(); await f.recheck();
  assert.equal(count(), beforeMessages);
  assert.equal(f.view().events.length, beforeEvents + 2);
  assert.throws(() => f.hive.adaptiveTopology.view(f.brain.agent, f.dm.id), /Human-only/);
});

test('agent HTTP responses expose applied policy, not the Human evaluation history', async t => {
  const f = fixture(t);
  await f.start();
  const response = await f.app.request(`/api/agent/channels/${f.dm.id}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${f.brain.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Local implementation complete.', requestId: 'public-policy-only' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /recommendation|confirmationTopology|confirmationWorkers|providerAvailable/);
  assert.doesNotMatch(text, /jev-regression-fixture|inputTokens|outputTokens|singleSufficient/);
});

test('disabling Jev releases automatic routing enforcement instead of freezing Single forever', async t => {
  const f = fixture(t);
  await f.start();
  saveAdaptiveRouting(f.home, { enabled: false });
  const before = f.calls();
  await f.hive.adaptiveTopology.beforeBrainAction(f.brain.agent, {
    ...f.event('delegation_attempt'), usesRoom: false, workerName: f.workers[0]!.agent.name,
  });
  assert.equal(f.calls(), before);
});
