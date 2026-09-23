import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { readAdaptiveCapacity } from './adaptive-topology-capacity.ts';
import { coordinationEventId, settleAdaptiveFollowUps } from './adaptive-topology-admission.ts';
import { HiveError } from '../shared/types.ts';
import type { AdaptiveRoutingEvent, AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import { countRows, failWrites, findRow, hasRow, listRows } from './test-fixtures.ts';

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
  let calls = 0, latency = 0, inFlight = 0, maxInFlight = 0;
  // A held Jev call models a slow classifier: it answers only once the test releases it.
  const held: Array<{ matches: (call: number, body: string) => boolean; gate: Promise<void>; release: () => void }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    const call = ++calls, body = String(init?.body);
    await Promise.all(held.filter(item => item.matches(call, body)).map(item => item.gate));
    if (latency) {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try { await new Promise(resolve => setTimeout(resolve, latency)); } finally { inFlight--; }
    }
    return Response.json(jevTopologyResponse(body, target));
  });
  const hold = (matches: (call: number, body: string) => boolean) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    held.push({ matches, gate, release });
    return release;
  };
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-not-a-live-key' });
  t.after(async () => {
    for (const item of held) item.release();
    await settleAdaptiveFollowUps(hive);
    await hive.adaptiveTopology.stop();
    hive.db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const post = (token: string, endpoint: string, body: unknown) => app.request(`/api/agent${endpoint}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  // Delegation must name the Human request it serves: the brain copies executionId from its directive.
  const executions = new Map<string, string>();
  const exec = (which = brain) => executions.get(which.agent.id);
  const start = async (which = brain, channel = dm) => {
    const routed = await hive.adaptiveTopology.routeHumanRequest(human, {
      channel: channel.id, body: 'Execute the fixture request.', requestId: `human-${which.agent.id}`,
    }, 'auto', 'none');
    assert.ok(routed);
    assert.equal(routed.routing.providerStatus, 'ok');
    executions.set(which.agent.id, routed.state.executionId);
    return routed.state;
  };
  const assign = (key: string, which = brain, worker = workers[0]!) => post(which.token, '/tasks', {
    requestId: key, worker: worker.agent.name, contract, executionId: exec(which),
  });
  const taskEvent = (task: TaskSnapshot, token: string, key: string, action: unknown) => post(token, `/tasks/${task.id}/events`, {
    requestId: key, expectedRevision: hive.tasks.get(human, task.id).revision, action,
  });
  const state = () => hive.adaptiveTopology.view(human, dm.id).state!;
  return { hive, human, brain, otherBrain, workers, dm, otherDm, workerDm, app, post, start, assign, taskEvent, exec,
    state, hold, calls: () => calls, choose: (mode: AdaptiveTopology) => { target = mode; },
    /** Every later Jev call answers after `ms`; returns the peak number of concurrent calls since then. */
    delay: (ms: number) => { latency = ms; maxInFlight = 0; return () => maxInFlight; } };
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
  const linked = findRow(f.hive, 'adaptive_topology_tasks', { task_id: body.task.id });
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
  const count = () => countRows(f.hive, 'task_records');
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
  assert.equal(f.state().desiredTopology, null, 'Worker lifecycle events never drive Jev');
  for (const requestId of ['drain-check-a', 'drain-check-b']) {
    const checkpoint = await f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
      body: 'Result received; reviewing it locally.', eventType: 'progress', requestId,
    });
    assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
  }
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
    body: 'Complete this delegated fixture.', eventType: 'assignment', requestId: 'raw-delegation', executionId: f.exec(),
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
  const beforeMessages = countRows(f.hive, 'messages');
  const restoreLink = failWrites(f.hive, 'adaptive_topology_tasks', { message: 'fixture link failure' });
  const failed = await f.assign('atomic-link');
  assert.equal(failed.status, 500);
  assert.equal(countRows(f.hive, 'task_records'), 0);
  assert.equal(countRows(f.hive, 'messages'), beforeMessages);
  restoreLink();
  const retried = await f.assign('atomic-link');
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(countRows(f.hive, 'adaptive_topology_tasks'), 1);
});

test('another execution cannot claim a worker that is already busy even when its requested topology is feasible', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker');
  await f.start(); await f.start(f.otherBrain, f.otherDm);
  const first = await f.assign('first-owner');
  assert.equal(first.status, 200, await first.clone().text());
  const conflict = await f.assign('second-owner', f.otherBrain);
  assert.equal(conflict.status, 409, await conflict.clone().text());
  const rows = listRows(f.hive, 'task_records', { columns: 'worker_id' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.worker_id, f.workers[0]!.agent.id);
});


test('sender progress and decision labels cannot smuggle a new delegation past Single', async t => {
  const f = await fixture(t); await f.start();
  for (const eventType of ['progress', 'decision', 'question', 'assignment']) {
    const before = f.calls();
    const attempted = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
      body: 'Start this independent task.', eventType, requestId: `typed-${eventType}`, executionId: f.exec(),
    });
    assert.equal(attempted.status, 409, await attempted.clone().text());
    assert.equal(f.calls(), before + 1);
  }
  const unaddressed = await f.post(f.brain.token, '/channels/general/messages', {
    body: 'Start new work.', eventType: 'assignment', requestId: 'broadcast-assignment', executionId: f.exec(),
  });
  assert.equal(unaddressed.status, 409);
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).activeWorkers, 0);
});

test('an existing delegation can finish its conversation during drain without reserving a new worker', async t => {
  const f = await fixture(t); f.choose('brain_one_worker'); await f.start();
  const assigned = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Complete the task.', requestId: 'raw-assignment', eventType: 'assignment', executionId: f.exec(),
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
  const unnamed = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Also take this new assignment.', threadId: root, eventType: 'assignment', requestId: 'unnamed-assignment',
  });
  assert.equal(unnamed.status, 400, 'New delegation must name its execution');
  const another = await f.post(f.brain.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Also take this new assignment.', threadId: root, eventType: 'assignment', requestId: 'new-assignment', executionId: f.exec(),
  });
  assert.equal(another.status, 409);
});

test('delegation must name one of the brain\'s active executions; parallel requests keep separate policies', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker');
  const direct = await f.start();
  const group = f.hive.createChannel(f.human, { name: 'planning', type: 'private', project: 'chapter', memberNames: [f.brain.agent.name, f.workers[0]!.agent.name, f.workers[1]!.agent.name] });
  f.choose('single');
  const parallel = await f.hive.adaptiveTopology.routeHumanRequest(f.human, {
    channel: group.id, body: 'Answer this quickly yourself.', requestId: 'group-request',
  }, 'auto', 'none');
  assert.ok(parallel);
  assert.notEqual(parallel.state.executionId, direct.executionId, 'A request in another channel runs in parallel');
  assert.equal(f.hive.adaptiveTopology.policiesFor(f.brain.agent).length, 2);
  assert.equal(f.hive.adaptiveTopology.forAgent(f.brain.agent), null, 'No implicit execution when several are active');
  const unnamed = await f.post(f.brain.token, '/tasks', { requestId: 'unnamed', worker: f.workers[0]!.agent.name, contract });
  assert.equal(unnamed.status, 400);
  assert.match(await unnamed.text(), /executionId is required/);
  const foreign = await f.post(f.otherBrain.token, '/tasks', {
    requestId: 'foreign', worker: f.workers[0]!.agent.name, contract, executionId: direct.executionId });
  assert.equal(foreign.status, 403, 'An execution belongs to one brain');
  const blocked = await f.post(f.brain.token, '/tasks', {
    requestId: 'group-task', worker: f.workers[0]!.agent.name, contract, executionId: parallel.state.executionId });
  assert.equal(blocked.status, 409, 'The Single request cannot delegate');
  const allowed = await f.post(f.brain.token, '/tasks', {
    requestId: 'direct-task', worker: f.workers[0]!.agent.name, contract, executionId: direct.executionId });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const task = (await allowed.json() as { task: TaskSnapshot }).task;
  const linked = findRow(f.hive, 'adaptive_topology_tasks', { task_id: task.id });
  assert.equal(linked?.execution_id, direct.executionId);
});

test('a brain report naming a worker who cannot read the channel is a reference, not a delegation', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker'); await f.start();
  const worker = f.workers[0]!.agent.name;
  const report = await f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
    body: `Update: @${worker} finished the parser.`, requestId: 'report-worker',
  });
  assert.equal(report.status, 200, await report.clone().text());
  assert.equal(countRows(f.hive, 'adaptive_topology_messages'), 0);
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).activeWorkers, 0, 'A reference reserves no worker');
  const group = f.hive.createChannel(f.human, { name: 'crew', type: 'private', project: 'chapter',
    memberNames: [f.brain.agent.name, worker] });
  const unnamed = await f.post(f.brain.token, `/channels/${group.id}/messages`, {
    body: `@${worker} please take the parser.`, requestId: 'group-mention',
  });
  assert.equal(unnamed.status, 400, 'A mention the worker receives is still a delegation');
  assert.match(await unnamed.text(), /executionId is required/);
  const delegated = await f.post(f.brain.token, `/channels/${group.id}/messages`, {
    body: `@${worker} please take the parser.`, requestId: 'group-mention-named', executionId: f.exec(),
  });
  assert.equal(delegated.status, 200, await delegated.clone().text());
  assert.equal(readAdaptiveCapacity(f.hive, f.state()).activeWorkers, 1);
});

/** Fails instead of hanging when a send is (wrongly) queued behind a held Jev call. */
async function within<T>(pending: T | Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} waited for another brain's Jev call`)), ms); });
  try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
}

