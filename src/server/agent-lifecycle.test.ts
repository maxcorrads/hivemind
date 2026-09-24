import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { countRows, failWrites, insertRow, snapshotTables } from './test-fixtures.ts';
import { HiveError, type Message } from '../shared/types.ts';
import type { AdaptiveExecutionState, AdaptiveRoutingEvent } from '../shared/adaptive-topology.ts';

// #215: removing an agent leaves a tombstone. History stays readable and attributed; the agent can no longer act, be
// addressed or receive mail, and its open work is closed in the same transaction.
const contract = { objective: 'Ship the parser.', scope: [], nonGoals: [], acceptanceCriteria: ['Tests pass.'], dependencies: [], evidenceSeqs: [] };
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

function fixture(t: TestContext, options: { jev?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-agent-lifecycle-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const app = createApp(hive);
  if (options.jev) {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => Response.json(jevTopologyResponse(String(init?.body))));
    saveAdaptiveRouting(dir, { enabled: true, apiKey: 'fixture-key' });
  }
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain' }), other = hive.identity.join({ role: 'brain' });
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid' });
  const room = hive.channels.createChannel(brain.agent, { name: 'parser', type: 'private', memberNames: [worker.agent.name, other.agent.name] });
  const ui = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(`/api/ui${url}`, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  const remove = (name: string) => ui('DELETE', `/agents/${encodeURIComponent(name)}`);
  return { hive, app, human, brain, other, worker, room, ui, remove };
}

test('removing a brain keeps its history, closes its decision and Jev request, and its worker can still submit', async t => {
  const f = fixture(t, { jev: true });
  const { hive, brain, other, worker, room } = f;
  // A Jev request owned by the brain: Human mentions it in a room both brains share.
  const request = await f.ui('POST', `/channels/${room.id}/messages`, { body: `@${brain.agent.name} please plan the parser`, requestId: 'plan' });
  assert.equal(request.status, 200);
  const root = request.json.message as Message;
  const executions = () => hive.adaptiveTopology.store.rootedExecutions(root.id).map(row => JSON.parse(String(row.snapshot)) as AdaptiveExecutionState);
  assert.deepEqual(executions().map(state => state.brainId), [brain.agent.id], 'the request is recorded for its brain at once');
  // An open task and a pending decision request, and chat history.
  const task = hive.tasks.assign(brain.agent, { requestId: 'task', worker: worker.agent.name, channel: room.id, contract }).task;
  hive.tasks.event(worker.agent, task.id, { requestId: 'accept', expectedRevision: task.revision, action: { type: 'accept' } });
  const decision = hive.decisions.create(brain.agent, { requestId: 'decision', taskId: task.id,
    expectedTaskRevision: hive.tasks.get(brain.agent, task.id).revision, question: 'Which grammar?',
    options: [{ id: 'peg', label: 'PEG', impact: 'Rewrite' }, { id: 'lr', label: 'LR', impact: 'Keep' }],
    recommendation: { optionId: 'lr', rationale: 'Smaller change', uncertainty: 'Low' },
    evidenceSeqs: [], artifacts: [], affectedWorkers: [worker.agent.name], relatedDecisionIds: [] }).decision;
  const said = hive.messages.postMessage(brain.agent, { channel: room.id, body: 'Remember the edge cases.' });
  const waiting = hive.delivery.wait(brain.agent, 4_000).then(() => 'ended', () => 'ended');

  const removed = await f.remove(brain.agent.name);
  assert.deepEqual(removed, { status: 200, json: { ok: true, name: brain.agent.name } });
  assert.equal(await Promise.race([waiting, delay(2_000).then(() => 'pending')]), 'ended', 'the brain wait is evicted');

  // The tombstone: readable by id, out of the roster and of name lookups, unable to authenticate or resume.
  const tombstone = hive.identity.getAgent(brain.agent.id);
  assert.equal(typeof tombstone.removedAt, 'number');
  assert.equal(tombstone.online, false);
  assert.ok(!hive.identity.listAgents().some(agent => agent.id === brain.agent.id));
  const snapshot = await f.ui('GET', '/snapshot');
  assert.ok(!(snapshot.json.agents as Array<{ id: string }>).some(agent => agent.id === brain.agent.id), 'the UI offers it in no picker');
  assert.equal(hive.identity.getAgentByName(brain.agent.name), null);
  assert.throws(() => hive.identity.agentByToken(brain.token), status(401));
  assert.throws(() => hive.identity.join({ role: 'brain', token: brain.token }), status(401));
  assert.throws(() => hive.identity.join({ role: 'brain', resumeName: brain.agent.name }), status(410));
  assert.equal(countRows(hive, 'channel_members', { agent_id: brain.agent.id }), 0, 'no channel mail reaches it');
  assert.throws(() => hive.channels.openDm(f.human, brain.agent.name), status(404));
  assert.throws(() => hive.messages.postMessage(f.human, { channel: room.id, body: 'hi', recipients: [brain.agent.name] }), status(403));

  // History stays readable and labelled.
  const history = hive.messageQueries.listMessages(f.human, room.id).messages;
  assert.equal(history.find(message => message.id === said.id)?.authorName, `${brain.agent.name} (removed)`);
  const general = hive.messageQueries.listMessages(f.human, 'general').messages.at(-1)!;
  assert.match(general.body, new RegExp(`Human removed ${brain.agent.name} from the hive\\. 1 pending decision request withdrawn; 1 task ${brain.agent.name} assigned stay open`));

  // The decision is withdrawn with the reason and stays in history; Human can no longer answer it.
  const closed = hive.decisions.get(f.human, decision.id);
  assert.equal(closed.state, 'withdrawn');
  assert.equal(closed.withdrawn?.reason, `${brain.agent.name} was removed from the hive`);
  assert.equal(closed.requesterName, `${brain.agent.name} (removed)`);
  assert.throws(() => hive.decisions.answer(f.human, decision.id, { requestId: 'late', expectedRevision: closed.revision, body: 'LR' }), status(409));
  // A Human reply in the decision thread is plain chat addressed to the remaining (live) recipients.
  const reply = hive.messages.postMessage(f.human, { channel: room.id, threadId: decision.id, body: 'Noted.' });
  assert.deepEqual(reply.recipientIds, [worker.agent.id]);

  // The Jev request is completed and audited; a reply in its thread goes to the remaining brain.
  const execution = executions();
  assert.equal(execution.length, 1);
  assert.equal(typeof execution[0]!.completedAt, 'number');
  const audit = hive.adaptiveTopology.store.recentEvents(room.id).map(row => JSON.parse(String(row.snapshot)) as AdaptiveRoutingEvent);
  assert.ok(audit.some(event => event.kind === 'status' && event.reason === 'brain_removed'));
  const followUp = await f.ui('POST', `/channels/${room.id}/messages`, { body: 'Any news?', threadId: root.id, requestId: 'follow-up' });
  assert.equal(followUp.status, 200, JSON.stringify(followUp.json));
  const open = executions().filter(state => !state.completedAt);
  assert.deepEqual(open.map(state => state.brainId), [other.agent.id], 'the removed brain request stays closed');

  // The task stays open: the worker can still checkpoint and submit, with evidence the removed brain can no longer read.
  const evidence = hive.messages.postMessage(worker.agent, { channel: room.id, body: 'Parser tests: 42 passed' });
  let current = hive.tasks.view(f.human, task.id);
  assert.equal(current.assignerName, `${brain.agent.name} (removed)`);
  const checkpoint = { completedSteps: ['grammar'], unresolvedQuestions: [], nextAction: 'wire the lexer', artifacts: [], checks: [], evidenceSeqs: [evidence.seq] };
  hive.tasks.event(worker.agent, task.id, { requestId: 'checkpoint', expectedRevision: current.revision, action: { type: 'checkpoint', checkpoint } });
  current = hive.tasks.get(worker.agent, task.id);
  const result = { summary: 'Parser done', artifacts: [], checks: [{ name: 'unit', outcome: 'passed' as const, evidenceSeqs: [evidence.seq] }], gaps: [], evidenceSeqs: [evidence.seq] };
  const submitted = hive.tasks.event(worker.agent, task.id, { requestId: 'result', expectedRevision: current.revision, action: { type: 'result', result } });
  assert.equal(submitted.task.state, 'result_submitted');
  assert.equal(submitted.task.assignerName, `${brain.agent.name} (removed)`);
  assert.equal(countRows(hive, 'decision_requests', { requester_id: brain.agent.id }), 1, 'decision history is kept');
});

test('removing a worker cancels its unfinished tasks, keeps routing evidence and lets the brain reassign', async t => {
  const f = fixture(t);
  const { hive, brain, worker, room } = f;
  const done = hive.tasks.assign(brain.agent, { requestId: 'done', worker: worker.agent.name, channel: room.id, contract }).task;
  const open = hive.tasks.assign(brain.agent, { requestId: 'open', worker: worker.agent.name, channel: room.id, contract }).task;
  insertRow(hive, 'routing_outcomes', { task_id: done.id, project_id: room.projectId, worker_id: worker.agent.id, review_revision: 3,
    category: 'implementation', configuration: 'cfg', accepted: 1, recorded_at: Date.now() });
  const outcomes = snapshotTables(hive, ['routing_outcomes']);

  assert.equal((await f.remove(worker.agent.name)).status, 200);
  const cancelled = hive.tasks.view(f.human, open.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, open.revision + 1);
  assert.equal(cancelled.cancellation?.reason, `${worker.agent.name} was removed from the hive`);
  assert.equal(cancelled.workerName, `${worker.agent.name} (removed)`);
  assert.deepEqual(snapshotTables(hive, ['routing_outcomes']), outcomes, 'routing evidence is kept');
  assert.equal(hive.identity.projectWorkerIds(room.projectId).includes(worker.agent.id), false, 'no longer suggested');
  const general = hive.messageQueries.listMessages(f.human, 'general').messages.at(-1)!;
  assert.match(general.body, /2 unfinished tasks assigned to .* cancelled/);

  // A removed worker cannot be assigned or act; a cancelled task cannot be worked on, but its brain can reassign it.
  assert.throws(() => hive.tasks.assign(brain.agent, { requestId: 'again', worker: worker.agent.name, channel: room.id, contract }), status(400));
  const next = hive.identity.join({ role: 'worker', seniority: 'mid' });
  hive.channels.invite(brain.agent, room.id, [next.agent.name]);
  assert.throws(() => hive.tasks.event(brain.agent, open.id, { requestId: 'late-review', expectedRevision: cancelled.revision,
    action: { type: 'review', decision: 'accepted', summary: 'ok', evidenceSeqs: [] } }), status(409));
  const revised = hive.tasks.event(brain.agent, open.id, { requestId: 'reassign', expectedRevision: cancelled.revision,
    action: { type: 'revise', reason: 'Previous worker removed', worker: next.agent.name, contract } });
  assert.equal(revised.task.state, 'sent');
  assert.equal(revised.task.workerId, next.agent.id);
  assert.equal(revised.task.cancellation, undefined);
});

test('removed names stay reserved and removal is a single transaction', async t => {
  const f = fixture(t);
  const { hive, brain, worker, room } = f;
  const task = hive.tasks.assign(brain.agent, { requestId: 'task', worker: worker.agent.name, channel: room.id, contract }).task;
  const tables = ['agents', 'channel_members', 'task_records', 'messages', 'reads'];
  const before = snapshotTables(hive, tables);
  const restore = failWrites(hive, 'agents', { on: 'update', message: 'injected tombstone failure' });
  const failed = await f.remove(worker.agent.name);
  assert.equal(failed.status, 500);
  assert.deepEqual(snapshotTables(hive, tables), before, 'nothing of a failed removal survives');
  assert.equal(hive.tasks.get(f.human, task.id).state, 'sent');
  restore();

  assert.equal((await f.remove(worker.agent.name)).status, 200);
  assert.equal((await f.remove(worker.agent.name)).status, 404, 'a removed agent cannot be removed again');
  // The name stays attached to the tombstone: no bot, join or resume can take it over.
  assert.equal(hive.identity.findAgentByName(worker.agent.name)?.id, worker.agent.id);
  assert.throws(() => hive.bots.createBot(f.human, room.projectId, { name: worker.agent.name }), status(409));
  assert.throws(() => hive.identity.join({ role: 'worker', seniority: 'mid', resumeName: worker.agent.name }), /was removed from the hive/);
  for (let i = 0; i < 5; i++) assert.notEqual(hive.identity.join({ role: 'worker', seniority: 'mid' }).agent.name, worker.agent.name);
});

test('project deletion purges live and removed agents through the same lifecycle', async t => {
  const f = fixture(t);
  const { hive } = f;
  hive.projects.createProject(f.human, { name: 'Side', slug: 'side' });
  const gone = hive.identity.join({ role: 'brain', project: 'side' }), kept = hive.identity.join({ role: 'worker', seniority: 'mid', project: 'side' });
  assert.equal((await f.remove(gone.agent.name)).status, 200);
  hive.identity.setOffline(kept.agent.id);
  const events: unknown[] = [];
  hive.bus.on('project', event => events.push(event));
  hive.projects.deleteProject(f.human, 'side');
  assert.equal(hive.identity.findAgent(gone.agent.id), null);
  assert.equal(hive.identity.findAgent(kept.agent.id), null);
  assert.equal(countRows(hive, 'channel_members', { agent_id: kept.agent.id }), 0);
  assert.deepEqual(events, [{ deleted: 'side' }]);
});
