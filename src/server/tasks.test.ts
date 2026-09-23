import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { InboxDeliveryStore } from './inbox-delivery.ts';
import { waitWireBytes } from './wait-format.ts';
import { WAIT_MAX_BYTES, type Agent } from '../shared/types.ts';
import type { TaskAction, TaskSnapshot } from '../shared/tasks.ts';
import { countRows, countTables, failWrites, findRow, inboxCursor, listRows, markInboxRead, removeChannelMember, seedAgedInboxReceipts, type FailureOptions } from './test-fixtures.ts';

const contract = () => ({ objective: 'Add a parser for the fixture format', scope: ['parser and focused tests'],
  nonGoals: ['No deployment'], acceptanceCriteria: ['Existing inputs still parse'], dependencies: [],
  worktree: 'worktrees/parser', branch: 'feature/parser', evidenceSeqs: [] });
const result = () => ({ summary: 'Parser implemented', artifacts: ['src/parser.ts'], checks: [
  { name: 'parser tests', outcome: 'passed' as const, evidenceSeqs: [] }], gaps: ['No production evaluation'], evidenceSeqs: [] });
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-tasks-'));
  const file = path.join(dir, 'hive.db'); let hive = new Hive(file); let n = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: 'brain' }), worker = hive.join({ role: 'worker', seniority: 'mid' });
  const assign = (extra = {}) => hive.tasks.assign(brain.agent, { requestId: `a-${++n}`, worker: worker.agent.name, contract: contract(), ...extra });
  const event = (id: string, actor: Agent, action: TaskAction, extra = {}) => hive.tasks.event(actor, id,
    { requestId: `e-${++n}`, expectedRevision: hive.tasks.get(actor, id).revision, action, ...extra });
  return { get hive() { return hive; }, brain, worker, assign, event,
    reopen() { hive.db.close(); hive = new Hive(file); } };
}

test('task receipt, acceptance, result and assigning-brain review are distinct', async t => {
  const f = fixture(t); const sent = f.assign(); const id = sent.task.id;
  assert.equal(sent.task.state, 'sent'); assert.equal(sent.message.threadId, null);
  const sessionId = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  const batch = await f.hive.wait(f.worker.agent, 1, undefined, { sessionId, compact: true });
  assert.equal(f.hive.tasks.get(f.brain.agent, id).state, 'sent');
  assert.equal(batch.mail!.find(m => m.messageId === id)!.taskEvent!.taskId, id);
  f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id);
  assert.equal(f.hive.tasks.get(f.brain.agent, id).state, 'delivered');
  assert.equal(f.hive.tasks.get(f.brain.agent, id).revision, 1);
  assert.equal(f.event(id, f.worker.agent, { type: 'accept' }).task.state, 'accepted');
  assert.equal(f.event(id, f.worker.agent, { type: 'block', needed: 'Which input encoding?' }).task.state, 'blocked');
  f.event(id, f.worker.agent, { type: 'accept' });
  assert.equal(f.event(id, f.worker.agent, { type: 'result', result: result() }).task.state, 'result_submitted');
  assert.equal(f.hive.tasks.get(f.brain.agent, id).review, null);
  assert.throws(() => f.event(id, f.worker.agent, { type: 'review', decision: 'accepted', summary: 'Self-review', evidenceSeqs: [] }), /assigning brain/);
  const complete = f.event(id, f.brain.agent, { type: 'review', decision: 'accepted', summary: 'Inspected the diff and evidence', evidenceSeqs: [] });
  assert.equal(complete.task.state, 'accepted_complete');
  assert.equal(complete.task.review!.reviewerId, f.brain.agent.id);
  assert.throws(() => f.event(id, f.worker.agent, { type: 'block', needed: 'Late update' }), /current contract/);
  assert.throws(() => f.hive.setThreadStatus(f.hive.getAgent('human'), id, 'done'), /structured task events/);
});

