import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hive } from './hive.ts';
import { startServer } from './serve.ts';
import { HiveError, type Agent } from '../shared/types.ts';
import { claimActionSchema, overlappingPaths, CLAIM_LIMITS } from '../shared/task-claims.ts';
import type { TaskAction, TaskContract, TaskSnapshot } from '../shared/tasks.ts';
import { countRows, failWrites, insertRow, removeChannelMember, storedSnapshot } from './test-fixtures.ts';
import { childEnv, stopChild } from '../test-support/child-process.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-claims-')), file = path.join(dir, 'hive.db');
  let hive = new Hive(file), n = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.identity.join({ role: 'brain' }), other = hive.identity.join({ role: 'brain' });
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const room = hive.channels.createChannel(brain.agent, { name: 'advisory', type: 'private', memberNames: [other.agent.name, worker.agent.name] });
  const contract: TaskContract = { objective: 'A synthetic advisory task', scope: [], nonGoals: ['No execution'], acceptanceCriteria: ['Reviewed'], dependencies: [], evidenceSeqs: [] };
  const assign = (dependencies: string[] = [], extra = {}) => hive.tasks.assign(brain.agent,
    { requestId: `a-${++n}`, worker: worker.agent.name, channel: room.id, contract: { ...contract, dependencies }, ...extra }).task;
  const event = (task: TaskSnapshot, actor: Agent, action: TaskAction) => hive.tasks.event(actor, task.id,
    { requestId: `e-${++n}`, expectedRevision: hive.tasks.get(actor, task.id).revision, action });
  const complete = (task: TaskSnapshot) => {
    event(task, worker.agent, { type: 'accept' });
    event(task, worker.agent, { type: 'result', result: { summary: 'Reported', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
    return event(task, brain.agent, { type: 'review', decision: 'accepted', summary: 'Explicitly reviewed', evidenceSeqs: [] }).task;
  };
  return { get hive() { return hive; }, brain, other, worker, room, contract, assign, event, complete,
    reopen() { hive.db.close(); hive = new Hive(file); } };
}
const claim = (paths: string[] = []): TaskAction => ({ type: 'claim', paths, leaseSeconds: 60, overlapAcknowledgements: [] });
const status = (expected: number) => (error: unknown) => error instanceof HiveError && error.status === expected;

test('two real HTTP claim requests have one winner, stable retries, and no duplicate notification', { timeout: 15000 }, async t => {
  const f = fixture(t), task = f.assign();
  const server = startServer({ hive: f.hive, port: 0, telegram: false });
  const port = await server.ready;
  let events = 0; f.hive.bus.on('task', () => events++);
  const inputs = [f.brain, f.other].map((actor, i) => ({ actor, body: { requestId: `race-${i}`, expectedRevision: 1, action: claim(['src/parser']) } }));
  const send = async (input: typeof inputs[number]) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/tasks/${task.id}/events`, {
      method: 'POST', headers: { authorization: `Bearer ${input.actor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input.body), signal: t.signal,
    });
    return { status: res.status, data: await res.json() as { task?: TaskSnapshot; duplicate?: boolean; message?: { id: string } } };
  };
  try {
    const responses = await Promise.all(inputs.map(send));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = responses.findIndex(r => r.status === 200);
    const replay = await send(inputs[winner]!);
    assert.equal(replay.status, 200); assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.message!.id, responses[winner]!.data.message!.id);
    assert.equal(events, 1);
    const saved = f.hive.tasks.get(f.brain.agent, task.id);
    assert.equal(saved.claim!.coordinatorId, inputs[winner]!.actor.agent.id);
    assert.equal(saved.assignerId, f.brain.agent.id); assert.equal(saved.workerId, f.worker.agent.id);
    assert.equal(saved.state, 'sent'); assert.equal(saved.coordination!.claim, 'held');
    assert.ok(!storedSnapshot(f.hive, 'task_records', task.id).coordination);
  } finally { await server.shutdown(); }
});

