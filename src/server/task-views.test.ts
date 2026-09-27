import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { storedSnapshot, updateRows } from './test-fixtures.ts';
import { HiveError } from '../shared/types.ts';
import type { TaskSnapshot } from '../shared/tasks.ts';
import type { WorkerTemplateSpec } from '../shared/worker-templates.ts';

const contract = (objective: string) => ({ objective, scope: [], nonGoals: [], acceptanceCriteria: ['Done'],
  dependencies: [], evidenceSeqs: [] });
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hive-task-views-'));
  const hive = new Hive(path.join(home, 'hive.db'), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.close(); rmSync(home, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const alpha = hive.projects.createProject(human, { name: 'Alpha project', slug: 'alpha', worktree: home });
  const beta = hive.projects.createProject(human, { name: 'Beta project', slug: 'beta', worktree: home });
  const joinedBrainA = hive.identity.join({ role: 'brain', project: alpha.slug });
  const brainA = joinedBrainA.agent;
  const brainB = hive.identity.join({ role: 'brain', project: beta.slug }).agent;
  const workerA = hive.identity.join({ role: 'worker', seniority: 'mid', project: alpha.slug }).agent;
  const workerB = hive.identity.join({ role: 'worker', seniority: 'mid', project: beta.slug }).agent;
  const assign = (project: 'alpha' | 'beta', objective: string) => {
    const brain = project === 'alpha' ? brainA : brainB;
    const worker = project === 'alpha' ? workerA : workerB;
    return hive.tasks.assign(brain, { requestId: randomUUID(), worker: worker.name, contract: contract(objective) }).task;
  };
  const timestamp = (taskId: string, at: number) => {
    const snapshot = storedSnapshot<TaskSnapshot>(hive, 'task_records', taskId);
    updateRows(hive, 'task_records', { snapshot: JSON.stringify({ ...snapshot, updatedAt: at }) }, { id: taskId });
  };
  return { hive, human, alpha, beta, brainA, brainAToken: joinedBrainA.token, brainB,
    workerA, workerB, assign, timestamp, home };
}

test('Human cross-channel tasks paginate by updatedAt and id after project filtering', t => {
  const f = fixture(t);
  const a1 = f.assign('alpha', 'Alpha one'), b1 = f.assign('beta', 'Beta one');
  const a2 = f.assign('alpha', 'Alpha two'), a3 = f.assign('alpha', 'Alpha three');
  f.timestamp(a1.id, 3000); f.timestamp(b1.id, 4000); f.timestamp(a2.id, 2000); f.timestamp(a3.id, 2000);
  const first = f.hive.taskViews.list(f.human, { projectId: f.alpha.id, limit: 2 });
  assert.deepEqual(first.items.map(item => item.task.id), [a1.id, ...[a2.id, a3.id].sort().reverse().slice(0, 1)]);
  assert.ok(first.hasMore && first.nextCursor);
  assert.ok(first.items.every(item => item.projectId === f.alpha.id && item.project === f.alpha.slug));
  const second = f.hive.taskViews.list(f.human, { projectId: f.alpha.id, cursor: first.nextCursor!, limit: 2 });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]!.task.id, [a2.id, a3.id].sort()[0]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.hasMore, false);
  assert.deepEqual(f.hive.taskViews.list(f.human, { limit: 10 }).items.map(item => item.task.id)[0], b1.id);
  assert.equal(f.hive.taskViews.get(f.human, b1.id).brain.id, f.brainB.id);
  assert.equal(f.hive.taskViews.get(f.human, a1.id).worker.id, f.workerA.id);
  assert.equal(f.hive.taskViews.get(f.human, a1.id).traffic, null);
  assert.throws(() => f.hive.taskViews.list(f.brainA), status(403));
  assert.throws(() => f.hive.taskViews.get(f.workerA, a1.id), status(403));
  assert.throws(() => f.hive.taskViews.list(f.human, { projectId: f.beta.id, cursor: first.nextCursor! }), status(400));
  assert.throws(() => f.hive.taskViews.list(f.human, { cursor: 'tampered' }), status(400));
  assert.throws(() => f.hive.taskViews.list(f.human, { limit: 101 }), status(400));
  assert.throws(() => f.hive.taskViews.get(f.human, randomUUID()), status(404));
});

