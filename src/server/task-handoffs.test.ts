import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { WAIT_MAX_BYTES, type Agent } from '../shared/types.ts';
import type { TaskAction, TaskCheckpointInput } from '../shared/tasks.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-handoffs-'));
  const file = path.join(dir, 'hive.db');
  let hive = new Hive(file), sequence = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: 'brain' }), worker = hive.join({ role: 'worker', seniority: 'mid' });
  const contract = { objective: 'Finish the parser', scope: ['parser'], nonGoals: ['No deployment'],
    acceptanceCriteria: ['A regression reproduces the bug'], dependencies: [], evidenceSeqs: [],
    worktree: 'worktrees/parser', branch: 'fix/parser' };
  const assign = (channel?: string) => hive.tasks.assign(brain.agent,
    { requestId: `assign-${++sequence}`, worker: worker.agent.name, contract, ...(channel ? { channel } : {}) });
  const event = (taskId: string, actor: Agent, action: TaskAction) => hive.tasks.event(actor, taskId,
    { requestId: `event-${++sequence}`, expectedRevision: hive.tasks.get(actor, taskId).revision, action });
  return { get hive() { return hive; }, brain, worker, contract, assign, event,
    reopen() { hive.db.close(); hive = new Hive(file); } };
}
const data = (): TaskCheckpointInput => ({ completedSteps: ['Reproduced failure'], unresolvedQuestions: ['Empty record semantics?'],
  nextAction: 'Ask the assigning brain before changing the parser', artifacts: ['tests/parser.test.ts'],
  checks: [{ name: 'regression', outcome: 'failed', evidenceSeqs: [] }], evidenceSeqs: [] });

test('checkpoints version and persist reports without accepting or completing work', t => {
  const f = fixture(t), task = f.assign().task;
  assert.equal(f.hive.tasks.handoff(f.worker.agent, task.id).freshness, 'missing');
  f.event(task.id, f.worker.agent, { type: 'accept' });
  const input = { requestId: 'checkpoint-stable', expectedRevision: 2,
    action: { type: 'checkpoint', checkpoint: data() } };
  const saved = f.hive.tasks.event(f.worker.agent, task.id, input);
  assert.equal(saved.task.state, 'accepted');
  assert.equal(saved.task.revision, 3);
  assert.equal(saved.task.contractVersion, 1);
  assert.equal(saved.task.checkpoint?.version, 1);
  assert.equal(saved.task.checkpoint?.objective, f.contract.objective);
  assert.equal(saved.task.checkpoint?.worktree, f.contract.worktree);
  assert.equal(saved.task.checkpoint?.messageSeq, saved.message.seq);
  assert.equal(saved.message.taskEvent?.checkpointVersion, 1);
  assert.equal(f.hive.tasks.event(f.worker.agent, task.id, input).message.id, saved.message.id);
  assert.throws(() => f.hive.tasks.event(f.worker.agent, task.id, { ...input,
    action: { type: 'checkpoint', checkpoint: { ...data(), nextAction: 'Changed intent' } } }), /already used/);
  assert.throws(() => f.hive.tasks.event(f.worker.agent, task.id, { ...input, requestId: 'stale' }), /Task changed/);
  f.event(task.id, f.worker.agent, { type: 'block', needed: 'A decision is pending' });
  assert.equal(f.hive.tasks.handoff(f.brain.agent, task.id).freshness, 'task_changed');
  const second = f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() });
  assert.equal(second.task.state, 'blocked');
  assert.equal(second.task.checkpoint?.version, 2);
  assert.equal(f.hive.tasks.handoff(f.worker.agent, task.id).freshness, 'current');
  f.reopen();
  const handoff = f.hive.tasks.handoff(f.worker.agent, task.id);
  assert.deepEqual(handoff.checkpoint?.data, data());
  assert.equal(handoff.checkpoint?.version, 2);
  assert.equal(handoff.newerMessages, false);
  assert.ok(handoff.ageMs !== null && handoff.ageMs >= 0);
  assert.match(handoff.warning, /unsaved work/);
  assert.ok(Buffer.byteLength(JSON.stringify(handoff)) < 32 * 1024);
  const checkpoints = f.hive.listMessages(f.worker.agent, task.channelId, { threadId: task.id }).messages
    .filter(message => message.taskEvent?.action.type === 'checkpoint');
  assert.deepEqual(checkpoints.map(message => message.taskEvent!.checkpointVersion), [1, 2]);
  assert.equal(f.hive.tasks.event(f.worker.agent, task.id, input).duplicate, true);
  assert.equal(f.hive.tasks.get(f.worker.agent, task.id).checkpoint?.version, 2);
  f.hive.postMessage(f.brain.agent, { channel: task.channelId, threadId: task.id, body: 'A later decision needs reconciliation' });
  assert.equal(f.hive.tasks.handoff(f.worker.agent, task.id).newerMessages, true);
});