test('expired claims survive restart as uncertain and never silently reassign or free WIP', t => {
  const f = fixture(t), task = f.assign(); let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const held = f.event(task, f.other.agent, claim()).task;
  now += 60_001; f.reopen();
  const uncertain = f.hive.tasks.get(f.brain.agent, task.id);
  assert.equal(uncertain.coordination!.claim, 'uncertain');
  assert.deepEqual(uncertain.claim, held.claim);
  assert.equal(uncertain.workerId, task.workerId); assert.equal(uncertain.state, 'sent');
  assert.throws(() => f.event(task, f.brain.agent, claim()), /already claimed/);
  assert.throws(() => f.event(task, f.other.agent, { type: 'renew_claim', leaseSeconds: 60, overlapAcknowledgements: [] }), /unexpired/);
  assert.throws(() => f.event(task, f.other.agent, { type: 'reconcile_claim', reason: 'I decide', leaseSeconds: 60, paths: [], overlapAcknowledgements: [] }), status(403));
  assert.throws(() => f.event(task, f.worker.agent, { type: 'accept' }), /uncertain/);
  const reconciled = f.event(task, f.brain.agent, { type: 'reconcile_claim', reason: 'Confirmed same worker is continuing', leaseSeconds: 120, paths: [], overlapAcknowledgements: [] }).task;
  assert.equal(reconciled.claim!.version, 2); assert.equal(reconciled.claim!.coordinatorId, f.brain.agent.id);
  assert.equal(reconciled.workerId, task.workerId); assert.equal(reconciled.contractVersion, task.contractVersion);
  f.event(task, f.worker.agent, { type: 'accept' });
  f.event(task, f.brain.agent, { type: 'release_claim', reason: 'Advisory coordination finished' });
  assert.equal(f.hive.tasks.get(f.worker.agent, task.id).coordination!.claim, 'released');
});

test('safe paths, explainable overlaps, and exact version acknowledgements preserve intentional collaboration', t => {
  const f = fixture(t), one = f.assign(), two = f.assign();
  assert.deepEqual(overlappingPaths(['src/a', 'src/ab', 'docs'], ['src/a/file.ts']), ['src/a']);
  for (const invalid of ['/tmp/x', '../x', 'x/../y', 'x//y', './x', 'src/*', 'C:\\x', '~/x', 'x\u0000y'])
    assert.equal(claimActionSchema.safeParse(claim([invalid])).success, false, invalid);
  f.event(one, f.brain.agent, claim(['src/a']));
  assert.throws(() => f.event(two, f.other.agent, claim(['src/a/file.ts'])), /overlapping task/);
  f.event(two, f.other.agent, { type: 'claim', leaseSeconds: 60, paths: ['src/a/file.ts'],
    overlapAcknowledgements: [{ taskId: one.id, claimVersion: 1 }] });
  const overlap = f.hive.tasks.get(f.other.agent, two.id).coordination!.overlaps;
  assert.deepEqual(overlap, [{ taskId: one.id, claimVersion: 1, paths: ['src/a/file.ts'], acknowledged: true, status: 'held' }]);
  f.event(one, f.brain.agent, { type: 'renew_claim', leaseSeconds: 90, overlapAcknowledgements: [{ taskId: two.id, claimVersion: 1 }] });
  assert.equal(f.hive.tasks.get(f.other.agent, two.id).coordination!.overlaps[0]!.acknowledged, false);
  assert.throws(() => f.event(two, f.other.agent, { type: 'renew_claim', leaseSeconds: 90,
    overlapAcknowledgements: [{ taskId: one.id, claimVersion: 1 }] }), /current claim version/);
  assert.throws(() => f.event(two, f.other.agent, { type: 'release_claim', reason: 'x', actorId: f.brain.agent.id } as unknown as TaskAction), /Invalid task event/);
});