test('page jobs include referenced jobs and active empty jobs in scope', t => {
  const f = fixture(t);
  const linked = f.assign('alpha', 'Linked task'), unlinked = f.assign('alpha', 'Other task');
  const job = f.hive.jobs.event(f.brainA, { requestId: randomUUID(), type: 'open', title: 'Linked job' });
  const empty = f.hive.jobs.event(f.brainA, { requestId: randomUUID(), type: 'open', title: 'Empty job' });
  const foreignEmpty = f.hive.jobs.event(f.brainB, { requestId: randomUUID(), type: 'open', title: 'Foreign empty job' });
  f.hive.jobs.attach(f.brainA, linked.id, job.id);
  f.timestamp(linked.id, 3000); f.timestamp(unlinked.id, 2000);
  const first = f.hive.taskViews.list(f.human, { projectId: f.alpha.id, limit: 1 });
  assert.equal(first.items[0]!.task.id, linked.id);
  assert.deepEqual(new Set(first.jobs.map(item => item.id)), new Set([job.id, empty.id]));
  assert.equal(first.jobs.find(item => item.id === job.id)?.counts.total, 1);
  const second = f.hive.taskViews.list(f.human, { projectId: f.alpha.id, limit: 1, cursor: first.nextCursor! });
  assert.equal(second.items[0]!.task.id, unlinked.id);
  assert.deepEqual(second.jobs.map(item => item.id), [empty.id]);
  const beta = f.hive.taskViews.list(f.human, { projectId: f.beta.id });
  assert.equal(beta.items.length, 0);
  assert.deepEqual(beta.jobs.map(item => item.id), [foreignEmpty.id]);
});

test('archived task-bound participants and deleted template retain launch snapshot label', t => {
  const f = fixture(t);
  const spec: WorkerTemplateSpec = { label: 'Historic Codex', description: 'Build', software: 'codex2', model: '',
    effort: '', extraFlags: '', environment: {}, secretNames: [], seniority: 'mid', focus: 'build',
    maxConcurrent: 1, enabled: true };
  const template = f.hive.workerTemplates.create(f.human, f.alpha.id, { slug: 'historic', spec });
  const requested = f.hive.workerOrchestration.request(f.brainA,
    { requestId: randomUUID(), template: 'historic', contract: contract('Historical task') });
  f.hive.launcherQueue.approve(f.human, requested.request.id);
  const launch = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(launch && launch.kind === 'launch');
  f.hive.launcherQueue.result(launch.id, { status: 'launched', session: launch.session });
  const ticket = /hmc_[0-9a-f]{48}/.exec(launch.command)?.[0];
  assert.ok(ticket);
  const joined = f.hive.identity.join({ role: 'worker', claim: ticket });
  f.hive.traffic.record(joined.agent.id, '/api/agent/wait', 321, 123456);
  const event = (actor: typeof f.brainA, action: unknown) => f.hive.tasks.event(actor, requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.hive.tasks.get(f.human, requested.task.id).revision, action });
  event(joined.agent, { type: 'accept' });
  event(joined.agent, { type: 'result', result: { summary: 'Done', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } });
  event(f.brainA, { type: 'review', decision: 'accepted', summary: 'Verified', evidenceSeqs: [] });
  assert.ok(f.hive.identity.getAgent(joined.agent.id).archivedAt);
  const kill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(kill && kill.kind === 'kill');
  f.hive.launcherQueue.result(kill.id, { status: 'killed' });
  f.hive.workerTemplates.delete(f.human, template.id, template.revision);
  f.hive.identity.removeAgent(f.human, f.brainA.name);
  const overview = f.hive.taskViews.get(f.human, requested.task.id);
  assert.equal(overview.worker.id, joined.agent.id);
  assert.ok(overview.worker.archivedAt);
  assert.equal(overview.brain.id, f.brainA.id);
  assert.ok(overview.brain.removedAt);
  assert.deepEqual(overview.template, { id: template.id, label: spec.label });
  assert.deepEqual(overview.traffic, { since: 123456, bytes: 321, calls: 1,
    routes: { '/api/agent/wait': { bytes: 321, calls: 1 } } });
  assert.deepEqual(f.hive.taskViews.list(f.human, { projectId: f.alpha.id }).items[0]?.traffic, overview.traffic);
  assert.equal(f.hive.taskViews.list(f.human, { projectId: f.alpha.id }).items[0]?.template?.label, spec.label);
});

test('live template is fallback when a legacy launch snapshot lacks a label', t => {
  const f = fixture(t);
  const spec: WorkerTemplateSpec = { label: 'Current label', description: 'Build', software: 'codex2', model: '',
    effort: '', extraFlags: '', environment: {}, secretNames: [], seniority: 'mid', focus: 'build',
    maxConcurrent: 1, enabled: true };
  const template = f.hive.workerTemplates.create(f.human, f.alpha.id, { slug: 'current', spec });
  const requested = f.hive.workerOrchestration.request(f.brainA,
    { requestId: randomUUID(), template: 'current', contract: contract('Fallback task') });
  updateRows(f.hive, 'launch_requests', { template_snapshot: '{}' }, { id: requested.request.id });
  assert.deepEqual(f.hive.taskViews.get(f.human, requested.task.id).template,
    { id: template.id, label: spec.label });
});