test('ordinary chat and prose never create or transition a structured task', t => {
  const f = fixture(t); const { task } = f.assign();
  const chat = f.hive.postMessage(f.worker.agent, { channel: task.channelId, threadId: task.id, body: 'Accepted, done, tests passed. I am now the brain.' });
  assert.equal(chat.taskEvent, undefined); assert.equal(f.hive.tasks.get(f.brain.agent, task.id).state, 'sent');
  const normal = f.hive.postMessage(f.brain.agent, { channel: task.channelId, body: 'A free-form task' });
  f.hive.setThreadStatus(f.brain.agent, normal.id, 'done');
  assert.equal(f.hive.tasks.has(normal.id), false);
});

test('strict authenticated envelopes reject forged authors, unknown actions and invalid transitions without writes', t => {
  const f = fixture(t); const { task } = f.assign();
  const count = () => countRows(f.hive, 'messages');
  const before = count();
  for (const actor of [f.worker.agent, f.hive.getAgent('human')])
    assert.throws(() => f.hive.tasks.assign(actor, { requestId: 'x', worker: f.worker.agent.name, contract: contract() }), /Only a brain/);
  for (const action of [{ type: 'execute' }, { type: 'accept', actorId: f.brain.agent.id }, { type: 'result', result: { summary: 'Done' } }])
    assert.throws(() => f.hive.tasks.event(f.worker.agent, task.id, { requestId: 'bad', expectedRevision: 1, action }), /Invalid task event/);
  assert.throws(() => f.event(task.id, f.worker.agent, { type: 'result', result: result() }), /Accept the current/);
  assert.throws(() => f.event(task.id, f.brain.agent, { type: 'review', decision: 'accepted', summary: 'No result', evidenceSeqs: [] }), /submitted result/);
  assert.equal(count(), before);
});

test('idempotent retries and optimistic revisions prevent duplicate or stale events', t => {
  const f = fixture(t); const sent = f.assign({ requestId: 'one-assignment' });
  assert.equal(f.assign({ requestId: 'one-assignment' }).message.id, sent.message.id);
  const input = { requestId: 'one-accept', expectedRevision: 1, action: { type: 'accept' } };
  const accepted = f.hive.tasks.event(f.worker.agent, sent.task.id, input);
  assert.equal(f.hive.tasks.event(f.worker.agent, sent.task.id, input).message.id, accepted.message.id);
  assert.throws(() => f.hive.tasks.event(f.worker.agent, sent.task.id, { ...input, action: { type: 'block', needed: 'changed' } }), /already used/);
  assert.throws(() => f.hive.tasks.event(f.worker.agent, sent.task.id, { ...input, requestId: 'stale' }), /Task changed/);
  f.reopen();
  assert.equal(f.hive.tasks.event(f.worker.agent, sent.task.id, input).duplicate, true);
  assert.equal(f.hive.tasks.get(f.brain.agent, sent.task.id).revision, 2);
});

test('reassignment is versioned, resets receipt/acceptance and informs the old worker', async t => {
  const f = fixture(t); const second = f.hive.join({ role: 'worker', seniority: 'mid' }).agent;
  const room = f.hive.createChannel(f.brain.agent, { name: 'task-room', type: 'private', memberNames: [f.worker.agent.name, second.name] });
  const initial = f.assign({ channel: room.id }); const id = initial.task.id;
  const sessionId = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  const oldDelivery = await f.hive.wait(f.worker.agent, 1, undefined, { sessionId, compact: true });
  const revised = f.event(id, f.brain.agent, { type: 'revise', worker: second.name, reason: 'Different availability', contract: { ...contract(), acceptanceCriteria: ['Also handle empty input'] } });
  assert.equal(revised.task.contractVersion, 2); assert.equal(revised.task.workerId, second.id);
  assert.ok(revised.message.mentions.includes(f.worker.agent.id)); assert.ok(revised.message.mentions.includes(second.id));
  f.hive.acknowledgeInbox(f.worker.agent, sessionId, oldDelivery.delivery!.id);
  const oldCount = f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages;
  assert.equal(oldCount, oldDelivery.delivery!.messageSeqs.length);
  assert.equal(f.hive.acknowledgeInbox(f.worker.agent, sessionId, oldDelivery.delivery!.id).duplicate, true);
  assert.equal(f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages, oldCount);
  assert.equal(f.hive.tasks.get(f.brain.agent, id).receivedAt, null);
  assert.throws(() => f.event(id, f.worker.agent, { type: 'accept' }), /assigned worker/);
  const newSession = f.hive.openInboxSession(second, crypto.randomUUID());
  const newDelivery = await f.hive.wait(second, 1, undefined, { sessionId: newSession, compact: true });
  f.hive.acknowledgeInbox(second, newSession, newDelivery.delivery!.id);
  assert.equal(f.hive.tasks.get(f.brain.agent, id).state, 'delivered');
  assert.equal(f.hive.inbox.status(second.id).acknowledgedMessages, newDelivery.delivery!.messageSeqs.length);
  assert.equal(f.event(id, second, { type: 'accept' }).task.state, 'accepted');
  f.reopen();
  assert.equal(f.hive.tasks.get(f.brain.agent, id).contract.acceptanceCriteria[0], 'Also handle empty input');
});

