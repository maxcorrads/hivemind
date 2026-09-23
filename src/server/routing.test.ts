import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { startServer } from './serve.ts';
import { HiveError } from '../shared/types.ts';
import { capabilityCardSchema, outcomeInterval, type CapabilityCard } from '../shared/routing.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import { addChannelMember, backdate, cloneAgent, failWrites } from './test-fixtures.ts';

const card: CapabilityCard = { enabled: true, capabilities: ['typescript', 'parser'], modes: ['implementation', 'review'],
  model: null, host: null, availableContext: 128000, availability: 'available', maxInProgress: 4 };
const query = { requiredCapabilities: ['typescript'], mode: 'implementation' as const, category: 'parser' };
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-routing-')), file = path.join(dir, 'hive.db');
  let hive = new Hive(file), serial = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.identity.join({ role: 'brain' }), other = hive.identity.join({ role: 'brain' });
  const workers = [0, 1, 2].map(() => hive.identity.join({ role: 'worker', seniority: 'mid' }));
  const room = hive.channels.createChannel(brain.agent, { name: 'routing', type: 'private', memberNames: [...workers.map(w => w.agent.name), other.agent.name] });
  const contract = { objective: 'Synthetic parser task', scope: [], nonGoals: [], acceptanceCriteria: ['Explicit review'], dependencies: [], evidenceSeqs: [] };
  const assign = (index = 0, channel = room.id) => hive.tasks.assign(brain.agent,
    { requestId: `a-${++serial}`, worker: workers[index]!.agent.name, channel, contract }).task;
  const complete = (task: TaskSnapshot, accepted = true) => {
    const worker = hive.identity.getAgent(task.workerId);
    hive.tasks.event(worker, task.id, { requestId: `e-${++serial}`, expectedRevision: task.revision, action: { type: 'accept' } });
    hive.tasks.event(worker, task.id, { requestId: `e-${++serial}`, expectedRevision: task.revision + 1,
      action: { type: 'result', result: { summary: 'Fixture result', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } } });
    return hive.tasks.event(brain.agent, task.id, { requestId: `e-${++serial}`, expectedRevision: task.revision + 2,
      action: { type: 'review', decision: accepted ? 'accepted' : 'changes_requested', summary: 'Explicit fixture review', evidenceSeqs: [] } }).task;
  };
  const set = (index: number, changes: Partial<CapabilityCard> = {}) => {
    const worker = workers[index]!.agent;
    return hive.routing.set(worker, { expectedRevision: hive.routing.get(worker, worker.id)?.revision ?? 0, card: { ...card, ...changes } });
  };
  return { get hive() { return hive; }, brain, other, workers, room, assign, complete, set,
    reopen() { hive.db.close(); hive = new Hive(file); } };
}
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

test('capability cards are worker opt-in, revision fenced, atomic and durable', t => {
  const f = fixture(t), worker = f.workers[0]!.agent;
  assert.equal(f.hive.routing.get(worker, worker.id), null);
  assert.throws(() => f.hive.routing.set(f.brain.agent, { expectedRevision: 0, card }), status(403));
  const first = f.set(0); assert.equal(first.revision, 1);
  assert.throws(() => f.hive.routing.set(worker, { expectedRevision: 0, card }), status(409));
  const restoreCards = failWrites(f.hive, 'worker_capabilities', { on: 'update', message: 'fixture write failure', persistent: true });
  assert.throws(() => f.set(0, { enabled: false }), /fixture write failure/);
  restoreCards();
  f.reopen(); assert.deepEqual(f.hive.routing.get(worker, worker.id), first);
  assert.equal(f.set(0, { enabled: false }).revision, 2);
  for (const bad of [{ ...card, modes: ['implementation', 'implementation'] }, { ...card, availableContext: NaN }, { ...card, capabilities: ['../x'] }, { ...card, maxInProgress: 0 }])
    assert.equal(capabilityCardSchema.safeParse(bad).success, false);
});

test('cold starts stay eligible, independent review and explicit context/quality filters fail closed', t => {
  const f = fixture(t), task = f.assign(); f.set(0); f.set(1, { availableContext: null }); f.set(2, { availability: 'unavailable' });
  const before = f.hive.tasks.get(f.brain.agent, task.id), suggestions = f.hive.routing.suggest(f.brain.agent, task.id, query);
  assert.equal(suggestions.candidates.length, 2);
  for (const item of suggestions.candidates) { assert.equal(item.providerCost, null); assert.equal(item.evidence.reviewed, 0); assert.match(item.reasons.join(' '), /Cold start/); }
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), before, 'suggestions may not mutate the task');
  assert.deepEqual(f.hive.routing.suggest(f.brain.agent, task.id, { ...query, mode: 'review' }).candidates.map(c => c.workerId), [f.workers[1]!.agent.id]);
  assert.equal(f.hive.routing.suggest(f.brain.agent, task.id, { ...query, minContext: 120000 }).candidates.length, 1);
  for (const extra of [{ minReviewedResults: 1 }, { minimumAcceptedRate: 0.5 }, { requiredCapabilities: ['rust'] }])
    assert.equal(f.hive.routing.suggest(f.brain.agent, task.id, { ...query, ...extra }).candidates.length, 0);
  assert.match(suggestions.delegationAdvice, /not delegating/);
});

