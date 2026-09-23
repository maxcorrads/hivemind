import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Hive } from '../src/server/hive.ts';
import { loadFixtures } from './benchmark-coordination.mjs';
import type { Agent } from '../src/shared/types.ts';
import type { TaskAction, TaskSnapshot } from '../src/shared/tasks.ts';
import { countRows } from '../src/server/test-fixtures.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = new Map(loadFixtures(root).map(fixture => [fixture.id, fixture]));

function runtime(t: TestContext, workers = 3) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-coordination-benchmark-'));
  const hive = new Hive(path.join(dir, 'hive.db')); let serial = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent('human'), brain = hive.join({ role: 'brain' }).agent;
  const pool = Array.from({ length: workers }, () => hive.join({ role: 'worker', seniority: 'mid' }).agent);
  const next = (prefix: string) => `${prefix}-${++serial}`;
  const event = (task: TaskSnapshot, actor: Agent, action: TaskAction) => hive.tasks.event(actor, task.id,
    { requestId: next('event'), expectedRevision: hive.tasks.get(actor, task.id).revision, action });
  const result = { summary: 'Deterministic fake-agent result', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] };
  const complete = (task: TaskSnapshot, worker: Agent, decision: 'accepted' | 'changes_requested' = 'accepted') => {
    event(task, worker, { type: 'accept' });
    event(task, worker, { type: 'result', result });
    return event(task, brain, { type: 'review', decision, summary: 'Deterministic benchmark review', evidenceSeqs: [] }).task;
  };
  return { hive, human, brain, pool, next, event, result, complete };
}

function contract(objective: string, scope: string[], dependencies: string[] = []) {
  return { objective, scope, nonGoals: ['No external writes'], acceptanceCriteria: ['Reviewed deterministic result'], dependencies, evidenceSeqs: [] };
}

test('benchmark recovery fixture traverses real task, checkpoint, handoff and retry primitives', t => {
  const fixture = fixtures.get('blocked-worker-recovery')!; assert.ok(fixture);
  const f = runtime(t, 1), worker = f.pool[0]!;
  const assignedInput = { requestId: 'stable-assignment', worker: worker.name,
    contract: contract(`Benchmark ${fixture.id}`, fixture.tasks[0]!.scope) };
  const created = f.hive.tasks.assign(f.brain, assignedInput);
  const replay = f.hive.tasks.assign(f.brain, assignedInput);
  assert.equal(replay.duplicate, true); assert.equal(replay.message.id, created.message.id);
  let task = created.task;
  f.event(task, worker, { type: 'accept' });
  f.event(task, worker, { type: 'checkpoint', checkpoint: { completedSteps: ['Reproduced deterministic fixture'], unresolvedQuestions: [],
    nextAction: 'Resume after coordinator decision', artifacts: [], checks: [], evidenceSeqs: [] } });
  assert.equal(f.hive.tasks.handoff(f.brain, task.id).freshness, 'current');
  f.event(task, worker, { type: 'block', needed: 'Deterministic coordinator decision' });
  const current = f.hive.tasks.get(f.brain, task.id);
  f.hive.postMessage(f.brain, { channel: current.channelId, threadId: task.id, body: 'Deterministic decision supplied.' });
  f.event(task, worker, { type: 'accept' });
  f.event(task, worker, { type: 'result', result: f.result });
  task = f.event(task, f.brain, { type: 'review', decision: 'accepted', summary: 'Reviewed recovery evidence', evidenceSeqs: [] }).task;
  assert.equal(task.state, 'accepted_complete');
  assert.ok(f.hive.tasks.handoff(worker, task.id).checkpoint);
});