test('a slow Jev call for one brain never delays workers or other brains in the same project', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker');
  await f.start(); await f.start(f.otherBrain, f.otherDm);
  const first = f.calls() + 1, release = f.hold(call => call === first);
  let slowSettled = false;
  const slow = Promise.resolve(f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
    body: 'Checking in on the plan.', eventType: 'progress', requestId: 'slow-brain',
  })).finally(() => { slowSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const worker = await within(f.post(f.workers[0]!.token, `/channels/${f.workerDm.id}/messages`, {
    body: 'Unrelated status update.', requestId: 'worker-dm',
  }), 'A worker send');
  assert.equal(worker.status, 200, await worker.clone().text());
  const other = await within(f.post(f.otherBrain.token, `/channels/${f.otherDm.id}/messages`, {
    body: 'Independent progress.', eventType: 'progress', requestId: 'other-brain',
  }), 'Another brain\'s send');
  assert.equal(other.status, 200, await other.clone().text());
  assert.equal(slowSettled, false, 'The slow brain is still waiting for Jev');
  release();
  assert.equal((await slow).status, 200);
});

test('project-wide capacity revalidation runs after the assignment is answered', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker');
  await f.start(); await f.start(f.otherBrain, f.otherDm);
  const otherExecution = f.exec(f.otherBrain)!;
  const evaluated = () => hasRow(f.hive, 'adaptive_topology_evaluated',
    { execution_id: otherExecution, event_id: coordinationEventId(f.brain.agent.id, 'capacity', 'capacity-after-lane') });
  // Only the capacity revalidation (of the other execution) is slow.
  const release = f.hold((_call, body) => body.includes('"capacity_change"'));
  const assigned = await within(f.assign('capacity-after-lane'), 'The assignment');
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const next = await within(f.post(f.brain.token, `/channels/${f.dm.id}/messages`, {
    body: 'Still tracking the delegated work.', eventType: 'progress', requestId: 'lane-free',
  }), 'The next brain action');
  assert.equal(next.status, 200, 'The brain lane is not held by other executions\' revalidation');
  assert.equal(evaluated(), false, 'Revalidation is still waiting for Jev');
  release();
  await settleAdaptiveFollowUps(f.hive);
  assert.equal(evaluated(), true, 'The other execution saw the capacity change');
});

