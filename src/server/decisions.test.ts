import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { HiveError } from '../shared/types.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-decisions-')), file = path.join(dir, 'hive.db');
  let hive = new Hive(file), serial = 0;
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain' }), otherBrain = hive.identity.join({ role: 'brain' });
  const a = hive.identity.join({ role: 'worker', seniority: 'mid' }), b = hive.identity.join({ role: 'worker', seniority: 'senior' });
  const room = hive.channels.createChannel(brain.agent, { name: 'decision-fixture', type: 'private',
    memberNames: [a.agent.name, b.agent.name, otherBrain.agent.name] });
  const task = hive.tasks.assign(brain.agent, { requestId: 'task', worker: a.agent.name, channel: room.id,
    contract: { objective: 'Choose a parser boundary', scope: ['src/parser'], nonGoals: [],
      acceptanceCriteria: ['Human decision recorded'], dependencies: [], evidenceSeqs: [] } }).task;
  const input = (extra = {}) => ({ requestId: `decision-${++serial}`, taskId: task.id,
    expectedTaskRevision: hive.tasks.get(brain.agent, task.id).revision, question: 'Which compatibility boundary should we keep?',
    options: [{ id: 'strict', label: 'Strict', impact: 'Reject old payloads' }, { id: 'compat', label: 'Compatible', impact: 'Keep old payloads' }],
    recommendation: { optionId: 'compat', rationale: 'Lower migration risk', uncertainty: 'Medium: production distribution is not measured' },
    evidenceSeqs: [], artifacts: ['src/parser.ts'], affectedWorkers: [a.agent.name, b.agent.name],
    relatedDecisionIds: [], ...extra });
  return { get hive() { return hive; }, human, brain, otherBrain, a, b, room, task, input,
    reopen() { hive.db.close(); hive = new Hive(file); } };
}
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

test('brain decision request is versioned, idempotent, inspectable and cannot mutate task authority', t => {
  const f = fixture(t), before = f.hive.tasks.get(f.brain.agent, f.task.id), raw = f.input({ requestId: 'stable-decision' });
  const first = f.hive.decisions.create(f.brain.agent, raw), replay = f.hive.decisions.create(f.brain.agent, raw);
  assert.equal(replay.duplicate, true); assert.equal(replay.decision.id, first.decision.id); assert.equal(replay.message.id, first.message.id);
  assert.equal(first.decision.state, 'awaiting_input'); assert.equal(first.decision.taskRevision, before.revision);
  assert.deepEqual(first.decision.affectedWorkers.map(worker => worker.name), [f.a.agent.name, f.b.agent.name]);
  assert.match(first.message.body, /Uncertainty:/); assert.match(first.message.body, /never authorizes/);
  assert.deepEqual(f.hive.tasks.get(f.brain.agent, f.task.id), before);
  assert.throws(() => f.hive.decisions.create(f.a.agent, f.input()), status(403));
  assert.throws(() => f.hive.decisions.create(f.otherBrain.agent, f.input()), status(403));
  assert.throws(() => f.hive.decisions.create(f.brain.agent, { ...raw, question: 'Changed?' }), status(409));
});

test('schema rejects one-option menus, forged recommendations and inaccessible workers/evidence', t => {
  const f = fixture(t);
  assert.throws(() => f.hive.decisions.create(f.brain.agent, f.input({ options: [{ id: 'only', label: 'Only', impact: 'No comparison' }] })), status(400));
  assert.throws(() => f.hive.decisions.create(f.brain.agent, f.input({ recommendation: { optionId: 'missing', rationale: 'Nope', uncertainty: 'unknown' } })), status(400));
  const outsider = f.hive.identity.join({ role: 'worker', seniority: 'mid' });
  const privateNotes = f.hive.channels.createChannel(f.otherBrain.agent, { name: 'private-decision-evidence', type: 'private' });
  const secret = f.hive.messages.postMessage(f.otherBrain.agent, { channel: privateNotes.id, body: 'secret evidence' });
  assert.throws(() => f.hive.decisions.create(f.brain.agent, f.input({ affectedWorkers: [outsider.agent.name] })), /task-channel access/);
  assert.throws(() => f.hive.decisions.create(f.brain.agent, f.input({ evidenceSeqs: [secret.seq] })), /Cannot read/);
});

