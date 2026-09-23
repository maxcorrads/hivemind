import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as policy from './adaptive-topology-policy.ts';
import { minimumTopologyWorkers, parseTopologyPlan, topologyPlanId, validTopologyTarget } from './adaptive-topology-policy.ts';

test('joint plan ids round-trip and never repair an invalid id', () => {
  for (const target of [{ topology: 'single', workers: 0 }, { topology: 'brain_one_worker', workers: 1 },
    { topology: 'brain_multi_dm', workers: 2 }, { topology: 'brain_multi_room', workers: 8 }] as const)
    assert.deepEqual(parseTopologyPlan(topologyPlanId(target)), target);
  assert.equal(parseTopologyPlan('capacity_blocked'), 'capacity_blocked');
  for (const id of ['brain_multi_dm_1', 'brain_multi_dm_0', 'brain_multi_dm_02', 'brain_multi_room', 'single_0', 'orchestrated'])
    assert.equal(parseTopologyPlan(id), null, id);
});

test('a plan is valid only with the worker count its topology implies and the capacity allows', () => {
  assert.ok(validTopologyTarget({ topology: 'single', workers: 0 }, 0));
  assert.ok(!validTopologyTarget({ topology: 'single', workers: 1 }, 3));
  assert.ok(validTopologyTarget({ topology: 'brain_one_worker', workers: 1 }, 1));
  assert.ok(!validTopologyTarget({ topology: 'brain_one_worker', workers: 1 }, 0));
  assert.ok(validTopologyTarget({ topology: 'brain_multi_dm', workers: 2 }, 2));
  assert.ok(!validTopologyTarget({ topology: 'brain_multi_room', workers: 3 }, 2));
  assert.ok(!validTopologyTarget({ topology: 'brain_multi_dm', workers: 2.5 }, 5));
  assert.deepEqual(['single', 'brain_one_worker', 'brain_multi_dm', 'brain_multi_room'].map(t => minimumTopologyWorkers(t as never)), [0, 1, 2, 2]);
});

test('no enforcement policy survives: advisory evidence is versioned apart from the enforced policy (#211)', () => {
  assert.equal(policy.TOPOLOGY_POLICY_VERSION, 'topology-advisory-v1');
  for (const removed of ['advanceTopologyPolicy', 'initialTopologyPolicy', 'topologyCheckpointSafe', 'topologyIsEscalation', 'TOPOLOGY_COOLDOWN_EVENTS'])
    assert.equal(removed in policy, false, removed);
});
