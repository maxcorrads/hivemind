import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-routing.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { JEV_CALLS_PER_PROJECT, jevCallLog } from './jev-call-log.ts';
import type { JevCall, JevCallLogView } from '../shared/jev-calls.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-calls-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brains = [0, 1].map(() => hive.join({ role: 'brain', project: 'chapter' }));
  hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.openDm(human, brains[0]!.agent.name);
  const app = createApp(hive);
  let offline = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (offline) throw new Error('offline');
    return Response.json(jevTopologyResponse(String(init?.body), 'single'));
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'ts_secret_fixture_key' });
  const published: unknown[] = [];
  hive.bus.on('jev-call', summary => published.push(summary));
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = async <T,>(route: string) => {
    const response = await app.request(`/api/ui${route}`);
    return { status: response.status, body: await response.json() as T };
  };
  return { hive, human, brains, dm, app, get, published, fail: (value: boolean) => { offline = value; } };
}

test('every Jev exchange is logged with the exact payloads, its trigger and what Hivemind applied', async t => {
  const f = fixture(t);
  const routed = await f.hive.adaptiveTopology.routeHumanRequest(f.human,
    { channel: f.dm.id, body: 'Draft the migration plan.', requestId: 'plan' }, 'auto', 'none');
  assert.ok(routed);
  await f.hive.adaptiveTopology.revalidateForActor(f.brains[0]!.agent, { kind: 'brain_message', actorId: f.brains[0]!.agent.id,
    actorRole: 'brain', channelId: f.dm.id, eventType: 'progress', eventId: 'progress-1' });
  f.fail(true);
  await f.hive.adaptiveTopology.revalidateForActor(f.brains[0]!.agent, { kind: 'brain_message', actorId: f.brains[0]!.agent.id,
    actorRole: 'brain', channelId: f.dm.id, eventId: 'progress-2' });

  const list = await f.get<JevCallLogView>('/projects/chapter/jev-calls');
  assert.equal(list.status, 200);
  assert.equal(list.body.requests.length, 1, 'All calls of one request are grouped');
  const group = list.body.requests[0]!;
  assert.equal(group.executionId, routed.state.executionId);
  assert.equal(group.brainId, f.brains[0]!.agent.id);
  assert.equal(group.request, 'Draft the migration plan.');
  assert.deepEqual(group.calls.map(call => [call.phase, call.trigger.kind, call.status]),
    [['initial', 'human_request', 'ok'], ['continuous', 'brain_message', 'ok'], ['continuous', 'brain_message', 'unavailable']]);
  assert.equal(group.calls[0]!.outcome?.kind, 'evaluation');
  assert.equal(group.calls[0]!.outcome?.appliedTopology, 'single');
  assert.equal(group.calls[1]!.trigger.eventType, 'progress');
  assert.equal(group.calls[2]!.error, 'offline');
  assert.equal(f.published.length >= 3, true, 'Calls are published to the Human realtime stream');

  const detail = await f.get<{ call: JevCall }>(`/projects/chapter/jev-calls/${group.calls[0]!.id}`);
  assert.equal(detail.status, 200);
  const sent = detail.body.call.sent as { model: string; state: { request: string }; questions: Record<string, unknown> };
  assert.equal(sent.state.request, 'Draft the migration plan.');
  assert.equal(sent.model, 'jev-latest');
  assert.ok(sent.questions.target_topology);
  assert.ok((detail.body.call.received as { answers: Record<string, unknown> }).answers.target_topology);
  const failed = await f.get<{ call: JevCall }>(`/projects/chapter/jev-calls/${group.calls[2]!.id}`);
  assert.equal(failed.body.call.received, null);
  assert.ok(failed.body.call.sent, 'A failed call still shows what was sent');

  const stored = JSON.stringify(f.hive.db.prepare('SELECT * FROM jev_calls').all());
  assert.doesNotMatch(stored, /ts_secret_fixture_key/, 'The API key is never logged');
  const other = f.hive.createProject(f.human, { slug: 'other', name: 'Other' })!;
  assert.equal((await f.get(`/projects/${other.slug}/jev-calls/${group.calls[0]!.id}`)).status, 404);
  assert.equal((await f.get<JevCallLogView>(`/projects/${other.slug}/jev-calls`)).body.requests.length, 0);
});

test('observations are logged without a brain and the history is bounded per project', async t => {
  const f = fixture(t);
  const group = f.hive.createChannel(f.human, { name: 'council', type: 'private', project: 'chapter',
    memberNames: f.brains.map(brain => brain.agent.name) });
  await f.hive.adaptiveTopology.routeHumanRequest(f.human, { channel: group.id, body: 'Who takes this?', requestId: 'who' }, 'auto', 'none');
  const view = jevCallLog(f.hive.db).view(group.projectId);
  const call = view.requests[0]!.calls[0]!;
  assert.equal(call.phase, 'observation');
  assert.equal(call.brainId, null);
  assert.equal(call.outcome?.kind, 'observation');
  assert.equal(call.outcome?.applied, false);

  const log = jevCallLog(f.hive.db), decision = { ...call, providerStatus: 'ok' as const, contractVersion: 'adaptive-routing-v2' as const,
    singleSufficient: true, needsOrchestration: false };
  for (let i = 0; i < JEV_CALLS_PER_PROJECT + 5; i++)
    log.record({ executionId: `bulk-${i % 7}`, channelId: group.id, projectId: group.projectId, brainId: null, phase: 'observation',
      trigger: { kind: 'observation', eventType: null } }, { sent: null, received: null, error: null }, { ...decision, routeId: `bulk-route-${i}` });
  assert.equal(Number(f.hive.db.prepare('SELECT COUNT(*) AS n FROM jev_calls WHERE project_id=?').get(group.projectId)!.n), JEV_CALLS_PER_PROJECT);
  await f.hive.adaptiveTopology.stop();
  for (const agent of f.hive.listAgents(f.human).filter(agent => agent.role !== 'human')) f.hive.setOffline(agent.id);
  f.hive.createProject(f.human, { slug: 'other', name: 'Other' });
  f.hive.deleteProject(f.human, 'chapter');
  assert.equal(Number(f.hive.db.prepare('SELECT COUNT(*) AS n FROM jev_calls').get()!.n), 0, 'Project deletion removes its Jev history');
});