test('a committed task review or thread close is reported as committed when post-commit routing fails', async t => {
  const f = await fixture(t);
  f.choose('brain_one_worker'); await f.start();
  const assigned = await f.assign('warned-task');
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const task = (await assigned.json() as { task: TaskSnapshot }).task;
  assert.equal((await f.taskEvent(task, f.workers[0]!.token, 'warned-accept', { type: 'accept' })).status, 200);
  assert.equal((await f.taskEvent(task, f.workers[0]!.token, 'warned-result', { type: 'result', result })).status, 200);
  const published: AdaptiveRoutingEvent[] = [];
  f.hive.bus.on('adaptive-routing', (payload: { event: AdaptiveRoutingEvent }) => published.push(payload.event));
  t.mock.method(f.hive.adaptiveTopology, 'afterAgentAction', async () => { throw new HiveError(409, 'Adaptive execution changed'); });
  const reviewed = await f.taskEvent(task, f.brain.token, 'warned-review', {
    type: 'review', decision: 'accepted', summary: 'Verified fixture result.', evidenceSeqs: [],
  });
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
  const body = await reviewed.json() as { adaptiveRouting: unknown; routingWarning?: string };
  assert.equal(body.adaptiveRouting, null);
  assert.match(body.routingWarning ?? '', /Adaptive execution changed/);
  assert.equal(f.hive.tasks.get(f.human, task.id).state, 'accepted_complete');
  const sent = await f.post(f.brain.token, `/channels/${f.dm.id}/messages`, { body: 'Wrapping up.', requestId: 'warned-thread' });
  const root = (await sent.json() as { id: string }).id;
  const closed = await f.post(f.brain.token, `/threads/${root}/status`, { status: 'done' });
  assert.equal(closed.status, 200, await closed.clone().text());
  const thread = await closed.json() as { thread: { status: string }; adaptiveRouting: unknown; routingWarning?: string };
  assert.equal(thread.thread.status, 'done');
  assert.equal(thread.adaptiveRouting, null);
  assert.match(thread.routingWarning ?? '', /Adaptive execution changed/);
  // The Human routing audit sees both warnings on the execution the committed actions belong to.
  const audit = (events: AdaptiveRoutingEvent[]) => events.filter(item => item.reason === 'post_commit_routing_failed')
    .map(item => [item.kind, item.executionId, item.warning]);
  const expected = [0, 1].map(() => ['warning', f.exec(), 'Committed; adaptive routing was not updated: Adaptive execution changed']);
  assert.deepEqual(audit(f.hive.adaptiveTopology.view(f.human, f.dm.id).events), expected);
  assert.deepEqual(audit(published), expected, 'each warning is published to the live panel');
});