test('a contract revision/reassignment retains but invalidates the old worker checkpoint', t => {
  const f = fixture(t), next = f.hive.join({ role: 'worker', seniority: 'senior' }).agent;
  const room = f.hive.createChannel(f.brain.agent, { name: 'handoff-room', type: 'private', memberNames: [f.worker.agent.name, next.name] });
  const task = f.assign(room.id).task;
  f.event(task.id, f.worker.agent, { type: 'accept' });
  const checkpoint = f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() }).task.checkpoint;
  f.event(task.id, f.brain.agent, { type: 'revise', reason: 'Explicit reassignment', worker: next.name,
    contract: { ...f.contract, objective: 'Handle the revised input format' } });
  const stale = f.hive.tasks.handoff(next, task.id);
  assert.equal(stale.freshness, 'contract_changed');
  assert.deepEqual(stale.checkpoint, checkpoint);
  assert.equal(stale.objective, 'Handle the revised input format');
  assert.equal(stale.checkpoint?.objective, 'Finish the parser');
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() }), /assigned worker/);
  f.event(task.id, next, { type: 'accept' });
  const fresh = f.event(task.id, next, { type: 'checkpoint', checkpoint: { ...data(), nextAction: 'Inspect revised inputs' } }).task;
  assert.equal(fresh.checkpoint?.version, 2);
  assert.equal(fresh.checkpoint?.workerId, next.id);
  assert.equal(fresh.checkpoint?.contractVersion, 2);
  assert.equal(f.hive.tasks.handoff(next, task.id).freshness, 'current');
});

test('checkpoint rollback includes snapshot, history and post-commit notifications', t => {
  const f = fixture(t), task = f.assign().task;
  f.event(task.id, f.worker.agent, { type: 'accept' });
  const before = f.hive.tasks.get(f.worker.agent, task.id);
  const count = () => f.hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n;
  const size = count(); let messages = 0, updates = 0;
  f.hive.bus.on('message', () => messages++); f.hive.bus.on('task', () => updates++);
  f.hive.db.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON task_events
    WHEN json_extract(NEW.envelope, '$.action.type') = 'checkpoint'
    BEGIN SELECT RAISE(ABORT, 'checkpoint fixture failure'); END`);
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() }), /fixture failure/);
  assert.deepEqual(f.hive.tasks.get(f.worker.agent, task.id), before);
  assert.equal(count(), size); assert.equal(messages, 0); assert.equal(updates, 0);
  f.hive.db.exec('DROP TRIGGER fail_checkpoint');
  f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() });
  assert.equal(messages, 1); assert.equal(updates, 1);
});

test('only the current accepted worker can save bounded checkpoint evidence', async t => {
  const f = fixture(t), task = f.assign().task;
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() }), /Accept the current/);
  f.event(task.id, f.worker.agent, { type: 'accept' });
  const other = f.hive.join({ role: 'brain' }).agent;
  const notes = f.hive.createChannel(other, { name: 'private-notes', type: 'private', memberNames: [f.worker.agent.name] });
  const secret = f.hive.postMessage(other, { channel: notes.id, body: 'private checkpoint evidence' });
  const before = f.hive.tasks.get(f.worker.agent, task.id);
  for (const actor of [f.brain.agent, other, f.hive.getAgent('human')])
    assert.throws(() => f.event(task.id, actor, { type: 'checkpoint', checkpoint: data() }));
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: { ...data(), evidenceSeqs: [secret.seq] } }), /Cannot/);
  for (const payload of [
    { ...data(), artifacts: ['../private'] },
    { ...data(), artifacts: ['https://user:secret@example.test/file'] },
    { ...data(), completedSteps: Array(9).fill('step') },
    { ...data(), workerId: other.id },
    { ...data(), nextAction: '' },
  ]) assert.throws(() => f.hive.tasks.event(f.worker.agent, task.id,
    { requestId: 'bad', expectedRevision: 2, action: { type: 'checkpoint', checkpoint: payload } }), /Invalid task event/);
  // Individually legal fields can still exceed the aggregate readable-message budget.
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: {
    ...data(), completedSteps: Array(8).fill('a'.repeat(240)), unresolvedQuestions: Array(8).fill('b'.repeat(240)),
    nextAction: 'c'.repeat(400) } }), /too large/);
  assert.deepEqual(f.hive.tasks.get(f.worker.agent, task.id), before);
  const app = createApp(f.hive);
  const response = await app.request(`/api/agent/tasks/${task.id}/events`, { method: 'POST',
    headers: { authorization: `Bearer ${f.worker.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'forged', expectedRevision: 2, authorId: f.brain.agent.id,
      action: { type: 'checkpoint', checkpoint: data() } }) });
  assert.equal(response.status, 400);
  assert.deepEqual(f.hive.tasks.get(f.worker.agent, task.id), before);
});

