import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-routing.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';

const contract = { objective: 'Complete the independent fixture work.', scope: [], nonGoals: [],
  acceptanceCriteria: ['Return an inspectable result.'], dependencies: [], evidenceSeqs: [] };
const result = { summary: 'Fixture complete.', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] };
async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'topology-actions-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' });
  const otherBrain = hive.join({ role: 'brain', project: 'chapter' });
  const workers = [0, 1].map(() => hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' }));
  const dm = hive.openDm(human, brain.agent.name);
  const otherDm = hive.openDm(human, otherBrain.agent.name);
  const workerDm = hive.openDm(brain.agent, workers[0]!.agent.name);
  const app = createApp(hive);
  let target: AdaptiveTopology = 'single';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    calls++;
    return Response.json(jevTopologyResponse(String(init?.body), target));
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-not-a-live-key' });
  t.after(async () => {
    await hive.adaptiveTopology.stop();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const post = (token: string, endpoint: string, body: unknown) => app.request(`/api/agent${endpoint}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const start = async (which = brain, channel = dm) => {
    const routed = await hive.adaptiveTopology.routeHumanRequest(human, {
      channel: channel.id, body: 'Execute the fixture request.', requestId: `human-${which.agent.id}`,
    }, 'auto', 'none');
    assert.ok(routed);
    assert.equal(routed.routing.providerStatus, 'ok');
    return routed.state;
  };
  const assign = (key: string, which = brain, worker = workers[0]!) => post(which.token, '/tasks', {
    requestId: key, worker: worker.agent.name, contract,
  });
  const taskEvent = (task: TaskSnapshot, token: string, key: string, action: unknown) => post(token, `/tasks/${task.id}/events`, {
    requestId: key, expectedRevision: hive.tasks.get(human, task.id).revision, action,
  });
  const state = () => hive.adaptiveTopology.view(human, dm.id).state!;
  return { hive, human, brain, otherBrain, workers, dm, otherDm, workerDm, app, post, start, assign, taskEvent,
    state, calls: () => calls, choose: (mode: AdaptiveTopology) => { target = mode; } };
}

test('a Single delegation is checked once, then admitted and linked atomically; committed retry does not reclassify', async t => {
  const f = await fixture(t);
  await f.start();
  f.choose('brain_one_worker');
  const before = f.calls();
  const response = await f.assign('one-task');
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { task: TaskSnapshot; adaptiveRouting: { currentTopology: string } };
  assert.equal(f.calls(), before + 1);
  assert.equal(body.adaptiveRouting.currentTopology, 'brain_one_worker');
  const linked = f.hive.db.prepare('SELECT execution_id FROM adaptive_topology_tasks WHERE task_id=?').get(body.task.id);
  assert.equal(linked?.execution_id, f.state().executionId);
  const capacity = readAdaptiveCapacity(f.hive, f.state());
  assert.equal(capacity.workers.busyCurrent, 1);
  assert.equal(capacity.workers.free, 1);
  assert.equal(capacity.workers.usableForExecution, 2, 'Do not count a current worker twice or remove it from the plan');
  const retryCalls = f.calls();
  const retry = await f.assign('one-task');
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { task: TaskSnapshot }).task.id, body.task.id);
  assert.equal(f.calls(), retryCalls);
});

test('direct TaskStore assignment cannot bypass an active Single delegation gate', async t => {
  const f = await fixture(t);
  await f.start();
  const count = () => Number(f.hive.db.prepare('SELECT count(*) AS n FROM task_records').get()!.n);
  const before = count();
  assert.throws(() => f.hive.tasks.assign(f.brain.agent, { requestId: 'bypass', worker: f.workers[0]!.agent.name, contract }), /fresh Jev/);
  assert.equal(count(), before);
});

test('de-escalation drains an accepted task and reaches Single only after the brain accepts its result', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker'); await f.start();
  const assigned = await f.assign('drain-task');
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const task = (await assigned.json() as { task: TaskSnapshot }).task;
  f.choose('single');
  const accepted = await f.taskEvent(task, f.workers[0]!.token, 'accept', { type: 'accept' });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const submitted = await f.taskEvent(task, f.workers[0]!.token, 'result', { type: 'result', result });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  assert.equal(f.state().currentTopology, 'brain_one_worker');
  assert.equal(f.state().desiredTopology, 'single');
  const blocked = await f.assign('new-work-during-drain', f.brain, f.workers[1]!);
  assert.equal(blocked.status, 409);
  assert.equal(f.hive.tasks.get(f.human, task.id).state, 'result_submitted');
  const reviewed = await f.taskEvent(task, f.brain.token, 'review', {
    type: 'review', decision: 'accepted', summary: 'Verified fixture result.', evidenceSeqs: [],
  });
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
  assert.equal(f.state().currentTopology, 'single');
  assert.equal(f.state().workerBudget, 0);
  assert.equal(f.state().desiredTopology, null);
});

test('free-form DM assignments consume capacity until the coordinating brain closes their thread', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker'); await f.start();
  const sent = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Complete this delegated fixture.', eventType: 'assignment', requestId: 'raw-delegation',
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const message = await sent.json() as { id: string };
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).workers.busyCurrent, 1);
  f.choose('single');
  for (const requestId of ['first-checkpoint', 'second-checkpoint']) {
    const checkpoint = await f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
      body: 'Checking remaining work.', eventType: 'progress', requestId,
    });
    assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
  }
  assert.equal(f.state().currentTopology, 'brain_one_worker');
  assert.equal(f.state().desiredTopology, 'single');
  const closed = await f.post(f.brain.token, `/threads/${message.id}/status`, { status: 'done' });
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal(f.state().currentTopology, 'single');
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).workers.free, 2);
});

test('a failed execution link rolls back the delegated task and its message together', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker'); await f.start();
  const beforeMessages = Number(f.hive.db.prepare('SELECT count(*) AS n FROM messages').get()!.n);
  f.hive.db.exec("CREATE TEMP TRIGGER fail_adaptive_link BEFORE INSERT ON adaptive_topology_tasks BEGIN SELECT RAISE(ABORT,'fixture link failure'); END");
  const failed = await f.assign('atomic-link');
  assert.equal(failed.status, 500);
  assert.equal(Number(f.hive.db.prepare('SELECT count(*) AS n FROM task_records').get()!.n), 0);
  assert.equal(Number(f.hive.db.prepare('SELECT count(*) AS n FROM messages').get()!.n), beforeMessages);
  f.hive.db.exec('DROP TRIGGER fail_adaptive_link');
  const retried = await f.assign('atomic-link');
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(Number(f.hive.db.prepare('SELECT count(*) AS n FROM adaptive_topology_tasks').get()!.n), 1);
});

test('another execution cannot claim a worker that is already busy even when its requested topology is feasible', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker');
  await f.start(); await f.start(f.otherBrain, f.otherDm);
  const first = await f.assign('first-owner');
  assert.equal(first.status, 200, await first.clone().text());
  const conflict = await f.assign('second-owner', f.otherBrain);
  assert.equal(conflict.status, 409, await conflict.clone().text());
  const rows = f.hive.db.prepare('SELECT worker_id FROM task_records').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.worker_id, f.workers[0]!.agent.id);
});


test('sender progress and decision labels cannot smuggle a new delegation past Single', async t => {
  const f = await fixture(t); await f.start();
  for (const eventType of ['progress', 'decision', 'question', 'assignment']) {
    const before = f.calls();
    const attempted = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
      body: 'Start this independent task.', eventType, requestId: `typed-${eventType}`,
    });
    assert.equal(attempted.status, 409, await attempted.clone().text());
    assert.equal(f.calls(), before + 1);
  }
  const unaddressed = await f.post(f.brain.token, '/channels/general/messages', {
    body: 'Start new work.', eventType: 'assignment', requestId: 'broadcast-assignment',
  });
  assert.equal(unaddressed.status, 409);
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).activeWorkers, 0);
});

test('an existing delegation can finish its conversation during drain without reserving a new worker', async t => {
  const f = await fixture(t); f.choose('brain_one_worker'); await f.start();
  const assigned = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Complete the task.', requestId: 'raw-assignment', eventType: 'assignment',
  });
  assert.equal(assigned.status, 200); const root = (await assigned.json() as { id: string }).id;
  f.choose('single');
  for (const requestId of ['check-a', 'check-b']) await f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
    body: 'Remaining work is local.', eventType: 'progress', requestId,
  });
  assert.equal(f.state().desiredTopology, 'single');
  const reply = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Yes, finish with the existing acceptance criteria.', threadId: root, requestId: 'finish-reply',
  });
  assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).activeWorkers, 1);
  const another = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Also take this new assignment.', threadId: root, eventType: 'assignment', requestId: 'new-assignment',
  });
  assert.equal(another.status, 409);
});