test('revision after completion explicitly reopens the contract and clears the previous result', t => {
  const f = fixture(t); const id = f.assign().task.id;
  f.event(id, f.worker.agent, { type: 'accept' });
  f.event(id, f.worker.agent, { type: 'result', result: result() });
  f.event(id, f.brain.agent, { type: 'review', decision: 'changes_requested', summary: 'Add one regression', evidenceSeqs: [] });
  assert.equal(f.hive.tasks.get(f.worker.agent, id).state, 'changes_requested');
  f.event(id, f.worker.agent, { type: 'result', result: result() });
  f.event(id, f.brain.agent, { type: 'review', decision: 'accepted', summary: 'Reviewed', evidenceSeqs: [] });
  const next = f.event(id, f.brain.agent, { type: 'revise', worker: f.worker.agent.name, reason: 'Extend scope', contract: contract() });
  assert.equal(next.task.state, 'sent'); assert.equal(next.task.result, null); assert.equal(next.task.review, null);
  assert.throws(() => f.event(id, f.worker.agent, { type: 'result', result: result() }), /Accept/);
});

test('project/access boundaries and evidence are checked before creating a task', t => {
  const f = fixture(t); const outsider = f.hive.join({ role: 'brain' }).agent;
  const task = f.assign().task;
  assert.throws(() => f.hive.tasks.get(outsider, task.id), /Cannot read/);
  const otherProject = f.hive.createProject(f.hive.getAgent('human'), { name: 'Other', slug: 'other' });
  const other = f.hive.join({ role: 'worker', seniority: 'mid', project: otherProject.slug }).agent;
  assert.throws(() => f.assign({ worker: other.name }), /your project/);
  const room = f.hive.createChannel(f.brain.agent, { name: 'brain-notes', type: 'private' });
  const evidence = f.hive.postMessage(f.brain.agent, { channel: room.id, body: 'Evidence not shared with the worker' });
  assert.throws(() => f.assign({ contract: { ...contract(), evidenceSeqs: [evidence.seq] } }), /Cannot read/);
  assert.throws(() => f.assign({ contract: { ...contract(), dependencies: [crypto.randomUUID()] } }), /Task not found/);
  for (const worktree of ['/absolute/path', '../outside', 'C:\\outside', '~/private'])
    assert.throws(() => f.assign({ contract: { ...contract(), worktree } }), /Invalid task assignment/);
  removeChannelMember(f.hive, task.channelId, f.worker.agent.id);
  assert.throws(() => f.hive.tasks.get(f.worker.agent, task.id), /Cannot read/);
});

