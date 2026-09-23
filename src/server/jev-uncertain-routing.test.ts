import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { saveAdaptiveRouting, TYPESAFE_ENDPOINT } from './adaptive-config.ts';
import { exportAdaptiveEvidence } from './adaptive-evidence.ts';
import { contradictoryJevAnswer, jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';

/** How the fake TypeSafe provider answers the next call. Never a live API call. */
type Reply =
  | { kind: 'answer'; topology: AdaptiveTopology; workers?: number; confidence?: number }
  | { kind: 'incoherent'; confidence?: number }
  | { kind: 'not_offered' }
  | { kind: 'http'; status: number }
  | { kind: 'timeout' };

function runtime(t: TestContext, workers = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-uncertain-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' }).agent;
  for (let index = 0; index < workers; index++) hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.channels.openDm(human, brain.name);
  let reply: Reply = { kind: 'answer', topology: 'single' }, serial = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), TYPESAFE_ENDPOINT);
    const body = JSON.parse(String(init?.body)) as unknown;
    const resolved = { model: 'jev-1.13.0' };
    switch (reply.kind) {
      case 'answer': return Response.json({ ...jevTopologyResponse(body, reply.topology, reply.workers, reply.confidence), ...resolved });
      case 'incoherent': return Response.json({ ...contradictoryJevAnswer(jevTopologyResponse(body, 'brain_one_worker', 1, reply.confidence ?? 0.99), reply.confidence ?? 0.99), ...resolved });
      case 'not_offered': {
        const payload = jevTopologyResponse(body, 'brain_one_worker', 1) as unknown as { answers: { plan: { choice: string } } };
        payload.answers.plan.choice = 'brain_multi_dm_9';
        return Response.json({ ...payload, ...resolved });
      }
      case 'http': return Response.json({ error: { message: 'private provider detail' } }, { status: reply.status });
      case 'timeout': throw new DOMException('deadline', 'TimeoutError');
    }
  });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  return {
    hive, dm,
    reply: (next: Reply) => { reply = next; },
    start: async () => {
      const routed = await hive.adaptiveTopology.routeHumanRequest(human,
        { channel: dm.id, body: 'Una volta terminati questi passaggi quale è il piano?', requestId: `request-${++serial}` }, 'auto', 'none');
      assert.ok(routed); return routed;
    },
    recheck: () => hive.adaptiveTopology.revalidateForActor(brain, {
      actorId: brain.id, actorRole: 'brain', kind: 'brain_message', channelId: dm.id, eventId: `event-${++serial}` }),
    view: () => hive.adaptiveTopology.view(human, dm.id),
    calls: () => hive.adaptiveTopology.observations.jevCalls.view(dm.projectId).requests.flatMap(group => group.calls),
  };
}

test('initial routing labels an incoherent answer as uncertain, never as unavailable, and uses the fallback', async t => {
  const f = runtime(t);
  f.reply({ kind: 'incoherent' });
  const routed = await f.start();
  const state = f.view().state!;
  assert.equal(state.currentTopology, 'brain_one_worker', 'configured topology fallback');
  assert.equal(state.workerBudget, 1);
  assert.equal(state.providerAvailable, true, 'Jev answered: it is not a provider failure');
  assert.equal(state.monitoring, 'active');
  assert.equal(state.warning, 'Jev uncertain (incoherent: plan contradicts sufficiency) · used fallback Brain + 1');
  assert.doesNotMatch(state.warning ?? '', /unavailable/);
  assert.equal(routed.routing.providerStatus, 'ok');
  assert.equal(routed.routing.incoherent, 'plan_vs_sufficiency');
  const event = f.view().events.at(-1)!;
  assert.equal(event.kind, 'warning'); assert.equal(event.incoherent, 'plan_vs_sufficiency'); assert.equal(event.providerStatus, 'ok');
  const [call] = f.calls();
  assert.equal(call!.status, 'ok'); assert.equal(call!.incoherent, 'plan_vs_sufficiency'); assert.equal(call!.error, null);
  assert.equal(call!.targetTopology, 'single');
  assert.equal(call!.outcome?.appliedTopology, 'brain_one_worker');
  const report = exportAdaptiveEvidence(f.hive.db, state.executionId);
  assert.equal(report.overhead.successfulAttempts, 1); assert.equal(report.overhead.unavailableAttempts, 0);
  assert.equal(report.overhead.uncertainAttempts, 1); assert.equal(report.overhead.incoherentAttempts, 1);
  assert.equal(report.attempts[0]!.status, 'ok'); assert.equal(report.attempts[0]!.certainty, 'incoherent');
});

