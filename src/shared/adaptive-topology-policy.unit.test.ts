import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTIVE_TOPOLOGIES } from './adaptive-topology.ts';
import {
  advanceTopologyPolicy, initialTopologyPolicy, minimumTopologyWorkers, topologyIsEscalation,
  type TopologyTarget, type TopologySafety, type TopologyPolicyState,
} from './adaptive-topology-policy.ts';

const safe: TopologySafety = {
  usableWorkers: 4, activeWorkers: 0, activeTasks: 0,
  openBlockers: 0, openDependencies: 0, unreconciledClaims: 0,
};
const single: TopologyTarget = { topology: 'single', workers: 0 };
const room: TopologyTarget = { topology: 'brain_multi_room', workers: 2 };
function step(state: TopologyPolicyState, target: TopologyTarget, confidence = 0.90, safety = safe) {
  return advanceTopologyPolicy(state, { target, confidence, available: true }, safety);
}

test('an incoherent answer is never a vote for a change, whatever confidence Jev reported (#209)', () => {
  let state = initialTopologyPolicy(room);
  for (let i = 0; i < 4; i++) {
    const result = advanceTopologyPolicy(state, { target: single, confidence: 0.99, available: true, incoherent: true }, safe);
    assert.equal(result.cause, 'low_confidence');
    assert.equal(result.changed, false);
    assert.equal(result.confirmation.count, 0);
    state = result;
  }
  assert.equal(state.applied.topology, 'brain_multi_room');
  // A coherent answer resumes the ordinary confirmation rules.
  assert.equal(step(step(state, single, 0.95), single, 0.95).applied.topology, 'single');
});

test('every topology can jump directly to every other topology without intermediate states', () => {
  for (const source of ADAPTIVE_TOPOLOGIES) for (const destination of ADAPTIVE_TOPOLOGIES) {
    if (source === destination) continue;
    const from = { topology: source, workers: minimumTopologyWorkers(source) };
    const to = { topology: destination, workers: minimumTopologyWorkers(destination) };
    let state = initialTopologyPolicy(from);
    const needed = topologyIsEscalation(from, to) ? 1 : 2;
    for (let i = 0; i < needed; i++) {
      const result = step(state, to);
      assert.equal(result.applied.topology, i === needed - 1 ? destination : source, `${source} -> ${destination}`);
      state = result;
    }
  }
});

test('Single uses two high confirmations or three medium confirmations with an inclusive 0.90 threshold', () => {
  for (const confidence of [0.90, 0.95, 1]) {
    const first = step(initialTopologyPolicy(room), single, confidence);
    assert.equal(first.changed, false);
    assert.equal(step(first, single, confidence).applied.topology, 'single');
  }
  for (const confidence of [0.60, 0.70, 0.899999]) {
    const first = step(initialTopologyPolicy(room), single, confidence);
    const second = step(first, single, confidence);
    assert.equal(second.changed, false);
    assert.equal(step(second, single, confidence).applied.topology, 'single');
  }
});

test('a medium then high pair is not two consecutive high-confidence confirmations', () => {
  const first = step(initialTopologyPolicy(room), single, 0.70);
  const second = step(first, single, 0.90);
  assert.equal(second.changed, false);
  assert.equal(second.confirmation.highCount, 1);
  assert.equal(step(second, single, 0.90).changed, true);
});

test('uncertain output never changes topology regardless of how many repetitions occur', () => {
  let state = initialTopologyPolicy(room);
  for (let i = 0; i < 50; i++) {
    const result = step(state, single, 0.59);
    assert.equal(result.cause, 'low_confidence');
    assert.deepEqual(result.applied, room);
    assert.equal(result.confirmation.count, 0);
    state = result;
  }
});

test('a changed recommendation resets a Single streak', () => {
  const first = step(initialTopologyPolicy(room), single);
  const reversed = step(first, room);
  const next = step(reversed, single);
  assert.equal(next.changed, false);
  assert.equal(next.confirmation.count, 1);
});

test('cooldown counts two new events, without delaying the initial high-confidence escalation', () => {
  const first = step(initialTopologyPolicy(single), room);
  assert.equal(first.changed, true);
  const target = { topology: 'brain_multi_dm' as const, workers: 2 };
  const second = step(first, target);
  assert.equal(second.changed, false);
  const third = step(second, target);
  assert.equal(third.changed, true);
  assert.deepEqual(third.applied, target);
});

test('de-escalation waits for tasks, claims, blockers and dependencies to reconcile', () => {
  for (const dirty of [
    { activeWorkers: 1, activeTasks: 1 }, { activeTasks: 1 }, { openBlockers: 1 },
    { openDependencies: 1 }, { unreconciledClaims: 1 },
  ]) {
    const safety = { ...safe, ...dirty };
    const first = step(initialTopologyPolicy(room), single, 0.95, safety);
    const pending = step(first, single, 0.95, safety);
    assert.equal(pending.cause, 'safe_checkpoint_pending');
    assert.deepEqual(pending.applied, room);
    assert.deepEqual(pending.pending, single);
    const settled = step(pending, single, 0.95);
    assert.equal(settled.changed, true);
    assert.deepEqual(settled.applied, single);
  }
});

test('provider failure retains topology and pending drain but cannot complete that transition', () => {
  const busy = { ...safe, activeWorkers: 1, activeTasks: 1 };
  const first = step(initialTopologyPolicy(room), single, 0.95, busy);
  const pending = step(first, single, 0.95, busy);
  const failed = advanceTopologyPolicy(pending, { target: single, confidence: null, available: false }, safe);
  assert.equal(failed.cause, 'provider_unavailable');
  assert.deepEqual(failed.applied, room);
  assert.deepEqual(failed.pending, single);
  assert.equal(failed.confirmation.count, 0);
});

test('explicit Human overrides remain authoritative regardless of Jev recommendation', () => {
  let state = initialTopologyPolicy(single);
  for (let i = 0; i < 10; i++) {
    const result = advanceTopologyPolicy(state, { target: room, confidence: 0.99, available: true }, safe, single);
    assert.equal(result.cause, 'human_override');
    assert.deepEqual(result.applied, single);
    state = result;
  }
});

test('stale or invalid worker budgets never silently clamp into an executable topology', () => {
  for (const target of [
    { topology: 'single', workers: 1 }, { topology: 'brain_one_worker', workers: 2 },
    { topology: 'brain_multi_dm', workers: 1 }, { topology: 'brain_multi_room', workers: 5 },
  ] as TopologyTarget[]) {
    const result = step(initialTopologyPolicy(single), target);
    assert.equal(result.cause, 'capacity_changed');
    assert.deepEqual(result.applied, single);
  }
});