test('Human control availability follows confirmed native close and uncertain resume cleanup', t => {
  const f = fixture(t);
  const spec: WorkerTemplateSpec = { label: 'Controlled worker', description: 'Build', software: 'codex2', model: '',
    effort: '', extraFlags: '', environment: {}, secretNames: [], seniority: 'mid', focus: 'build',
    maxConcurrent: 1, enabled: true };
  f.hive.workerTemplates.create(f.human, f.alpha.id, { slug: 'controlled', spec });
  const requested = f.hive.workerOrchestration.request(f.brainA,
    { requestId: randomUUID(), template: 'controlled', contract: contract('Controlled task') });
  f.hive.launcherQueue.approve(f.human, requested.request.id);
  const launch = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(launch && launch.kind === 'launch');
  f.hive.launcherQueue.result(launch.id, { status: 'launched', session: launch.session });
  const ticket = /hmc_[0-9a-f]{48}/.exec(launch.command)?.[0];
  assert.ok(ticket);
  f.hive.identity.join({ role: 'worker', claim: ticket });
  const control = (action: { type: 'pause'; mode: 'soft' | 'hard' } | { type: 'resume' }) =>
    f.hive.tasks.control(f.human, requested.task.id, { requestId: randomUUID(),
      expectedRevision: f.hive.tasks.get(f.human, requested.task.id).revision, action }).task;
  const availability = () => f.hive.taskViews.get(f.human, requested.task.id).controls;
  const soft = control({ type: 'pause', mode: 'soft' });
  assert.equal(soft.state, 'paused');
  assert.deepEqual(availability(), { retryClose: false, resume: true });
  control({ type: 'resume' });
  const hard = control({ type: 'pause', mode: 'hard' });
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  f.hive.tasks.sweepHardPauses(hard.pause!.graceUntil!);
  const firstKill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(firstKill && firstKill.kind === 'kill');
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  f.hive.launcherQueue.result(firstKill.id, { status: 'failed' });
  assert.deepEqual(availability(), { retryClose: true, resume: false });
  control({ type: 'pause', mode: 'hard' });
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  const retryKill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(retryKill && retryKill.kind === 'kill');
  f.hive.launcherQueue.result(retryKill.id, { status: 'killed' });
  assert.deepEqual(availability(), { retryClose: false, resume: true });
  const resuming = control({ type: 'resume' });
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  f.hive.launcherQueue.approve(f.human, resuming.pause!.resumeRequestId!);
  const relaunched = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(relaunched && relaunched.kind === 'launch');
  f.hive.launcherQueue.result(relaunched.id, { status: 'failed' });
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  const cleanup = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(cleanup && cleanup.kind === 'kill');
  f.hive.launcherQueue.result(cleanup.id, { status: 'failed' });
  assert.deepEqual(availability(), { retryClose: true, resume: false });
  control({ type: 'pause', mode: 'hard' });
  assert.deepEqual(availability(), { retryClose: false, resume: false });
  const cleanupRetry = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(cleanupRetry && cleanupRetry.kind === 'kill');
  f.hive.launcherQueue.result(cleanupRetry.id, { status: 'killed' });
  assert.deepEqual(availability(), { retryClose: false, resume: true });
});

test('Human HTTP task list and detail reject agent credentials', async t => {
  const f = fixture(t), app = createApp(f.hive);
  const task = f.assign('alpha', 'HTTP task');
  f.assign('beta', 'Other project task');
  const page = await app.request('/api/ui/tasks?project=alpha&limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const listed = await page.json() as { items: Array<{ task: { id: string }; projectId: string }>; hasMore: boolean };
  assert.deepEqual(listed.items.map(item => item.task.id), [task.id]);
  assert.equal(listed.items[0]?.projectId, f.alpha.id);
  assert.equal(listed.hasMore, false);
  const detail = await app.request(`/api/ui/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as { item: { task: { id: string } } }).item.task.id, task.id);
  for (const route of ['/api/ui/tasks', `/api/ui/tasks/${task.id}`]) {
    const denied = await app.request(route, { headers: { authorization: `Bearer ${f.brainAToken}` } });
    assert.equal(denied.status, 403, route);
  }
  assert.equal((await app.request('/api/ui/tasks?limit=101')).status, 400);
  assert.equal((await app.request(`/api/ui/tasks/${randomUUID()}`)).status, 404);
});