test('initial routing names each reason Jev was not used: uncertain, rejected, unavailable', async t => {
  const cases: Array<[Reply, string, boolean, 'ok' | 'unavailable', 'confident' | 'uncertain' | null]> = [
    [{ kind: 'answer', topology: 'brain_multi_dm', workers: 2, confidence: 0.17 }, 'Jev uncertain (17%) · used fallback Brain + 1', true, 'ok', 'uncertain'],
    [{ kind: 'not_offered' }, 'Jev answer rejected (plan_not_offered) · used fallback Brain + 1', false, 'unavailable', null],
    [{ kind: 'http', status: 503 }, 'Jev unavailable (http_503) · used fallback Brain + 1', false, 'unavailable', null],
    [{ kind: 'timeout' }, 'Jev unavailable (timeout) · used fallback Brain + 1', false, 'unavailable', null],
  ];
  for (const [reply, warning, available, status, certainty] of cases) {
    const f = runtime(t);
    f.reply(reply);
    await f.start();
    const state = f.view().state!;
    assert.equal(state.warning, warning, reply.kind);
    assert.equal(state.providerAvailable, available, reply.kind);
    assert.equal(state.currentTopology, 'brain_one_worker', reply.kind);
    assert.equal(f.calls()[0]!.status, status, reply.kind);
    const report = exportAdaptiveEvidence(f.hive.db, state.executionId);
    assert.equal(report.overhead.successfulAttempts, status === 'ok' ? 1 : 0, reply.kind);
    assert.equal(report.overhead.unavailableAttempts, status === 'ok' ? 0 : 1, reply.kind);
    assert.equal(report.overhead.uncertainAttempts, status === 'ok' ? 1 : 0, reply.kind);
    assert.equal(report.attempts[0]!.certainty, certainty, reply.kind);
    assert.doesNotMatch(JSON.stringify(f.view()), /private provider detail|fixture-key/);
  }
  // A confident answer is applied without any warning.
  const f = runtime(t);
  f.reply({ kind: 'answer', topology: 'brain_multi_dm', workers: 2 });
  await f.start();
  assert.equal(f.view().state?.warning, null);
  assert.equal(f.view().state?.currentTopology, 'brain_multi_dm');
  assert.equal(exportAdaptiveEvidence(f.hive.db, f.view().state!.executionId).attempts[0]!.certainty, 'confident');
});

test('continuous routing never applies an incoherent answer and keeps Jev available; failures are named precisely', async t => {
  const f = runtime(t);
  f.reply({ kind: 'answer', topology: 'brain_multi_room', workers: 2 });
  const routed = await f.start();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  // Three high-confidence Single answers would de-escalate (nothing is in flight); incoherent ones never do.
  f.reply({ kind: 'incoherent' });
  for (let index = 0; index < 4; index++) await f.recheck();
  let state = f.view().state!;
  assert.equal(state.currentTopology, 'brain_multi_room');
  assert.equal(state.desiredTopology, null);
  assert.equal(state.confirmations, 0, 'an incoherent answer is never a vote for a change');
  assert.equal(state.providerAvailable, true);
  assert.equal(state.warning, null);
  assert.equal(state.recommendation?.incoherent, 'plan_vs_sufficiency');
  assert.ok(f.view().events.slice(-4).every(event => event.kind === 'evaluation' && event.incoherent === 'plan_vs_sufficiency' && !event.applied));

  f.reply({ kind: 'not_offered' }); await f.recheck();
  state = f.view().state!;
  assert.equal(state.providerAvailable, false);
  assert.equal(state.warning, 'Jev answer rejected (plan_not_offered) · current mode kept, not revalidated');
  f.reply({ kind: 'http', status: 502 }); await f.recheck();
  assert.equal(f.view().state?.warning, 'Jev unavailable (http_502) · current mode kept, not revalidated');
  assert.equal(f.view().state?.monitoring, 'unavailable');
  f.reply({ kind: 'incoherent' }); await f.recheck();
  assert.equal(f.view().state?.providerAvailable, true, 'an answer, even an incoherent one, restores availability');
  assert.equal(f.view().state?.warning, null);

  // The same Single answer, coherent and confident, is applied: incoherence alone blocked the transition.
  f.reply({ kind: 'answer', topology: 'single' });
  for (let index = 0; index < 3; index++) await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'single');

  const report = exportAdaptiveEvidence(f.hive.db, routed.state.executionId);
  assert.equal(report.overhead.successfulAttempts, 1 + 5 + 3);
  assert.equal(report.overhead.unavailableAttempts, 2);
  assert.equal(report.overhead.incoherentAttempts, 5);
  assert.equal(report.overhead.uncertainAttempts, 5);
  const calls = f.calls();
  assert.equal(calls.filter(call => call.incoherent === 'plan_vs_sufficiency').length, 5);
  assert.ok(calls.filter(call => call.incoherent).every(call => call.status === 'ok' && call.error === null));
});
