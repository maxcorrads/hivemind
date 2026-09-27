import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { HiveError } from '../shared/types.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hive-jobs-'));
  const hive = new Hive(path.join(home, 'hive.db'));
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.close(); rmSync(home, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const project = hive.projects.createProject(human, { name: 'Jobs', slug: 'jobs' });
  const brainSession = hive.identity.join({ role: 'brain', project: project.slug });
  const brain = brainSession.agent;
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid', project: project.slug }).agent;
  const channel = hive.channels.openDm(brain, human.name);
  const origin = hive.messages.postMessage(human, { channel: channel.id, body: 'Build my request' });
  const open = (requestId = randomUUID()) => hive.jobs.event(brain, { requestId, type: 'open', title: 'Human request', originMessageId: origin.id });
  const task = () => hive.tasks.assign(brain, { requestId: randomUUID(), worker: worker.name,
    contract: { objective: 'Deliver part', scope: [], nonGoals: [], acceptanceCriteria: ['Checked'], dependencies: [], evidenceSeqs: [] } }).task;
  return { hive, human, project, brain, brainToken: brainSession.token, worker, open, task, origin };
}
const status = (code: number) => (e: unknown) => e instanceof HiveError && e.status === code;

test('jobs keep request retries stable and reject foreign or non-Human origins', t => {
  const f = fixture(t), id = randomUUID(), job = f.open(id);
  assert.equal(f.open(id).id, job.id);
  assert.throws(() => f.hive.jobs.event(f.brain, { requestId: id, type: 'open', title: 'Different' }), status(409));
  assert.throws(() => f.hive.jobs.event(f.worker, { requestId: randomUUID(), type: 'open', title: 'Denied' }), status(403));
  const otherProject = f.hive.projects.createProject(f.human, { name: 'Other', slug: 'other-jobs' });
  const other = f.hive.identity.join({ role: 'brain', project: otherProject.slug }).agent;
  assert.throws(() => f.hive.jobs.get(other, job.id), status(403));
  assert.throws(() => f.hive.jobs.event(other, { requestId: randomUUID(), type: 'open', title: 'Wrong origin', originMessageId: f.origin.id }), status(403));
  assert.equal(f.hive.jobs.list(f.human).length, 1);
  assert.equal(f.hive.jobs.list(other).length, 0);
  const peer = f.hive.identity.join({ role: 'brain', project: f.project.slug }).agent;
  assert.throws(() => f.hive.jobs.get(peer, job.id), status(403));
  assert.equal(f.hive.jobs.list(peer).length, 0);
});

test('job grouping follows task state and Human closes only settled work', t => {
  const f = fixture(t), job = f.open(), task = f.task();
  assert.equal(f.hive.jobs.attach(f.brain, task.id, job.id).jobId, job.id);
  assert.equal(f.hive.jobs.get(f.brain, job.id).counts.active, 1);
  assert.throws(() => f.hive.jobs.close(f.human, job.id, f.hive.jobs.get(f.human, job.id).revision), status(409));
  const result = f.hive.tasks.control(f.human, task.id, { requestId: randomUUID(), expectedRevision: task.revision,
    action: { type: 'cancel', reason: 'Human cancelled' } });
  assert.equal(result.task.state, 'cancelled');
  const settled = f.hive.jobs.get(f.human, job.id);
  assert.equal(settled.state, 'cancelled');
  assert.equal(settled.counts.cancelled, 1);
  const closed = f.hive.jobs.close(f.human, job.id, settled.revision);
  assert.ok(closed.closedAt);
  assert.throws(() => f.hive.jobs.resolve(f.brain, { id: job.id }, randomUUID()), status(409));
});

test('job and task attachment roll back with their surrounding transaction', t => {
  const f = fixture(t), task = f.task();
  assert.throws(() => f.hive.storage.transaction(() => {
    const job = f.open(); f.hive.jobs.attach(f.brain, task.id, job.id); throw new Error('rollback');
  }), /rollback/);
  assert.equal(f.hive.jobs.list(f.brain).length, 0);
  assert.equal(f.hive.tasks.get(f.brain, task.id).jobId, undefined);
});


test('HTTP job and task-control contracts reject agent authority on Human actions', async t => {
  const f = fixture(t);
  const { createApp } = await import('./app.ts');
  const app = createApp(f.hive);
  const post = (url: string, body: unknown, token?: string) => app.request(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  const opened = await post('/api/agent/jobs/events', { requestId: randomUUID(), type: 'open', title: 'HTTP job' }, f.brainToken);
  assert.equal(opened.status, 200);
  const task = f.task();
  const input = { requestId: randomUUID(), expectedRevision: task.revision, action: { type: 'pause', mode: 'soft' } };
  assert.equal((await post(`/api/ui/tasks/${task.id}/control`, input, f.brainToken)).status, 403);
  const paused = await post(`/api/ui/tasks/${task.id}/control`, input);
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as { task: { state: string } }).task.state, 'paused');
  assert.equal((await post(`/api/ui/tasks/${task.id}/control`, { ...input, extra: true })).status, 400);
  const snapshot = await (await app.request('/api/ui/snapshot')).json() as { agentWork: Record<string, unknown>; agents: Array<{ id: string; activity: { since: number } }> };
  assert.ok(snapshot.agentWork[f.worker.id]);
  assert.ok(snapshot.agents.find(a => a.id === f.brain.id)!.activity.since);
});
