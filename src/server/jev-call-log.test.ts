import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { countRows, listRows } from './test-fixtures.ts';
import { createApp } from './app.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { GROUPS_PER_PAGE, JEV_CALLS_PER_PROJECT } from './jev-call-log.ts';
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

  const stored = JSON.stringify(listRows(f.hive, 'jev_calls'));
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
  const view = f.hive.adaptiveTopology.observations.jevCalls.view(group.projectId);
  const call = view.requests[0]!.calls[0]!;
  assert.equal(call.phase, 'observation');
  assert.equal(call.brainId, null);
  assert.equal(call.outcome?.kind, 'observation');
  assert.equal(call.outcome?.applied, false);

  const log = f.hive.adaptiveTopology.observations.jevCalls, decision = { ...call, providerStatus: 'ok' as const, contractVersion: 'adaptive-routing-v2' as const,
    singleSufficient: true, needsOrchestration: false };
  for (let i = 0; i < JEV_CALLS_PER_PROJECT + 5; i++)
    log.record({ executionId: `bulk-${i % 7}`, channelId: group.id, projectId: group.projectId, brainId: null, phase: 'observation',
      trigger: { kind: 'observation', eventType: null } }, { sent: null, received: null, error: null }, { ...decision, routeId: `bulk-route-${i}` });
  assert.equal(countRows(f.hive, 'jev_calls', { project_id: group.projectId }), JEV_CALLS_PER_PROJECT);
  await f.hive.adaptiveTopology.stop();
  for (const agent of f.hive.listAgents(f.human).filter(agent => agent.role !== 'human')) f.hive.setOffline(agent.id);
  f.hive.createProject(f.human, { slug: 'other', name: 'Other' });
  f.hive.deleteProject(f.human, 'chapter');
  assert.equal(countRows(f.hive, 'jev_calls'), 0, 'Project deletion removes its Jev history');
});

test('pagination returns every request exactly once when groups share the page-boundary millisecond', async t => {
  const f = fixture(t);
  await f.hive.adaptiveTopology.stop();
  const log = f.hive.adaptiveTopology.observations.jevCalls;
  const decision = { routeId: '', providerStatus: 'ok' as const, contractVersion: 'adaptive-routing-v2' as const, targetTopology: 'single' as const,
    targetWorkers: 0, confidence: 0.9, reason: 'single_sufficient', model: 'jev-latest', latencyMs: 1, inputTokens: null, outputTokens: null,
    singleSufficient: true, needsOrchestration: false } as unknown as Parameters<typeof log.record>[2];
  let now = 5_000;
  t.mock.method(Date, 'now', () => now);
  const record = (executionId: string, at: number) => {
    now = at;
    log.record({ executionId, channelId: f.dm.id, projectId: f.dm.projectId, brainId: null, phase: 'observation',
      trigger: { kind: 'observation', eventType: null } }, { sent: null, received: null, error: null }, { ...decision, routeId: `route-${executionId}-${at}` });
  };
  // Ten newer requests, then many requests whose last call lands on the same millisecond, straddling the first page boundary.
  for (let i = 0; i < 10; i++) record(`newer-${String(i).padStart(3, '0')}`, 9_000 + i);
  for (let i = 0; i < GROUPS_PER_PAGE + 20; i++) record(`tie-${String(i).padStart(3, '0')}`, 7_000);
  record('tie-000', 6_000); // an earlier call does not move the group's lastAt
  for (let i = 0; i < 5; i++) record(`older-${i}`, 1_000 + i);
  const expected = 10 + GROUPS_PER_PAGE + 20 + 5;

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const { status, body } = await f.get<JevCallLogView>(`/projects/chapter/jev-calls${query}`);
    assert.equal(status, 200);
    seen.push(...body.requests.map(group => group.executionId));
    assert.equal(body.hasMore, body.nextCursor !== null, 'nextCursor is present exactly when more pages exist');
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  assert.equal(seen.length, expected, 'No request is skipped or repeated across pages');
  assert.equal(new Set(seen).size, expected);
  assert.equal(seen.filter(id => id.startsWith('tie-')).length, GROUPS_PER_PAGE + 20);
  assert.deepEqual(seen.slice(-5), ['older-4', 'older-3', 'older-2', 'older-1', 'older-0'], 'Newest activity first');

  // Legacy `before=<ms>` keeps working and excludes the boundary millisecond.
  const legacy = await f.get<JevCallLogView>('/projects/chapter/jev-calls?before=7000');
  assert.deepEqual(legacy.body.requests.map(group => group.executionId), ['older-4', 'older-3', 'older-2', 'older-1', 'older-0']);
});