for (const source of ['private', 'brains'] as const) {
  test(`HTTP changes-requested review rejects ${source} evidence atomically and accepts a shared alternative`, async t => {
    const f = fixture(t); const task = f.assign().task;
    f.event(task.id, f.worker.agent, { type: 'accept' });
    f.event(task.id, f.worker.agent, { type: 'result', result: result() });
    const notes = source === 'brains' ? f.hive.getChannel('brains', f.brain.agent.projectId) :
      f.hive.createChannel(f.brain.agent, { name: 'private-review-notes', type: 'private' });
    const privateEvidence = f.hive.postMessage(f.brain.agent, { channel: notes.id, body: 'Invented private review detail' });
    const shared = f.hive.createChannel(f.brain.agent, { name: 'shared-review-evidence', type: 'private', memberNames: [f.worker.agent.name] });
    const evidence = f.hive.postMessage(f.brain.agent, { channel: shared.id, body: 'Shared parser regression fixture' });
    const before = f.hive.tasks.get(f.brain.agent, task.id);
    const counts = () => countTables(f.hive, ['messages', 'task_events']);
    const beforeCounts = counts();
    const membership = () => listRows(f.hive, 'channel_members', { orderBy: ['channel_id', 'agent_id'] });
    const beforeMembership = membership();
    const notifications: string[] = [];
    for (const name of ['message', 'task', 'channel', 'queued'] as const) f.hive.bus.on(name, () => notifications.push(name));
    const input = { requestId: 'review-evidence', expectedRevision: before.revision,
      action: { type: 'review', decision: 'changes_requested', summary: 'Add a parser regression', evidenceSeqs: [evidence.seq, privateEvidence.seq] } };
    const app = createApp(f.hive);
    const response = await app.request(`/api/agent/tasks/${task.id}/events`, { method: 'POST',
      headers: { authorization: `Bearer ${f.brain.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 403);
    const error = await response.json() as { error: string };
    assert.match(error.error, /assigned worker.*shared channel/);
    assert.ok(!error.error.includes(privateEvidence.body));
    assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), before);
    assert.deepEqual(counts(), beforeCounts);
    assert.deepEqual(membership(), beforeMembership);
    assert.deepEqual(notifications, []);
    assert.throws(() => f.hive.getVisibleMessage(f.worker.agent, privateEvidence.seq), /Cannot read/);

    // A definitively rejected request did not reserve its ID or publish a review.
    const corrected = { ...input, action: { ...input.action, evidenceSeqs: [evidence.seq] } };
    const reviewed = f.hive.tasks.event(f.brain.agent, task.id, corrected);
    assert.equal(reviewed.task.state, 'changes_requested');
    assert.equal(reviewed.task.revision, before.revision + 1);
    assert.ok(reviewed.message.mentions.includes(f.worker.agent.id));
    assert.equal(f.hive.getVisibleMessage(f.worker.agent, evidence.seq).body, evidence.body);
    assert.deepEqual(membership(), beforeMembership, 'Review must never grant channel access');

    // Access is checked at submission, not granted by a reference or rechecked on a committed retry.
    removeChannelMember(f.hive, shared.id, f.worker.agent.id);
    f.reopen();
    const afterCounts = counts();
    const retry = f.hive.tasks.event(f.brain.agent, task.id, corrected);
    assert.equal(retry.duplicate, true); assert.equal(retry.message.id, reviewed.message.id);
    assert.deepEqual(counts(), afterCounts);
    assert.throws(() => f.hive.getVisibleMessage(f.worker.agent, evidence.seq), /Cannot read/);
  });
}

test('changes-requested evidence is checked against the current worker after reassignment', t => {
  const f = fixture(t); const next = f.hive.join({ role: 'worker', seniority: 'mid' }).agent;
  const room = f.hive.createChannel(f.brain.agent, { name: 'shared-task', type: 'private', memberNames: [f.worker.agent.name, next.name] });
  const task = f.assign({ channel: room.id }).task;
  f.event(task.id, f.brain.agent, { type: 'revise', worker: next.name, reason: 'Hand off the fixture', contract: contract() });
  f.event(task.id, next, { type: 'accept' });
  f.event(task.id, next, { type: 'result', result: result() });
  const oldDm = f.hive.openDm(f.brain.agent, f.worker.agent.name);
  const oldEvidence = f.hive.postMessage(f.brain.agent, { channel: oldDm.id, body: 'Only shared with the previous worker' });
  assert.equal(f.hive.getVisibleMessage(f.worker.agent, oldEvidence.seq).seq, oldEvidence.seq);
  assert.throws(() => f.event(task.id, f.brain.agent, { type: 'review', decision: 'changes_requested',
    summary: 'Use the regression', evidenceSeqs: [oldEvidence.seq] }), /assigned worker.*shared channel/);
  const newDm = f.hive.openDm(f.brain.agent, next.name);
  const evidence = f.hive.postMessage(f.brain.agent, { channel: newDm.id, body: 'Evidence shared with the current worker' });
  assert.throws(() => f.hive.getVisibleMessage(f.worker.agent, evidence.seq), /Cannot read/);
  assert.equal(f.event(task.id, f.brain.agent, { type: 'review', decision: 'changes_requested',
    summary: 'Use the shared regression', evidenceSeqs: [evidence.seq] }).task.state, 'changes_requested');
});

test('accepted review evidence remains reviewer-visible and grants no worker access', t => {
  const f = fixture(t); const task = f.assign().task;
  f.event(task.id, f.worker.agent, { type: 'accept' });
  f.event(task.id, f.worker.agent, { type: 'result', result: result() });
  const notes = f.hive.createChannel(f.brain.agent, { name: 'acceptance-notes', type: 'private' });
  const evidence = f.hive.postMessage(f.brain.agent, { channel: notes.id, body: 'Private record of reviewer checks' });
  const review = f.event(task.id, f.brain.agent, { type: 'review', decision: 'accepted', summary: 'Reviewed', evidenceSeqs: [evidence.seq] });
  assert.equal(review.task.state, 'accepted_complete');
  assert.throws(() => f.hive.getVisibleMessage(f.worker.agent, evidence.seq), /Cannot read/);
});

test('assignment failure rolls back the message, task, DM and all notifications', t => {
  const f = fixture(t); const events: string[] = [];
  for (const name of ['message', 'channel', 'task'] as const) f.hive.bus.on(name, () => events.push(name));
  const before = countRows(f.hive, 'messages');
  failWrites(f.hive, 'task_events', { message: 'fixture failure', persistent: true });
  assert.throws(() => f.assign(), /fixture failure/);
  assert.equal(f.hive.findDm(f.brain.agent.id, f.worker.agent.id), null);
  assert.equal(countRows(f.hive, 'messages'), before);
  assert.equal(countRows(f.hive, 'task_records'), 0);
  assert.deepEqual(events, []);
});

for (const historical of [0, 10_000]) test(`task receipt, cursor and totals roll back together with ${historical} old receipts`, async t => {
  const f = fixture(t);
  const sessionId = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  if (historical) {
    seedAgedInboxReceipts(f.hive, f.worker.agent.id, sessionId, historical);
    new InboxDeliveryStore(f.hive.db);
  }
  f.hive.db.function('json_array_length', () => { throw new Error('unexpected task-path aggregation'); });
  const task = f.assign().task;
  const batch = await f.hive.wait(f.worker.agent, 1, undefined, { compact: true, sessionId });
  const snapshot = () => ({
    status: f.hive.inbox.status(f.worker.agent.id),
    cursor: inboxCursor(f.hive, f.worker.agent.id),
    early: listRows(f.hive, 'inbox_early_receipts', { where: { agent_id: f.worker.agent.id } }),
    receipt: findRow(f.hive, 'inbox_deliveries', { id: batch.delivery!.id }),
    totals: findRow(f.hive, 'inbox_receipt_totals', { agent_id: f.worker.agent.id }),
    task: f.hive.tasks.get(f.brain.agent, task.id),
  });
  const before = snapshot();
  const events: unknown[] = [];
  f.hive.bus.on('task', e => events.push(e)); f.hive.bus.on('queued', e => events.push(e));
  const targets: [string, FailureOptions][] = [
    ['inbox_receipt_totals', { on: historical ? 'update' : 'insert' }], ['task_records', { on: 'update', timing: 'after' }]];
  for (const [table, target] of targets) {
    const restore = failWrites(f.hive, table, { ...target, message: 'receipt failure' });
    assert.throws(() => f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id), /receipt failure/);
    assert.deepEqual(snapshot(), before, 'receipt, cursor, sparse entries, totals and task must all roll back');
    assert.deepEqual(events, [], 'failed ACK must not publish changed state');
    restore();
  }
  f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id);
  const after = f.hive.tasks.get(f.brain.agent, task.id);
  assert.equal(after.state, 'delivered');
  assert.equal(f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages, historical + batch.delivery!.messageSeqs.length);
  assert.equal(f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id).duplicate, true);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), after);
  f.reopen();
  f.hive.db.function('json_array_length', () => { throw new Error('unexpected task restart aggregation'); });
  assert.equal(f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id).duplicate, true);
  assert.equal(f.hive.inbox.status(f.worker.agent.id).acknowledgedMessages, historical + batch.delivery!.messageSeqs.length);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, task.id), after);
});

test('confirming previously received mail after access revocation does not fail after commit', async t => {
  const f = fixture(t); const task = f.assign().task;
  const sessionId = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  const batch = await f.hive.wait(f.worker.agent, 1, undefined, { compact: true, sessionId });
  removeChannelMember(f.hive, task.channelId, f.worker.agent.id);
  const ack = f.hive.acknowledgeInbox(f.worker.agent, sessionId, batch.delivery!.id);
  assert.equal(ack.acknowledged, true);
  assert.equal(f.hive.tasks.get(f.brain.agent, task.id).state, 'delivered');
  assert.throws(() => f.hive.tasks.event(f.worker.agent, task.id, { requestId: 'after-revocation', expectedRevision: 1, action: { type: 'accept' } }), /Cannot read/);
});

test('structured actions stay full and canonical inside bounded compact batches', async t => {
  const f = fixture(t); const tasks = Array.from({ length: 20 }, () => f.assign().task);
  const room = f.hive.createChannel(f.brain.agent, { name: 'parallel', type: 'private', memberNames: [f.worker.agent.name] });
  f.hive.postMessage(f.worker.agent, { channel: room.id, body: 'Background', eventType: 'progress' });
  markInboxRead(f.hive, f.brain.agent.id);
  const expected = tasks.map(task => f.event(task.id, f.worker.agent, { type: 'accept' }).message);
  f.hive.postMessage(f.worker.agent, { channel: room.id, body: 'Background two', eventType: 'progress' });
  const seen: string[] = []; const sessionId = f.hive.openInboxSession(f.brain.agent, crypto.randomUUID());
  while (seen.length < expected.length) {
    const batch = await f.hive.wait(f.brain.agent, 1, undefined, { compact: true, sessionId });
    assert.ok(waitWireBytes(batch) <= WAIT_MAX_BYTES);
    for (const m of batch.mail ?? []) if (m.taskEvent) {
      assert.equal(m.expand, undefined); assert.ok(m.body); assert.equal(m.rootId, m.taskEvent.taskId); seen.push(m.messageId);
    }
    f.hive.acknowledgeInbox(f.brain.agent, sessionId, batch.delivery!.id);
  }
  assert.deepEqual(seen.sort(), expected.map(m => m.id).sort());
});

test('HTTP exposes authenticated tasks and read-only UI state; bots and forged fields are rejected', async t => {
  const f = fixture(t); const app = createApp(f.hive);
  const post = (url: string, token: string, body: unknown) => app.request(url, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/agent/tasks', f.worker.token, {})).status, 403);
  assert.equal((await post('/api/agent/tasks', f.brain.token, { requestId: 'forged', worker: f.worker.agent.name, contract: contract(), actorRole: 'brain' })).status, 400);
  const response = await post('/api/agent/tasks', f.brain.token, { requestId: 'http', worker: f.worker.agent.name, contract: contract() });
  assert.equal(response.status, 200); const { task } = await response.json() as { task: TaskSnapshot };
  const accepted = await post(`/api/agent/tasks/${task.id}/events`, f.worker.token, { requestId: 'http-accept', expectedRevision: 1, action: { type: 'accept' } });
  assert.equal(accepted.status, 200);
  const ui = await app.request(`/api/ui/channels/${task.channelId}/messages?threadId=${task.id}`);
  assert.equal(((await ui.json()) as { task: TaskSnapshot }).task.state, 'accepted');
  const bot = f.hive.createBot(f.hive.getAgent('human'), f.brain.agent.projectId!, { name: 'NonWorker' });
  assert.equal((await post('/api/agent/tasks', bot.token, {})).status, 403);
});

test('project deletion removes task events and snapshots', t => {
  const f = fixture(t); f.assign();
  f.hive.setOffline(f.brain.agent.id); f.hive.setOffline(f.worker.agent.id);
  f.hive.deleteProject(f.hive.getAgent('human'), f.brain.agent.project!);
  assert.equal(countRows(f.hive, 'task_records'), 0);
  assert.equal(countRows(f.hive, 'task_events'), 0);
});