test('Human UI answer is applied once, routes to requester and affected workers, and exposes receipt stages', async t => {
  const f = fixture(t), made = f.hive.decisions.create(f.brain.agent, f.input());
  const answer = f.hive.decisions.answer(f.human, made.decision.id,
    { requestId: 'answer-once', expectedRevision: made.decision.revision, body: 'Choose compatible mode; preserve the legacy payload for this revision.' });
  assert.equal(answer.decision.state, 'answered'); assert.equal(answer.decision.answer?.source, 'hive');
  assert.ok(answer.message); const answerMessage = answer.message;
  assert.deepEqual(new Set(answerMessage.recipientIds), new Set([f.brain.agent.id, f.a.agent.id, f.b.agent.id]));
  assert.deepEqual(f.hive.decisions.answer(f.human, made.decision.id,
    { requestId: 'answer-once', expectedRevision: made.decision.revision, body: 'Choose compatible mode; preserve the legacy payload for this revision.' }).message?.id, answerMessage.id);
  assert.ok(answer.decision.delivery.every(item => item.state === 'pending'));
  const session = f.hive.delivery.openInboxSession(f.a.agent, crypto.randomUUID());
  const offered = await f.hive.delivery.wait(f.a.agent, 1, undefined, { sessionId: session, compact: true });
  assert.ok(offered.delivery?.messageSeqs.includes(answerMessage.seq));
  assert.equal(f.hive.decisions.get(f.human, made.decision.id).delivery.find(item => item.agentId === f.a.agent.id)?.state, 'offered');
  f.hive.delivery.acknowledgeInbox(f.a.agent, session, offered.delivery!.id);
  assert.equal(f.hive.decisions.get(f.human, made.decision.id).delivery.find(item => item.agentId === f.a.agent.id)?.state, 'acknowledged');
});

test('a Telegram-origin Human reply to the decision root answers the same request', t => {
  const f = fixture(t), made = f.hive.decisions.create(f.brain.agent, f.input());
  const message = f.hive.messages.postMessage(f.human, { channel: made.decision.channelId, threadId: made.decision.id,
    body: 'Telegram answer: strict mode for this task revision.', source: 'telegram' });
  const decision = f.hive.decisions.get(f.human, made.decision.id);
  assert.equal(decision.state, 'answered'); assert.equal(decision.answer?.messageId, message.id);
  assert.equal(decision.answer?.source, 'telegram');
  assert.deepEqual(new Set(message.recipientIds), new Set([f.brain.agent.id, f.a.agent.id, f.b.agent.id]));
});

test('task revisions and deadlines fail closed without auto-applying a recommendation', t => {
  const f = fixture(t), made = f.hive.decisions.create(f.brain.agent, f.input());
  f.hive.tasks.event(f.brain.agent, f.task.id, { requestId: 'revise-task', expectedRevision: f.task.revision,
    action: { type: 'revise', reason: 'New Human-visible scope', worker: f.a.agent.name, contract: f.task.contract } });
  const stale = f.hive.decisions.get(f.human, made.decision.id);
  assert.equal(stale.state, 'superseded'); assert.equal(stale.staleReason, 'task_changed'); assert.equal(stale.answer, null);
  assert.throws(() => f.hive.decisions.answer(f.human, made.decision.id,
    { requestId: 'stale-answer', expectedRevision: stale.revision, body: 'Do not apply' }), status(409));
  f.hive.messages.postMessage(f.human, { channel: stale.channelId, threadId: stale.id, body: 'Free-text stale follow-up remains history.' });
  assert.equal(f.hive.decisions.get(f.human, stale.id).answer, null);

  const current = f.hive.tasks.get(f.brain.agent, f.task.id);
  const expired = f.hive.decisions.create(f.brain.agent, f.input({ expectedTaskRevision: current.revision,
    requestId: 'expired', requestedByAt: Date.now() - 1 })).decision;
  assert.equal(expired.state, 'expired'); assert.equal(expired.answer, null);
  assert.equal(f.hive.tasks.get(f.brain.agent, f.task.id).revision, current.revision);
});