test('resume discovery pages unfinished authorized tasks and cannot enumerate other participants', t => {
  const f = fixture(t), all: string[] = [];
  for (let i = 0; i < 12; i++) all.push(f.assign().task.id);
  const hidden = f.assign(f.hive.createChannel(f.brain.agent,
    { name: 'removed-access', type: 'private', memberNames: [f.worker.agent.name] }).id).task;
  f.hive.db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?').run(hidden.channelId, f.worker.agent.id);
  const outsider = f.hive.join({ role: 'worker', seniority: 'mid' }).agent;
  assert.deepEqual(f.hive.tasks.handoffs(outsider).items, []);
  const visited: string[] = []; let before: string | undefined;
  do {
    const page = f.hive.tasks.handoffs(f.worker.agent, before);
    assert.ok(page.items.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32 * 1024);
    visited.push(...page.items.map(item => item.taskId));
    before = page.nextCursor ?? undefined;
    assert.equal(page.hasMore, Boolean(before));
  } while (before);
  assert.deepEqual(visited.sort(), all.sort());
  assert.equal(new Set(visited).size, all.length);
  assert.throws(() => f.hive.tasks.handoff(f.worker.agent, hidden.id), /Cannot read/);
  assert.throws(() => f.hive.tasks.handoffs(f.worker.agent, 'not-a-cursor'), /Invalid request/);
  const human = f.hive.getAgent('human');
  f.hive.createProject(human, { name: 'Beta', slug: 'beta' });
  const beta = f.hive.join({ role: 'brain', project: 'beta' }).agent;
  assert.deepEqual(f.hive.tasks.handoffs(beta).items, []);
  assert.throws(() => f.hive.tasks.handoff(beta, all[0]!), /Cannot read/);
});

test('checkpoint events remain recoverable inside bounded compact delivery; clear remains an instruction', async t => {
  const f = fixture(t), task = f.assign().task;
  f.event(task.id, f.worker.agent, { type: 'accept' });
  const checkpoint = f.event(task.id, f.worker.agent, { type: 'checkpoint', checkpoint: data() });
  const sessionId = f.hive.openInboxSession(f.brain.agent, crypto.randomUUID());
  const mail = await f.hive.wait(f.brain.agent, 1, undefined, { sessionId, compact: true });
  assert.ok(Buffer.byteLength(JSON.stringify(mail)) <= WAIT_MAX_BYTES);
  const entry = mail.mail!.find(item => item.messageId === checkpoint.message.id);
  assert.equal(entry?.taskEvent?.action.type, 'checkpoint');
  f.hive.acknowledgeInbox(f.brain.agent, sessionId, mail.delivery!.id);
  assert.equal(f.hive.tasks.handoff(f.brain.agent, task.id).checkpoint?.messageId, checkpoint.message.id);
  const control = f.hive.clearContext(f.brain.agent, f.worker.agent.name);
  assert.match(control.body, /save a checkpoint/);
  assert.match(control.body, /has not erased host context or stopped execution/);
  assert.match(control.body, /Do not clear automatically/);
  assert.equal(f.hive.tasks.get(f.worker.agent, task.id).state, 'accepted');
});