test('benchmark coupled fixture traverses real room, dependencies and advisory claim overlap', t => {
  const fixture = fixtures.get('shared-interface-coupled')!; assert.ok(fixture);
  const f = runtime(t, 3);
  const room = f.hive.createChannel(f.brain, { name: 'benchmark-coupled', type: 'private', memberNames: f.pool.map(worker => worker.name) });
  const configured = f.hive.rooms.event(f.human, room.id, { requestId: f.next('room'), expectedRevision: 0,
    action: { type: 'configure', reason: 'Benchmark fixture', contract: { mode: 'ongoing', purpose: fixture.description,
      rules: ['Deterministic fake agents only'], limits: ['No external writes'], coordinator: f.brain.name,
      participants: f.pool.map((worker, index) => ({ name: worker.name, boundary: `fixture-${index}` })), completion: ['Harness finishes'], originTaskId: null } } });
  const roomVersion = configured.room!.contractVersion;
  for (const worker of f.pool) f.hive.rooms.event(worker, room.id, { requestId: f.next('ack'), expectedRevision: f.hive.rooms.peek(room.id)!.revision,
    action: { type: 'acknowledge', contractVersion: roomVersion } });

  const first = f.hive.tasks.assign(f.brain, { requestId: f.next('assign'), channel: room.id, worker: f.pool[0]!.name,
    room: { contractVersion: roomVersion, actionKey: 'coupled-a' }, contract: contract('Coupled A', ['src/shared']) }).task;
  const second = f.hive.tasks.assign(f.brain, { requestId: f.next('assign'), channel: room.id, worker: f.pool[1]!.name,
    room: { contractVersion: roomVersion, actionKey: 'coupled-b' }, contract: contract('Coupled B', ['src/shared/api']) }).task;
  f.event(first, f.brain, { type: 'claim', leaseSeconds: 60, paths: ['src/shared'], overlapAcknowledgements: [] });
  const preview = f.hive.tasks.previewClaim(f.brain, second.id, { paths: ['src/shared/api'] });
  assert.equal(preview.overlaps[0]?.taskId, first.id);
  f.event(second, f.brain, { type: 'claim', leaseSeconds: 60, paths: ['src/shared/api'],
    overlapAcknowledgements: preview.overlaps.map(item => ({ taskId: item.taskId, claimVersion: item.claimVersion })) });
  f.complete(first, f.pool[0]!); f.complete(second, f.pool[1]!);

  const dependent = f.hive.tasks.assign(f.brain, { requestId: f.next('assign'), channel: room.id, worker: f.pool[2]!.name,
    room: { contractVersion: roomVersion, actionKey: 'coupled-dependent' }, contract: contract('Dependent verification', ['tests/shared'], [first.id, second.id]) }).task;
  assert.deepEqual(f.hive.tasks.get(f.pool[2]!, dependent.id).coordination!.dependencies.map(item => item.status), ['accepted_complete', 'accepted_complete']);
  assert.equal(f.complete(dependent, f.pool[2]!).state, 'accepted_complete');
  assert.ok(countRows(f.hive, 'room_events') >= 4);
});

test('benchmark room fixture traverses real capability routing and keeps provider cost unknown', t => {
  const fixture = fixtures.get('room-peer-clarification')!; assert.ok(fixture);
  const f = runtime(t, 3);
  for (let index = 0; index < f.pool.length; index++) {
    const worker = f.pool[index]!, spec = fixture.workers[index]!;
    f.hive.routing.set(worker, { expectedRevision: 0, card: { enabled: true, capabilities: spec.capabilities,
      modes: ['implementation', 'review'], model: fixture.modelVersion, host: 'benchmark', availableContext: 128000,
      availability: 'available', maxInProgress: 8 } });
  }
  const room = f.hive.createChannel(f.brain, { name: 'benchmark-routing', type: 'private', memberNames: f.pool.map(worker => worker.name) });
  const task = f.hive.tasks.assign(f.brain, { requestId: f.next('assign'), channel: room.id, worker: f.pool[0]!.name,
    contract: contract('Route deterministic API work', ['src/api']) }).task;
  const suggestions = f.hive.routing.suggest(f.brain, task.id, { requiredCapabilities: ['api'], mode: 'implementation', category: 'coordination-benchmark' });
  assert.ok(suggestions.candidates.length > 0);
  assert.ok(suggestions.candidates.every(candidate => candidate.providerCost === null));
  assert.equal(countRows(f.hive, 'worker_capabilities'), 3);
});
