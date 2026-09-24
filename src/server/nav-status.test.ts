import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import type { Agent } from '../shared/types.ts';
import type { AgentWork, TaskAction } from '../shared/tasks.ts';

const contract = (objective: string) => ({ objective, scope: ['focused change'], nonGoals: [],
  acceptanceCriteria: ['Tests pass'], dependencies: [], evidenceSeqs: [] });

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-nav-status-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const brain = hive.identity.join({ role: 'brain' }).agent, worker = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const assign = (objective: string) => hive.tasks.assign(brain, { requestId: `a-${++n}`, worker: worker.name, contract: contract(objective) }).task;
  const event = (id: string, actor: Agent, action: TaskAction) => hive.tasks.event(actor, id,
    { requestId: `e-${++n}`, expectedRevision: hive.tasks.get(actor, id).revision, action });
  const status = async () => await (await createApp(hive).request('/api/ui/nav-status')).json() as {
    awaitingDecisions: Record<string, number>; agentWork: Record<string, AgentWork> };
  return { hive, brain, worker, assign, event, status };
}

test('nav status reports a worker\'s newest open task with its latest blocker and what the brain waits on', async t => {
  const f = fixture(t);
  const older = f.assign('Draft the API contract');
  f.event(older.id, f.worker, { type: 'accept' });
  f.event(older.id, f.worker, { type: 'block', needed: 'Old blocker' });
  f.event(older.id, f.worker, { type: 'accept' });
  f.event(older.id, f.worker, { type: 'block', needed: 'API contract' });
  let work = (await f.status()).agentWork;
  assert.deepEqual(work[f.worker.id]?.task, { id: older.id, channelId: older.channelId, state: 'blocked',
    objective: 'Draft the API contract', needed: 'API contract' });
  assert.equal(work[f.worker.id]?.assigned, 1);
  assert.deepEqual(work[f.brain.id], { task: null, assigned: 0, delegated: 1, toReview: 0 });

  const newer = f.assign('Wire the parser');
  f.event(newer.id, f.worker, { type: 'accept' });
  f.event(newer.id, f.worker, { type: 'result', result: { summary: 'Done', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
  work = (await f.status()).agentWork;
  assert.equal(work[f.worker.id]?.task?.id, newer.id, 'the most recently updated open task wins');
  assert.equal(work[f.worker.id]?.task?.state, 'result_submitted');
  assert.equal(work[f.worker.id]?.task?.needed, null);
  assert.equal(work[f.worker.id]?.assigned, 2);
  assert.deepEqual(work[f.brain.id], { task: null, assigned: 0, delegated: 2, toReview: 1 });

  f.event(newer.id, f.brain, { type: 'review', decision: 'accepted', summary: 'Good', evidenceSeqs: [] });
  work = (await f.status()).agentWork;
  assert.equal(work[f.worker.id]?.task?.id, older.id, 'accepted-complete work drops out');
  assert.equal(work[f.brain.id]?.toReview, 0);
});

test('nav status counts only currently applicable awaiting decisions, per project slug', async t => {
  const f = fixture(t);
  const slug = f.hive.projects.listProjects()[0]!.slug;
  assert.deepEqual((await f.status()).awaitingDecisions, { [slug]: 0 });
  const task = f.assign('Choose a parser boundary');
  const request = (requestId: string, extra = {}) => f.hive.decisions.create(f.brain, { requestId, taskId: task.id,
    expectedTaskRevision: f.hive.tasks.get(f.brain, task.id).revision, question: 'Which boundary?',
    options: [{ id: 'a', label: 'A', impact: 'x' }, { id: 'b', label: 'B', impact: 'y' }],
    recommendation: { optionId: 'a', rationale: 'Simpler', uncertainty: 'Low' },
    evidenceSeqs: [], artifacts: [], affectedWorkers: [f.worker.name], relatedDecisionIds: [], ...extra });
  request('open');
  request('expired', { requestedByAt: Date.now() - 1 });
  assert.deepEqual((await f.status()).awaitingDecisions, { [slug]: 1 });
  assert.throws(() => f.hive.decisions.awaitingCounts(f.brain), /Only Human/);
});
