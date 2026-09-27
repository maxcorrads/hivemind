import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { HiveError } from '../shared/types.ts';
import type { WorkerTemplateSpec } from '../shared/worker-templates.ts';

const spec: WorkerTemplateSpec = { label: 'Worker', description: 'Task worker', software: 'codex2', model: '', effort: '',
  extraFlags: '', environment: {}, secretNames: [], seniority: 'mid', focus: 'implementation', maxConcurrent: 1, enabled: true };
const contract = { objective: 'Build a view', scope: [], nonGoals: [], acceptanceCriteria: ['View works'], dependencies: [], evidenceSeqs: [] };
const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-a4-control-'));
  const hive = new Hive(path.join(dir, 'hive.db'), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human');
  const project = hive.projects.createProject(human, { name: 'Project', slug: 'project', worktree: dir });
  const brain = hive.identity.join({ role: 'brain', project: project.slug }).agent;
  const template = hive.workerTemplates.create(human, project.id, { slug: 'worker', spec });
  hive.identity.setLaunchMode(human, brain.name, 'auto');
  const activeBrain = hive.identity.getAgent(brain.id);
  const requested = hive.workerOrchestration.request(activeBrain, { requestId: randomUUID(), template: template.slug, contract });
  const launch = hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(launch && launch.kind === 'launch');
  hive.launcherQueue.result(launch.id, { status: 'launched', session: launch.session });
  const ticket = /hmc_[0-9a-f]{48}/.exec(launch.command)?.[0];
  assert.ok(ticket);
  const joined = hive.identity.join({ role: 'worker', claim: ticket! });
  const current = () => hive.tasks.get(human, requested.task.id);
  const control = (action: unknown, requestId = randomUUID()) => hive.tasks.control(human, requested.task.id,
    { requestId, expectedRevision: current().revision, action });
  return { hive, human, activeBrain, requested, joined, current, control };
}

test('soft pause admits a checkpoint, fences concurrent control, and resumes the same running session', t => {
  const f = fixture(t);
  const id = randomUUID(), paused = f.control({ type: 'pause', mode: 'soft', reason: 'Review priority' }, id);
  assert.equal(paused.task.state, 'paused');
  assert.equal(f.hive.tasks.control(f.human, f.requested.task.id,
    { requestId: id, expectedRevision: 2, action: { type: 'pause', mode: 'soft', reason: 'Review priority' } }).duplicate, true);
  assert.throws(() => f.hive.tasks.control(f.human, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: 2, action: { type: 'resume' } }), status(409));
  const checkpoint = f.hive.tasks.event(f.joined.agent, f.requested.task.id, { requestId: randomUUID(),
    expectedRevision: f.current().revision, action: { type: 'checkpoint', checkpoint: { completedSteps: ['Scaffolded'],
      unresolvedQuestions: [], nextAction: 'Resume implementation', artifacts: [], checks: [], evidenceSeqs: [] } } });
  assert.equal(checkpoint.task.state, 'paused');
  assert.equal(checkpoint.task.checkpoint?.data.nextAction, 'Resume implementation');
  const resumed = f.control({ type: 'resume' });
  assert.equal(resumed.task.state, 'sent');
  assert.equal(resumed.task.pause, undefined);
  assert.equal(f.hive.identity.getAgent(f.joined.agent.id).archivedAt, undefined);
});

test('hard pause persists grace, native close fences token, and resume launches the same identity', t => {
  const f = fixture(t);
  const job = f.hive.jobs.resolve(f.activeBrain, { title: 'Build the view' }, randomUUID());
  f.hive.jobs.attach(f.activeBrain, f.requested.task.id, job.id);
  const accepted = f.hive.tasks.event(f.joined.agent, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision, action: { type: 'accept' } });
  assert.equal(accepted.task.state, 'accepted');
  const pause = f.control({ type: 'pause', mode: 'hard' });
  f.hive.tasks.event(f.joined.agent, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision,
      action: { type: 'checkpoint', checkpoint: { completedSteps: ['Saved state'], unresolvedQuestions: [],
        nextAction: 'Wait for Human', artifacts: [], checks: [], evidenceSeqs: [] } } });
  assert.throws(() => f.hive.tasks.event(f.activeBrain, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision,
      action: { type: 'revise', reason: 'Change scope', worker: f.joined.agent.name, contract } }), status(409));
  const deadline = pause.task.pause!.graceUntil!;
  assert.equal(f.hive.tasks.sweepHardPauses(deadline - 1), 0);
  assert.equal(f.hive.tasks.sweepHardPauses(deadline), 1);
  assert.ok(f.current().pause?.stopRequestedAt);
  const kill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(kill && kill.kind === 'kill');
  f.hive.launcherQueue.result(kill.id, { status: 'killed' });
  assert.ok(f.current().pause?.closedAt);
  assert.throws(() => f.hive.identity.agentByToken(f.joined.token), status(401));
  assert.throws(() => f.hive.identity.join({ role: 'worker', resumeName: f.joined.agent.name }), status(409));
  assert.equal(f.hive.workerOrchestration.templates(f.activeBrain).templates[0]!.instancesInUse, 0);
  const resume = f.control({ type: 'resume' });
  assert.equal(resume.task.state, 'paused', 'task waits for native launch outcome');
  assert.equal(f.hive.launcherQueue.get(resume.task.pause!.resumeRequestId!).jobId, job.id);
  assert.throws(() => f.hive.identity.join({ role: 'worker', resumeName: f.joined.agent.name }), status(409));
  const relaunched = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(relaunched && relaunched.kind === 'launch');
  assert.match(relaunched.command, new RegExp(`resume=${f.joined.agent.name}`));
  assert.doesNotMatch(relaunched.command, /hmc_[0-9a-f]{48}/);
  const same = f.hive.identity.join({ role: 'worker', resumeName: f.joined.agent.name });
  assert.equal(same.agent.id, f.joined.agent.id);
  f.hive.launcherQueue.result(relaunched.id, { status: 'launched', session: relaunched.session });
  assert.equal(f.current().state, 'accepted');
  assert.equal(f.hive.tasks.handoffs(same.agent).items[0]?.taskId, f.requested.task.id);
});