test('private and foreign claims never appear as path warnings or confer task authority', t => {
  const f = fixture(t), publicTask = f.assign();
  const privateTask = f.assign([], { channel: f.hive.channels.openDm(f.brain.agent, f.worker.agent.name).id });
  f.event(privateTask, f.brain.agent, claim(['src/shared']));
  f.event(publicTask, f.other.agent, claim(['src/shared']));
  assert.deepEqual(f.hive.tasks.get(f.other.agent, publicTask.id).coordination!.overlaps, []);
  assert.equal(f.hive.tasks.get(f.brain.agent, publicTask.id).coordination!.overlaps.length, 1);
  assert.throws(() => f.event(publicTask, f.worker.agent, { type: 'release_claim', reason: 'Worker cannot grant authority' }), status(403));
  f.hive.projects.createProject(f.hive.identity.getAgent('human'), { name: 'Foreign', slug: 'foreign' });
  const foreign = f.hive.identity.join({ role: 'brain', project: 'foreign' }).agent;
  assert.throws(() => f.hive.tasks.get(foreign, publicTask.id), status(403));
  assert.throws(() => f.hive.tasks.event(foreign, publicTask.id, { requestId: 'foreign', expectedRevision: 2, action: claim() }), status(403));
  assert.throws(() => f.event(publicTask, f.other.agent, { type: 'revise', reason: 'claim is not task authority', worker: f.worker.agent.name, contract: f.contract }), status(403));
});

test('WIP admission counts uncertain claims and explicit release frees a slot', t => {
  const f = fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const tasks = Array.from({ length: CLAIM_LIMITS.worker + 1 }, () => f.assign());
  for (const task of tasks.slice(0, CLAIM_LIMITS.worker)) f.event(task, f.brain.agent, claim());
  now += 61_000;
  assert.throws(() => f.event(tasks.at(-1)!, f.brain.agent, claim()), status(429));
  f.event(tasks[0]!, f.brain.agent, { type: 'release_claim', reason: 'Explicit resolution' });
  f.event(tasks.at(-1)!, f.brain.agent, claim());
  assert.equal(f.hive.tasks.get(f.worker.agent, tasks.at(-1)!.id).coordination!.claim, 'held');
});

test('claims and notifications roll back together on event persistence failure', t => {
  const f = fixture(t), task = f.assign(), before = f.hive.tasks.get(f.brain.agent, task.id);
  const counts = () => ['messages', 'task_events'].map(table => countRows(f.hive, table));
  const oldCounts = counts(); let events = 0; f.hive.bus.on('task', () => events++);
  const restoreClaims = failWrites(f.hive, 'task_events', { persistent: true,
    when: "json_extract(NEW.envelope, '$.action.type') = 'claim'", message: 'claim-fixture-failure' });
  assert.throws(() => f.event(task, f.brain.agent, claim()), /claim-fixture-failure/);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), before);
  assert.deepEqual(counts(), oldCounts); assert.equal(events, 0);
  restoreClaims(); f.event(task, f.brain.agent, claim()); assert.equal(events, 1);
});

