import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { HiveError } from '../shared/types.ts';
import type { CapabilityCard } from '../shared/routing.ts';
import type { WorkerTemplateSpec } from '../shared/worker-templates.ts';

const status = (code: number) => (error: unknown) => error instanceof HiveError && error.status === code;
const card: CapabilityCard = { enabled: true, capabilities: ['typescript'], modes: ['implementation'], model: null,
  host: null, availableContext: null, availability: 'available', maxInProgress: 1 };
const spec = (seniority: 'junior' | 'mid' | 'senior', focus: string): WorkerTemplateSpec => ({
  label: `${seniority} Codex`, description: 'Task worker', software: 'codex2', model: '', effort: '', extraFlags: '',
  environment: {}, secretNames: [], seniority, focus, maxConcurrent: 2, enabled: true,
});
const contract = { objective: 'Implement panel', scope: [], nonGoals: [], acceptanceCriteria: ['Works'],
  dependencies: [], evidenceSeqs: [] };

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-agent-management-'));
  const hive = new Hive(path.join(dir, 'hive.db'), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createApp(hive), human = hive.identity.getAgent('human');
  const project = hive.projects.createProject(human, { name: 'Panel', slug: 'panel', worktree: dir });
  const brain = hive.identity.join({ role: 'brain', project: project.slug });
  const worker = hive.identity.join({ role: 'worker', seniority: 'mid', project: project.slug });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(url, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  return { hive, app, human, project, brain, worker, call };
}

test('Human identity edit reserves old names for resume, updates live labels and fences stale saves', async t => {
  const f = fixture(t), old = f.worker.agent.name;
  const dm = f.hive.channels.openDm(f.brain.agent, old);
  const historic = f.hive.messages.postMessage(f.brain.agent, { channel: dm.id, body: `Hello ${old}` });
  const task = f.hive.tasks.assign(f.brain.agent, { requestId: randomUUID(), worker: old, contract }).task;
  const renamed = await f.call('PATCH', `/api/ui/agents/${f.worker.agent.id}/identity`,
    { expectedRevision: 1, name: 'PanelWorker', seniority: 'senior', focus: 'identity work' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.agent.name, 'PanelWorker');
  assert.equal(renamed.json.identityRevision, 2);
  assert.equal(f.hive.identity.getAgentByName(old), null, 'former names are not addresses');
  assert.equal(f.hive.identity.getAgentByName('PanelWorker')?.id, f.worker.agent.id);
  assert.equal(f.hive.identity.isNameReserved(old), true);
  assert.throws(() => f.hive.channels.openDm(f.brain.agent, old), status(404));
  assert.throws(() => f.hive.bots.createBot(f.human, f.project.slug, { name: old }), status(409));
  assert.equal(f.hive.channels.openDm(f.brain.agent, 'PanelWorker').id, dm.id);
  assert.match(f.hive.channels.getChannel(dm.id).name, /PanelWorker/);
  assert.equal(f.hive.messageQueries.getMessageById(historic.id).body, `Hello ${old}`, 'stored messages are not rewritten');
  assert.equal(f.hive.tasks.view(f.brain.agent, task.id).workerName, 'PanelWorker');
  assert.throws(() => f.hive.identity.editIdentity(f.human, f.worker.agent.id,
    { expectedRevision: 1, focus: 'stale' }), status(409));
  assert.throws(() => f.hive.identity.editIdentity(f.brain.agent, f.worker.agent.id,
    { expectedRevision: 2, focus: 'forbidden' }), status(403));
  const overview = await f.call('GET', `/api/ui/agents/${f.worker.agent.id}/overview`);
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  assert.deepEqual(overview.json.resumeAliases, [old]);
  assert.equal(overview.json.profile.type, 'fixed');
  assert.equal(overview.json.currentTask.task.id, task.id);
  assert.ok(overview.json.lifecycle.some((event: { kind: string }) => event.kind === 'identity_edited'));
  const resumed = f.hive.identity.join({ role: 'worker', resumeName: old, seniority: 'junior' });
  assert.equal(resumed.agent.id, f.worker.agent.id);
  assert.equal(resumed.agent.name, 'PanelWorker');
  assert.equal(resumed.agent.seniority, 'senior', 'old launch arguments cannot reset Human seniority');
  assert.equal(resumed.agent.focus, 'identity work');
  assert.throws(() => f.hive.identity.agentByToken(f.worker.token), status(401));
});

test('alias promotion preserves every former name and case-insensitive collisions remain reserved', t => {
  const f = fixture(t), id = f.worker.agent.id, original = f.worker.agent.name;
  f.hive.identity.editIdentity(f.human, id, { expectedRevision: 1, name: 'PanelB' });
  f.hive.identity.editIdentity(f.human, id, { expectedRevision: 2, name: 'PanelC' });
  assert.throws(() => f.hive.identity.editIdentity(f.human, f.brain.agent.id,
    { expectedRevision: 1, name: 'panelb' }), status(409));
  f.hive.identity.editIdentity(f.human, id, { expectedRevision: 3, name: original });
  assert.equal(f.hive.identity.getAgentByName(original)?.id, id);
  assert.equal(f.hive.identity.getAgentByName('PanelB'), null);
  assert.equal(f.hive.identity.getAgentByName('PanelC'), null);
  assert.deepEqual(f.hive.management.overview(f.human, id).resumeAliases, ['PanelB', 'PanelC']);
  for (const alias of ['panelb', 'panelc']) {
    assert.equal(f.hive.identity.join({ role: 'worker', resumeName: alias }).agent.id, id);
    assert.throws(() => f.hive.bots.createBot(f.human, f.project.slug, { name: alias }), status(409));
  }
});

test('Human edits a pending worker survive retarget and stale launch claim fields', t => {
  const f = fixture(t);
  const first = f.hive.workerTemplates.create(f.human, f.project.id, { slug: 'first', spec: spec('junior', 'initial') });
  const second = f.hive.workerTemplates.create(f.human, f.project.id, { slug: 'second', spec: spec('mid', 'retarget') });
  const pending = f.hive.identity.reserve(f.brain.agent, first);
  f.hive.identity.editIdentity(f.human, pending.agent.id, { expectedRevision: 1,
    name: 'PendingPanel', seniority: 'senior', focus: 'human focus' });
  const retargeted = f.hive.identity.retargetReservation(f.human, pending.agent.id, second);
  assert.equal(retargeted.name, 'PendingPanel');
  assert.equal(retargeted.seniority, 'senior');
  assert.equal(retargeted.focus, 'human focus');
  const claimed = f.hive.identity.join({ role: 'worker', claim: pending.ticket, project: f.project.slug,
    seniority: 'junior', focus: 'stale prompt' });
  assert.equal(claimed.agent.id, pending.agent.id);
  assert.equal(claimed.agent.seniority, 'senior');
  assert.equal(claimed.agent.focus, 'human focus');
});

test('Human and worker capability edits preserve revision ownership and notify the worker', async t => {
  const f = fixture(t), id = f.worker.agent.id;
  const denied = await f.call('PUT', `/api/ui/agents/${f.brain.agent.id}/capability`, { expectedRevision: 0, card });
  assert.notEqual(denied.status, 200);
  const first = await f.call('PUT', `/api/ui/agents/${id}/capability`, { expectedRevision: 0, card });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.capability.revision, 1);
  assert.equal(first.json.capability.lastEditorId, f.human.id);
  const dm = f.hive.channels.openDm(f.human, f.worker.agent.name);
  const controls = f.hive.messageQueries.listMessages(f.human, dm.id, { limit: 20 }).messages;
  assert.ok(controls.some(message => message.kind === 'control' && /get_worker_capabilities/.test(message.body)));
  const conflict = await f.call('PUT', `/api/ui/agents/${id}/capability`, { expectedRevision: 0, card });
  assert.equal(conflict.status, 409);
  const second = f.hive.routing.set(f.worker.agent, { expectedRevision: 1, card: { ...card, availability: 'busy' } });
  assert.equal(second.lastEditorId, id, 'worker card authoring remains available');
  assert.equal(f.hive.management.overview(f.human, id).capability?.revision, 2);
});

test('remove impact changes with a launch and closes task-bound work, job and native session', t => {
  const f = fixture(t);
  const template = f.hive.workerTemplates.create(f.human, f.project.id, { slug: 'codex', spec: spec('mid', 'task') });
  const requested = f.hive.workerOrchestration.request(f.brain.agent, { requestId: randomUUID(), template: template.slug,
    contract, job: { title: 'Panel initiative' } });
  const initial = f.hive.management.removeImpact(f.human, requested.worker.id);
  assert.equal(initial.cancelled.count, 1);
  assert.equal(initial.pendingLaunch, true);
  f.hive.launcherQueue.approve(f.human, requested.request.id);
  assert.throws(() => f.hive.management.remove(f.human, requested.worker.id, { impactToken: initial.impactToken }), status(409));
  const dispatch = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(dispatch && dispatch.kind === 'launch');
  const beforeSession = f.hive.management.removeImpact(f.human, requested.worker.id);
  f.hive.launcherQueue.result(dispatch.id, { status: 'launched', session: dispatch.session });
  assert.throws(() => f.hive.management.remove(f.human, requested.worker.id,
    { impactToken: beforeSession.impactToken }), status(409));
  const current = f.hive.management.removeImpact(f.human, requested.worker.id);
  assert.equal(current.launch?.session, dispatch.session);
  assert.equal(current.pendingNativeCleanup, true);
  const removed = f.hive.management.remove(f.human, requested.worker.id, { impactToken: current.impactToken });
  assert.ok(removed.removedAt !== undefined);
  assert.equal(removed.archivedAt, undefined);
  assert.equal(f.hive.tasks.get(f.brain.agent, requested.task.id).state, 'cancelled');
  assert.equal(f.hive.jobs.get(f.brain.agent, requested.task.jobId!).counts.cancelled, 1);
  const kill = f.hive.launcherQueue.next('http://127.0.0.1:7520');
  assert.ok(kill && kill.kind === 'kill' && kill.session === dispatch.session);
});

test('outer removal rollback preserves the identity and postpones physical blob collection', t => {
  const f = fixture(t), task = f.hive.tasks.assign(f.brain.agent,
    { requestId: randomUUID(), worker: f.worker.agent.name, contract }).task;
  let sweeps = 0;
  f.hive.lifecycle.sweepBlobs = () => { sweeps++; };
  assert.throws(() => f.hive.storage.transaction(() => {
    f.hive.lifecycle.removeAgent(f.human, f.worker.agent.name);
    throw new Error('outer transaction failed');
  }), /outer transaction failed/);
  assert.equal(sweeps, 0, 'filesystem cleanup waits for the outermost commit');
  assert.equal(f.hive.identity.getAgent(f.worker.agent.id).removedAt, undefined);
  assert.equal(f.hive.tasks.get(f.brain.agent, task.id).state, 'sent');
  f.hive.lifecycle.removeAgent(f.human, f.worker.agent.name);
  assert.equal(sweeps, 1);
});

test('management HTTP routes reject agent Bearer tokens and validate Human observations', async t => {
  const f = fixture(t), id = f.worker.agent.id;
  for (const [method, path, body] of [
    ['GET', `/api/ui/agents/${id}/overview`],
    ['PATCH', `/api/ui/agents/${id}/identity`, { expectedRevision: 1, focus: 'no' }],
    ['PUT', `/api/ui/agents/${id}/capability`, { expectedRevision: 0, card }],
    ['GET', `/api/ui/agents/${id}/remove-impact`],
    ['GET', `/api/ui/agents/${id}/lifecycle`],
    ['POST', `/api/ui/agents/${id}/runtime-event`, { kind: 'stop_observed', session: 'hm-panel-old-alias' }],
    ['POST', `/api/ui/agents/${id}/remove`, { impactToken: '0'.repeat(64) }],
  ] as const) {
    const response = await f.app.request(path, { method, headers: { 'content-type': 'application/json',
      authorization: `Bearer ${f.worker.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  const event = await f.call('POST', `/api/ui/agents/${id}/runtime-event`,
    { kind: 'stop_observed', session: 'hm-panel-old-alias' });
  assert.equal(event.status, 200, JSON.stringify(event.json));
  assert.equal(event.json.event.source, 'human_ui');
  const bad = await f.call('POST', `/api/ui/agents/${id}/runtime-event`,
    { kind: 'stop_observed', session: '; rm -rf /' });
  assert.equal(bad.status, 400);
});