test('routing never crosses project or private task boundaries', t => {
  const f = fixture(t), task = f.assign(); f.set(0); f.set(1);
  const human = f.hive.identity.getAgent('human'); f.hive.projects.createProject(human, { name: 'Other', slug: 'other' });
  const stranger = f.hive.identity.join({ role: 'brain', project: 'other' }), outsider = f.hive.identity.join({ role: 'worker', seniority: 'mid', project: 'chapter' });
  f.hive.routing.set(outsider.agent, { expectedRevision: 0, card });
  assert.throws(() => f.hive.routing.get(stranger.agent, f.workers[0]!.agent.id), status(403));
  assert.throws(() => f.hive.routing.suggest(stranger.agent, task.id, query), status(403));
  assert.throws(() => f.hive.routing.suggest(f.workers[0]!.agent, task.id, query), status(403));
  assert.throws(() => f.hive.routing.get(f.workers[0]!.agent, f.workers[1]!.agent.id), status(403));
  assert.equal(f.hive.routing.suggest(f.brain.agent, task.id, query).candidates.some(c => c.workerId === outsider.agent.id), false);
  const privateRoom = f.hive.channels.createChannel(f.brain.agent, { name: 'private-evidence', type: 'private', memberNames: [f.workers[0]!.agent.name] });
  const reviewed = f.complete(f.assign(0, privateRoom.id));
  f.hive.routing.recordOutcome(f.brain.agent, reviewed.id, { expectedRevision: reviewed.revision, category: 'parser', capabilityRevision: 1 });
  assert.equal(f.hive.routing.suggest(f.brain.agent, task.id, query).candidates.find(c => c.workerId === f.workers[0]!.agent.id)!.evidence.reviewed, 1);
  assert.equal(f.hive.routing.suggest(f.other.agent, task.id, query).candidates.find(c => c.workerId === f.workers[0]!.agent.id)!.evidence.reviewed, 0);
});

test('outcomes derive from actual reviews, count once, and do not mix model configurations or task categories', t => {
  const f = fixture(t); f.set(0); const task = f.assign();
  const input = { expectedRevision: 1, category: 'parser', capabilityRevision: 1 };
  assert.throws(() => f.hive.routing.recordOutcome(f.brain.agent, task.id, input), /review is required/);
  const done = f.complete(task); input.expectedRevision = done.revision;
  assert.throws(() => f.hive.routing.recordOutcome(f.other.agent, task.id, input), status(403));
  assert.equal(f.hive.routing.recordOutcome(f.brain.agent, task.id, input).duplicate, false);
  assert.equal(f.hive.routing.recordOutcome(f.brain.agent, task.id, input).duplicate, true);
  assert.throws(() => f.hive.routing.recordOutcome(f.brain.agent, task.id, { ...input, category: 'easy' }), status(409));
  const target = f.assign();
  let candidate = f.hive.routing.suggest(f.brain.agent, target.id, query).candidates[0]!;
  assert.equal(candidate.evidence.reviewed, 1); assert.equal(candidate.evidence.accepted, 1);
  assert.ok(candidate.evidence.interval95![0] < 0.5, 'one successful easy task is not proof of high general reliability');
  assert.equal(f.hive.routing.suggest(f.brain.agent, target.id, { ...query, category: 'other' }).candidates[0]!.evidence.reviewed, 0);
  f.reopen(); assert.equal(f.hive.routing.suggest(f.brain.agent, target.id, query).candidates[0]!.evidence.reviewed, 1);
  f.set(0, { model: 'different-declared-model' });
  candidate = f.hive.routing.suggest(f.brain.agent, target.id, query).candidates[0]!;
  assert.equal(candidate.evidence.reviewed, 0);
});

test('changed task revisions and expired observations cannot masquerade as current successful evidence', t => {
  const f = fixture(t); f.set(0); const done = f.complete(f.assign()), target = f.assign();
  f.hive.routing.recordOutcome(f.brain.agent, done.id, { expectedRevision: done.revision, category: 'parser', capabilityRevision: 1 });
  f.hive.tasks.event(f.brain.agent, done.id, { requestId: 'reopen-task', expectedRevision: done.revision,
    action: { type: 'revise', reason: 'New scope', worker: f.workers[0]!.agent.name, contract: done.contract } });
  assert.equal(f.hive.routing.suggest(f.brain.agent, target.id, query).candidates[0]!.evidence.reviewed, 0);
  const second = f.complete(f.assign());
  f.hive.routing.recordOutcome(f.brain.agent, second.id, { expectedRevision: second.revision, category: 'parser', capabilityRevision: 1 });
  backdate(f.hive, 'routing_outcomes', 'recorded_at');
  assert.equal(f.hive.routing.suggest(f.brain.agent, target.id, query).candidates[0]!.evidence.reviewed, 0);
});