test('withdrawal, explicit supersession, related links and restart preserve distinct decision history', t => {
  const f = fixture(t), one = f.hive.decisions.create(f.brain.agent, f.input({ requestId: 'one' })).decision;
  const related = f.hive.decisions.create(f.brain.agent, f.input({ requestId: 'related', relatedDecisionIds: [one.id] })).decision;
  assert.deepEqual(related.relatedDecisionIds, [one.id]);
  const withdrawn = f.hive.decisions.event(f.brain.agent, related.id, { requestId: 'withdraw', expectedRevision: related.revision,
    action: { type: 'withdraw', reason: 'No longer needed' } }).decision;
  assert.equal(withdrawn.state, 'withdrawn');
  const replacement = f.hive.decisions.create(f.brain.agent, f.input({ requestId: 'replacement', supersedesDecisionId: one.id })).decision;
  assert.equal(f.hive.decisions.get(f.human, one.id).state, 'superseded');
  assert.equal(f.hive.decisions.get(f.human, one.id).supersededByDecisionId, replacement.id);
  f.reopen();
  const page = f.hive.decisions.listHuman(f.human, f.room.projectId);
  assert.ok(page.items.some(item => item.id === replacement.id));
  assert.ok(page.items.some(item => item.id === one.id && item.state === 'superseded'));
  assert.equal(page.awaiting, 1);
});


test('old awaiting decisions stay visible ahead of more than 100 newer closed requests', t => {
  const f = fixture(t);
  const oldest = f.hive.decisions.create(f.brain.agent, f.input({ requestId: 'oldest-open' })).decision;
  for (let index = 0; index < 105; index++) {
    const made = f.hive.decisions.create(f.brain.agent, f.input({ requestId: `closed-${index}` })).decision;
    f.hive.decisions.answer(f.human, made.id, {
      requestId: `answer-${index}`, expectedRevision: made.revision, body: `Closed answer ${index}`,
    });
  }
  const page = f.hive.decisions.listHuman(f.human, f.room.projectId);
  assert.equal(page.awaiting, 1);
  assert.equal(page.items.length, 100);
  assert.equal(page.items[0]?.id, oldest.id);
  assert.equal(page.items[0]?.state, 'awaiting_input');
  const openOnly = f.hive.decisions.listHuman(f.human, f.room.projectId, false);
  assert.deepEqual(openOnly.items.map(item => item.id), [oldest.id]);
});

test('decision requests and their answers are For you: Unread until read, Activity for good', t => {
  const f = fixture(t), made = f.hive.decisions.create(f.brain.agent, f.input());
  const feed = (unreadOnly: boolean) => f.hive.reads.activity(f.human, { projectId: f.room.projectId, unreadOnly, reasons: ['decision'] })
    .items.map(item => [item.message.id, item.read]);
  assert.deepEqual(feed(true), [[made.message.id, false]]);
  const answer = f.hive.decisions.answer(f.human, made.decision.id,
    { requestId: 'answer-for-you', expectedRevision: made.decision.revision, body: 'Keep the compatible boundary.' });
  const followUp = f.hive.messages.postMessage(f.brain.agent, { channel: f.room.id, threadId: made.decision.id, body: 'Applying it now.' });
  assert.deepEqual(feed(true), [[followUp.id, false], [made.message.id, false]], 'the Human’s own answer is never unread');
  assert.deepEqual(feed(false), [[followUp.id, false], [answer.message!.id, true], [made.message.id, false]]);
  assert.equal(f.hive.reads.readSnapshot(f.human).mentionCounts[f.room.project], 2);
  // A structured task event is For you when it is addressed to you (here: the assigned worker).
  assert.deepEqual(f.hive.reads.activity(f.a.agent, { reasons: ['task'] }).items.map(item => item.message.id), [f.task.id]);
  assert.deepEqual(f.hive.reads.activity(f.b.agent, { reasons: ['task'] }).items, []);
});