test('a post-commit routing warning with no resolvable execution records nothing', async t => {
  const f = await fixture(t);
  const before = countRows(f.hive, 'adaptive_topology_events');
  const coordination = { kind: 'task_event' as const, actorId: f.brain.agent.id, actorRole: 'brain' as const, channelId: f.dm.id, eventId: 'no-execution' };
  assert.equal(f.hive.adaptiveTopology.recordRoutingWarning(f.brain.agent, coordination, 'Committed; routing failed'), null);
  assert.equal(f.hive.adaptiveTopology.recordRoutingWarning(f.workers[0]!.agent, coordination, 'Committed; routing failed'), null);
  assert.equal(countRows(f.hive, 'adaptive_topology_events'), before);
});

test('capacity revalidation runs other executions concurrently, bounded, and isolates failures', async t => {
  const f = await fixture(t);
  // Five executions, one per brain, each in its own Human DM.
  const extra = [0, 1, 2].map(() => f.hive.join({ role: 'brain', project: 'chapter' }));
  await f.start(f.brain, f.dm); await f.start(f.otherBrain, f.otherDm);
  for (const brain of extra) await f.start(brain, f.hive.openDm(f.human, brain.agent.name));
  const ids = [f.brain, f.otherBrain, ...extra].map(brain => f.exec(brain)!);
  const evaluated = (eventId: string) => ids.filter(id => hasRow(f.hive, 'adaptive_topology_evaluated',
    { execution_id: id, event_id: coordinationEventId(f.brain.agent.id, 'capacity', eventId) })).length;
  const latency = 200;

  // Four other executions are classified concurrently: all four Jev calls are in flight at once.
  // Concurrency is proven by the in-flight peak, not wall-clock time, which is unreliable on CI runners.
  let peak = f.delay(latency);
  await f.hive.adaptiveTopology.capacityChanged(f.brain.agent, 'four-at-once', ids[0]!);
  assert.equal(evaluated('four-at-once'), 4);
  assert.equal(peak(), 4, 'all four other executions call Jev concurrently; sequential would peak at 1');

  // Five executions never exceed the bound of four concurrent Jev calls.
  peak = f.delay(latency);
  await f.hive.adaptiveTopology.capacityChanged(f.brain.agent, 'bounded');
  assert.equal(evaluated('bounded'), 5);
  assert.equal(peak(), 4, 'at most four Jev calls run at once');

  // One execution fails; the others are still revalidated and the failure is reported once all settle.
  f.delay(0);
  const runtime = f.hive.adaptiveTopology as unknown as { revalidateStored: (state: { executionId: string }, event: unknown) => Promise<unknown> };
  const original = runtime.revalidateStored.bind(runtime);
  t.mock.method(runtime, 'revalidateStored', async (state: { executionId: string }, event: unknown) => {
    if (state.executionId === ids[1]) throw new Error('fixture revalidation failure');
    return original(state, event);
  });
  await assert.rejects(f.hive.adaptiveTopology.capacityChanged(f.brain.agent, 'isolated', ids[0]!), /fixture revalidation failure/);
  assert.equal(evaluated('isolated'), 3, 'every other execution was still revalidated');
});