test('visible workload and declared availability affect suggestions without changing workers', t => {
  const f = fixture(t), task = f.assign(); f.set(0, { maxInProgress: 1 }); f.set(1, { availability: 'busy' });
  const extra = f.assign();
  assert.equal(f.hive.routing.suggest(f.brain.agent, task.id, query).candidates.some(c => c.workerId === f.workers[0]!.agent.id), false);
  f.complete(extra);
  const list = f.hive.routing.suggest(f.brain.agent, task.id, query);
  assert.equal(list.candidates[0]!.workerId, f.workers[0]!.agent.id);
  assert.equal(list.candidates[0]!.workloadIncomplete, true);
  assert.equal(f.hive.routing.suggest(f.hive.identity.getAgent('human'), task.id, query).candidates[0]!.workloadIncomplete, false);
});

test('an explicit override records one inspectable note and never assigns or punishes a worker', t => {
  const f = fixture(t), task = f.assign(), before = f.hive.tasks.get(f.brain.agent, task.id);
  const input = { expectedRevision: task.revision, workerId: f.workers[1]!.agent.id, requestId: 'override-1', reason: 'Known domain familiarity' };
  let messages = 0; f.hive.bus.on('message', () => messages++);
  const first = f.hive.routing.override(f.brain.agent, task.id, input), replay = f.hive.routing.override(f.brain.agent, task.id, input);
  assert.equal(first.message.id, replay.message.id); assert.equal(messages, 1); assert.equal(first.assigned, false);
  assert.match(first.message.body, /Known domain familiarity/);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), before);
  assert.throws(() => f.hive.routing.override(f.other.agent, task.id, { ...input, requestId: 'foreign' }), status(403));
  assert.throws(() => f.hive.routing.override(f.brain.agent, task.id, { ...input, reason: 'Different payload' }), status(409));
  assert.throws(() => f.hive.routing.override(f.brain.agent, task.id, { ...input, expectedRevision: 99 }), status(409));
});

test('actual HTTP capability races have one winner and validate before mutation', { timeout: 15000 }, async t => {
  const f = fixture(t), worker = f.workers[0]!, task = f.assign();
  const server = startServer({ hive: f.hive, port: 0, telegram: false }); const port = await server.ready;
  const send = (body: unknown, endpoint = '/capabilities', token = worker.token) => fetch(`http://127.0.0.1:${port}/api/agent${endpoint}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: t.signal });
  try {
    const invalid = await send({ expectedRevision: 0, card: { ...card, availability: 'telepathic' } });
    assert.equal(invalid.status, 400); await invalid.body?.cancel(); assert.equal(f.hive.routing.get(worker.agent, worker.agent.id), null);
    const attempts = await Promise.all([send({ expectedRevision: 0, card }), send({ expectedRevision: 0, card })]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]); await Promise.all(attempts.map(r => r.body?.cancel()));
    const suggestions = await send(query, `/tasks/${task.id}/routing`, f.brain.token);
    assert.equal(suggestions.status, 200); assert.equal((await suggestions.json() as { eligibleTotal: number }).eligibleTotal, 1);
    const denied = await send(query, `/tasks/${task.id}/routing`); assert.equal(denied.status, 403); await denied.body?.cancel();
  } finally { await server.shutdown(); }
});

test('card roster admission is bounded and paginated suggestions do not silently discard cold starts', t => {
  const f = fixture(t), task = f.assign(), original = f.workers[0]!.agent; f.set(0);
  for (let n = 0; n < 255; n++) {
    const id = randomUUID();
    cloneAgent(f.hive, original.id, [id], () => ({ name: `CardFixture${n}`, token_hash: randomUUID() }));
    addChannelMember(f.hive, f.room.id, id);
    const actor = f.hive.identity.getAgent(id); f.hive.routing.set(actor, { expectedRevision: 0, card });
  }
  assert.throws(() => f.set(1), status(429));
  const seen = new Set<string>(); let offset: number | null = 0;
  while (offset !== null) {
    const page = f.hive.routing.suggest(f.brain.agent, task.id, { ...query, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024); assert.ok(page.candidates.length <= 12);
    for (const entry of page.candidates) { assert.ok(!seen.has(entry.workerId)); seen.add(entry.workerId); }
    offset = page.nextOffset;
  }
  assert.equal(seen.size, 256);
});

test('review intervals report uncertainty and never invent evidence for zero observations', () => {
  assert.equal(outcomeInterval(0, 0), null);
  assert.ok(outcomeInterval(0, 10)![1] < 0.3);
  assert.ok(outcomeInterval(10, 10)![0] > 0.7);
});