test('dependency cycles reject atomically and only accepted review satisfies a prerequisite', t => {
  const f = fixture(t), parent = f.assign(), dependent = f.assign([parent.id]);
  assert.deepEqual(dependent.coordination!.dependencies, [{ taskId: parent.id, status: 'not_complete' }]);
  assert.throws(() => f.event(dependent, f.worker.agent, { type: 'accept' }), /prerequisite/);
  const before = f.hive.tasks.get(f.brain.agent, parent.id);
  assert.throws(() => f.event(parent, f.brain.agent, { type: 'revise', reason: 'cycle', worker: f.worker.agent.name,
    contract: { ...f.contract, dependencies: [dependent.id] } }), /dependency cycle/);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, parent.id), before);
  f.event(parent, f.brain.agent, claim());
  f.event(parent, f.worker.agent, { type: 'accept' });
  f.event(parent, f.worker.agent, { type: 'result', result: { summary: 'Not reviewed', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
  assert.throws(() => f.event(dependent, f.worker.agent, { type: 'accept' }), /prerequisite/);
  const reviewed = f.event(parent, f.brain.agent, { type: 'review', decision: 'accepted', summary: 'Inspected', evidenceSeqs: [] }).task;
  assert.equal(reviewed.claim!.state, 'released');
  f.event(dependent, f.worker.agent, { type: 'accept' });
  f.event(parent, f.brain.agent, { type: 'revise', reason: 'New contract', worker: f.worker.agent.name, contract: f.contract });
  assert.throws(() => f.event(dependent, f.worker.agent, { type: 'result', result: { summary: 'Old dependency', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } }), /prerequisite/);
  f.event(dependent, f.worker.agent, { type: 'block', needed: 'Prerequisite reopened' });
});

test('dependency views mask inaccessible prerequisite state and bound legacy graph traversal', t => {
  const f = fixture(t), privateTask = f.assign([], { channel: f.hive.channels.openDm(f.brain.agent, f.worker.agent.name).id });
  const dependent = f.assign([privateTask.id]);
  const otherView = f.hive.tasks.get(f.other.agent, dependent.id);
  assert.deepEqual(otherView.coordination!.dependencies, [{ taskId: privateTask.id, status: 'unavailable' }]);
  // Seed a legacy-only deep graph without recursively exercising assignment.
  let previous: string | undefined;
  for (let i = 0; i <= CLAIM_LIMITS.graph; i++) {
    const id = randomUUID(), snapshot = { ...dependent, id, contract: { ...f.contract, dependencies: previous ? [previous] : [] } };
    insertRow(f.hive, 'task_records', { id, channel_id: f.room.id, worker_id: f.worker.agent.id, dispatch_seq: 0,
      received_at: null, snapshot: JSON.stringify(snapshot) });
    previous = id;
  }
  assert.throws(() => f.assign([previous!]), /256-task validation budget/);
});

test('contract and worker revisions invalidate a held claim without silently releasing it', t => {
  const f = fixture(t), task = f.assign();
  const old = f.event(task, f.brain.agent, claim(['src'])).task.claim;
  const revised = f.event(task, f.brain.agent, { type: 'revise', reason: 'Changed acceptance', worker: f.worker.agent.name,
    contract: { ...f.contract, acceptanceCriteria: ['A different regression'] } }).task;
  assert.deepEqual(revised.claim, old); assert.equal(revised.coordination!.claim, 'uncertain');
  assert.throws(() => f.event(task, f.worker.agent, { type: 'accept' }), /uncertain/);
  assert.throws(() => f.event(task, f.brain.agent, { type: 'renew_claim', leaseSeconds: 60, overlapAcknowledgements: [] }), /unexpired/);
  f.event(task, f.brain.agent, { type: 'release_claim', reason: 'New contract will use plain coordination' });
  f.event(task, f.worker.agent, { type: 'accept' });
});

test('a newly introduced transitive cycle is rejected before the task or messages change', t => {
  const f = fixture(t), first = f.assign(), second = f.assign([first.id]), third = f.assign([second.id]);
  const before = f.hive.tasks.get(f.brain.agent, first.id);
  assert.throws(() => f.event(first, f.brain.agent, { type: 'revise', reason: 'Would close the cycle', worker: f.worker.agent.name,
    contract: { ...f.contract, dependencies: [third.id] } }), /dependency cycle/);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, first.id), before);
});

test('per-coordinator claim cap is independent of worker count', t => {
  const f = fixture(t); const tasks: TaskSnapshot[] = [];
  for (let i = 0; i <= CLAIM_LIMITS.coordinator; i++) {
    const worker = f.hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
    f.hive.channels.invite(f.brain.agent, f.room.id, [worker.name]);
    tasks.push(f.assign([], { worker: worker.name }));
  }
  for (const task of tasks.slice(0, CLAIM_LIMITS.coordinator)) f.event(task, f.brain.agent, claim());
  assert.throws(() => f.event(tasks.at(-1)!, f.brain.agent, claim()), status(429));
  // A different coordinator and worker retain their own allowance.
  f.event(tasks.at(-1)!, f.other.agent, claim());
});