test('Human explicitly retries a failed hard-stop command while the task stays paused', t => {
  const f = fixture(t);
  const pause = f.control({ type: 'pause', mode: 'hard' });
  f.hive.tasks.sweepHardPauses(pause.task.pause!.graceUntil!);
  const failed = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(failed && failed.kind === 'kill');
  f.hive.launcherQueue.result(failed.id, { status: 'failed' });
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().pause?.closedAt, undefined);
  assert.throws(() => f.control({ type: 'resume' }), status(409));
  assert.equal(f.hive.tasks.sweepHardPauses(pause.task.pause!.graceUntil! + 1), 0);
  const retried = f.control({ type: 'pause', mode: 'hard', reason: 'Retry native close' });
  assert.equal(retried.task.state, 'paused');
  assert.equal(retried.task.pause?.requestId, pause.task.pause?.requestId);
  const retryKill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(retryKill && retryKill.kind === 'kill');
  assert.notEqual(retryKill.id, failed.id);
  f.hive.launcherQueue.result(retryKill.id, { status: 'killed' });
  assert.ok(f.current().pause?.closedAt);
  assert.equal(f.control({ type: 'resume' }).task.state, 'paused');
});

test('failed hard resume remains paused and cannot retry until uncertain native session is killed', t => {
  const f = fixture(t);
  const pause = f.control({ type: 'pause', mode: 'hard' });
  f.hive.tasks.sweepHardPauses(pause.task.pause!.graceUntil!);
  const firstKill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(firstKill && firstKill.kind === 'kill');
  f.hive.launcherQueue.result(firstKill.id, { status: 'killed' });
  f.control({ type: 'resume' });
  const launch = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(launch && launch.kind === 'launch');
  f.hive.launcherQueue.result(launch.id, { status: 'failed' });
  assert.equal(f.current().state, 'paused');
  assert.equal(f.current().pause?.resumeRequestId, undefined);
  assert.equal(f.hive.identity.getAgent(f.joined.agent.id).archivedAt, undefined);
  assert.throws(() => f.control({ type: 'resume' }), status(409));
  const secondKill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(secondKill && secondKill.kind === 'kill');
  f.hive.launcherQueue.result(secondKill.id, { status: 'killed' });
  assert.equal(f.control({ type: 'resume' }).task.state, 'paused');
});

test('accepted review archives the task-bound worker automatically; Human cancel leaves fixed worker intact', t => {
  const f = fixture(t);
  f.hive.tasks.event(f.joined.agent, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision, action: { type: 'accept' } });
  f.hive.tasks.event(f.joined.agent, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision,
      action: { type: 'result', result: { summary: 'Done', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } } });
  f.hive.tasks.event(f.activeBrain, f.requested.task.id,
    { requestId: randomUUID(), expectedRevision: f.current().revision,
      action: { type: 'review', decision: 'accepted', summary: 'Checked', evidenceSeqs: [] } });
  assert.ok(f.hive.identity.getAgent(f.joined.agent.id).archivedAt);
  assert.equal(f.hive.launcherQueue.get(f.requested.request.id).state, 'cancelled');
  const fixed = f.hive.identity.join({ role: 'worker', seniority: 'mid', project: 'project' }).agent;
  const task = f.hive.tasks.assign(f.activeBrain, { requestId: 'fixed-task', worker: fixed.name, contract }).task;
  const cancelled = f.hive.tasks.control(f.human, task.id,
    { requestId: randomUUID(), expectedRevision: task.revision, action: { type: 'cancel', reason: 'No longer needed' } });
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(f.hive.identity.getAgent(fixed.id).archivedAt, undefined);
});