test('project-wide cap includes invisible claims but never reveals their metadata', t => {
  const f = fixture(t), task = f.assign(), seed = f.assign();
  const privateChannel = f.hive.channels.openDm(f.brain.agent, f.worker.agent.name);
  for (let i = 0; i < CLAIM_LIMITS.project; i++) {
    const id = randomUUID();
    // A controlled legacy fixture exceeds neither the project cap nor parser limits.
    const snapshot = { ...seed, id, channelId: privateChannel.id, claim: {
      state: 'held', version: 1, coordinatorId: `historic-${i}`, coordinatorName: 'Private coordinator', workerId: `historic-worker-${i}`,
      contractVersion: 1, paths: ['private-intent'], overlapAcknowledgements: [], expiresAt: 1, updatedAt: 0,
    } };
    insertRow(f.hive, 'task_records', { id, channel_id: privateChannel.id, worker_id: f.worker.agent.id, dispatch_seq: 0, snapshot: JSON.stringify(snapshot) });
  }
  assert.throws(() => f.event(task, f.other.agent, claim()), error => {
    assert.ok(status(429)(error)); assert.ok(!String(error).includes('Private coordinator')); return true;
  });
  assert.deepEqual(f.hive.tasks.get(f.other.agent, task.id).coordination!.overlaps, []);
});

test('separate SQLite processes serialize the same claim revision with one explicit conflict', { timeout: 30000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const f = fixture(t), task = f.assign();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const file = path.join(f.hive.home, 'claim-child.mjs');
  writeFileSync(file, `import { Hive } from ${JSON.stringify(new URL('./hive.ts', import.meta.url).href)};
    let hive, pending;
    const finish = (message) => {
      hive?.db.close();
      process.send(message, () => process.disconnect());
    };
    process.on('message', (input) => {
      if (input?.type === 'init') {
        try {
          hive = new Hive(process.argv[2]);
          process.send({ phase: 'ready' });
        } catch (error) {
          finish({ phase: 'result', status: error.status ?? 500, error: String(error?.stack ?? error) });
        }
        return;
      }
      if (input?.type === 'arm') {
        try {
          pending = { actor: hive.identity.agentByToken(input.token), id: input.id, event: input.event };
          process.send({ phase: 'armed' });
        } catch (error) {
          finish({ phase: 'result', status: error.status ?? 500, error: String(error?.stack ?? error) });
        }
        return;
      }
      if (input?.type !== 'release' || !pending) return;
      process.send({ phase: 'claiming' }, () => {
        let status = 200, errorText;
        try { hive.tasks.event(pending.actor, pending.id, pending.event); }
        catch (error) { status = error.status ?? 500; errorText = String(error?.stack ?? error); }
        finish({ phase: 'result', status, error: errorText });
      });
    });`, { mode: 0o600 });

  type ChildMessage =
    | { phase: 'ready' }
    | { phase: 'armed' }
    | { phase: 'claiming' }
    | { phase: 'result'; status: number; error?: string };
  type ChildState = { phase: string; stderr: string };
  type MessageFor<P extends ChildMessage['phase']> = Extract<ChildMessage, { phase: P }>;

  const actors = [f.brain, f.other];
  const states: ChildState[] = [];
  const queues: ChildMessage[][] = [];
  const listeners: Array<Array<() => void>> = [];
  const exits: Array<ReturnType<typeof once>> = [];
  const children = actors.map((_, index) => {
    const child = spawn(process.execPath,
      ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), file, path.join(f.hive.home, 'hive.db')],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnv() });
    exits[index] = once(child, 'close');
    const state = { phase: 'spawned', stderr: '' };
    states[index] = state;
    queues[index] = [];
    listeners[index] = [];
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { state.stderr = (state.stderr + chunk).slice(-4000); });
    child.on('message', value => {
      if (typeof value !== 'object' || value === null || !('phase' in value)) return;
      const message = value as ChildMessage;
      state.phase = message.phase;
      queues[index]!.push(message);
      for (const listener of listeners[index]!.slice()) listener();
    });
    child.on('error', error => { state.phase = `process error: ${error.message}`; });
    return child;
  });

  const describe = (index: number) => {
    const state = states[index]!;
    const stderr = state.stderr.trim().replace(/\s+/g, ' ');
    return `child ${index} phase=${state.phase}${stderr ? ` stderr=${stderr}` : ''}`;
  };
  const waitForMessage = <P extends ChildMessage['phase']>(
    child: (typeof children)[number], index: number, phase: P, timeoutMs: number,
  ): Promise<MessageFor<P>> => new Promise((resolve, reject) => {
    const queue = queues[index]!;
    const pending = listeners[index]!;
    const take = () => {
      const position = queue.findIndex(message => message.phase === phase);
      if (position < 0) return false;
      const [message] = queue.splice(position, 1);
      cleanup();
      resolve(message as MessageFor<P>);
      return true;
    };
    const notify = () => { take(); };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`claim child ${index} exited while waiting for ${phase} (code=${code}, signal=${signal}); ${describe(index)}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`claim child ${index} timed out after ${timeoutMs}ms waiting for ${phase}; ${describe(index)}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      const listenerIndex = pending.indexOf(notify);
      if (listenerIndex >= 0) pending.splice(listenerIndex, 1);
      child.off('close', onClose);
    };
    if (take()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      reject(new Error(`claim child ${index} already exited while waiting for ${phase}; ${describe(index)}`));
      return;
    }
    pending.push(notify);
    child.once('close', onClose);
    take();
  });
  const send = (child: (typeof children)[number], index: number, message: object) =>
    new Promise<void>((resolve, reject) => {
      child.send(message, error => {
        if (error) reject(new Error(`claim child ${index} IPC send failed; ${describe(index)}: ${error.message}`));
        else resolve();
      });
    });

  try {
    // Schema/bootstrap writes are not the concurrency target of this test. Initialize
    // each process against the shared DB in sequence, then race only the claim event.
    for (const [index, child] of children.entries()) {
      const ready = waitForMessage(child, index, 'ready', 12000);
      await send(child, index, { type: 'init' });
      await ready;
    }

    const armed = children.map((child, index) => waitForMessage(child, index, 'armed', 3000));
    await Promise.all(children.map((child, index) => send(child, index, {
      type: 'arm',
      token: actors[index]!.token,
      id: task.id,
      event: { requestId: `process-${index}`, expectedRevision: 1, action: claim() },
    })));
    await Promise.all(armed);

    const claiming = children.map((child, index) => waitForMessage(child, index, 'claiming', 3000));
    const responses = children.map((child, index) => waitForMessage(child, index, 'result', 8000));
    await Promise.all(children.map((child, index) => send(child, index, { type: 'release' })));
    await Promise.all(claiming);
    const results = await Promise.all(responses);

    const diagnostics = results.map((result, index) =>
      `child ${index}: status=${result.status}${result.error ? ` error=${result.error}` : ''}`).join('\n');
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409],
      `Expected exactly one successful claim and one explicit conflict.\n${diagnostics}`);
    await Promise.all(exits);
    assert.equal(f.hive.tasks.get(f.brain.agent, task.id).revision, 2);
  } finally {
    for (const [index, child] of children.entries()) {
      if (child.exitCode === null && child.signalCode === null) {
        states[index]!.phase = `${states[index]!.phase} -> stopped by parent`;
      }
    }
    await Promise.allSettled(children.map(child => stopChild(child)));
    await Promise.allSettled(exits);
  }
});


test('read-only claim preview explains current visible conflicts without reserving or disclosing private work', t => {
  const f = fixture(t), one = f.assign(), two = f.assign();
  f.event(one, f.brain.agent, claim(['src/parser']));
  const before = countRows(f.hive, 'messages');
  const preview = f.hive.tasks.previewClaim(f.other.agent, two.id, { paths: ['src/parser/index.ts'] });
  assert.equal(preview.revision, 1); assert.equal(preview.overlaps[0]?.taskId, one.id);
  assert.equal(preview.overlaps[0]?.claimVersion, 1); assert.equal(preview.truncated, false);
  assert.equal(countRows(f.hive, 'messages'), before);
  assert.equal(f.hive.tasks.get(f.brain.agent, two.id).claim, undefined);
  assert.throws(() => f.hive.tasks.previewClaim(f.worker.agent, two.id, { paths: [] }), status(403));
  assert.throws(() => f.hive.tasks.previewClaim(f.brain.agent, two.id, { paths: ['../secret'] }), status(400));
  removeChannelMember(f.hive, f.room.id, f.other.agent.id);
  assert.throws(() => f.hive.tasks.previewClaim(f.other.agent, two.id, { paths: ['src'] }), status(403));
});
