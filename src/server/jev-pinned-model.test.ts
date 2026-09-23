import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from './app.ts';
import { Hive } from './hive.ts';
import { adaptiveRoutingPublic, loadAdaptiveRouting, saveAdaptiveRouting, TYPESAFE_ENDPOINT, TYPESAFE_MODEL } from './adaptive-config.ts';
import { evaluateAdaptiveTopology, type TopologyEvaluationSnapshot } from './adaptive-topology-provider.ts';
import { exportAdaptiveEvidence } from './adaptive-evidence.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import type { JevDiagnosticResult, JevDiagnosticState } from '../shared/jev-diagnostics.ts';

const PINNED = 'jev-2026-09-01';

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-jev-model-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('configs saved before model pinning keep working with the default alias, without enabling Jev', t => {
  const dir = tempHome(t);
  const file = path.join(dir, 'adaptive-routing.json');
  writeFileSync(file, JSON.stringify({ version: 1, enabled: false, apiKey: 'legacy-fixture-key', fallback: 'single' }));
  assert.equal(loadAdaptiveRouting(dir)?.model, TYPESAFE_MODEL);
  assert.equal(loadAdaptiveRouting(dir)?.enabled, false);
  assert.deepEqual(adaptiveRoutingPublic(dir), { enabled: false, apiKeySet: true, apiKeyHint: '…-key', model: TYPESAFE_MODEL,
    defaultModel: TYPESAFE_MODEL, modelPinned: false, fallback: 'single', topologyFallback: 'brain_one_worker' });
  // Reading never rewrites the file; an unrelated save keeps the pre-pinning format (no model field).
  assert.doesNotMatch(readFileSync(file, 'utf8'), /model/);
  saveAdaptiveRouting(dir, { topologyFallback: 'brain_multi_dm' });
  assert.doesNotMatch(readFileSync(file, 'utf8'), /model/);
  assert.equal(loadAdaptiveRouting(dir)?.enabled, false);
});

test('the model setting is a bounded identifier, never a URL, and can be reset to the alias', t => {
  const dir = tempHome(t);
  for (const bad of ['https://evil.example/v1', 'api.typesafe.ai/v2', 'jev latest', 'jev:1', '-jev', 'jev-', 'x'.repeat(65), 7, true, {}])
    assert.throws(() => saveAdaptiveRouting(dir, { model: bad }), /Jev model/, String(bad));
  const saved = saveAdaptiveRouting(dir, { model: `  ${PINNED} ` });
  assert.equal(saved.model, PINNED);
  assert.equal(saved.modelPinned, true);
  assert.equal(saved.defaultModel, TYPESAFE_MODEL);
  assert.equal(saved.enabled, false, 'pinning a model does not enable Jev');
  assert.equal(saveAdaptiveRouting(dir, { enabled: false }).model, PINNED, 'unrelated saves keep the pin');
  assert.equal(saveAdaptiveRouting(dir, { model: null }).modelPinned, false);
  assert.equal(saveAdaptiveRouting(dir, { model: PINNED }).model, PINNED);
  assert.equal(saveAdaptiveRouting(dir, { model: '' }).model, TYPESAFE_MODEL);
  // A hand-edited file with an invalid identifier fails closed like any other invalid setting.
  writeFileSync(path.join(dir, 'adaptive-routing.json'), JSON.stringify({ version: 1, enabled: true, apiKey: 'fixture-key', model: 'https://evil.example' }));
  assert.equal(loadAdaptiveRouting(dir), null);
  assert.equal(adaptiveRoutingPublic(dir).enabled, false);
});

function snapshot(): TopologyEvaluationSnapshot {
  return { request: 'Complete this phase.', project: { slug: 'test', name: 'Test' },
    current: { topology: 'brain_multi_room', workerBudget: 2, desiredTopology: null, desiredWorkers: null },
    capacity: { workers: { total: 3, online: 3, busyOther: 0, busyCurrent: 0, free: 3, usableForExecution: 3, available: [] },
      activeTasks: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    execution: { orchestratedOnly: false, lockedTopology: null, lockScope: 'none' },
    tasks: { active: 0, activeWorkers: 0, blockers: 0, openDependencies: 0, workstreams: 0 },
    recentCoordinationEvents: [], trigger: { kind: 'brain_message' }, previousDecision: null };
}

test('the provider sends the requested identifier to the fixed endpoint and keeps the resolved model separately', async () => {
  const urls: string[] = [], models: unknown[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { model: unknown };
    models.push(body.model);
    return Response.json({ ...jevTopologyResponse(body, 'brain_one_worker', 1), model: `${String(body.model)}-resolved` });
  };
  const pinned = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture', model: PINNED }, { fetchImpl });
  assert.equal(pinned.providerStatus, 'ok');
  assert.equal(pinned.requestedModel, PINNED);
  assert.equal(pinned.model, `${PINNED}-resolved`, 'response drift is recorded, never rewritten to the request');
  const alias = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture' }, { fetchImpl });
  assert.equal(alias.requestedModel, TYPESAFE_MODEL);
  assert.deepEqual(models, [PINNED, TYPESAFE_MODEL]);
  assert.deepEqual(urls, [TYPESAFE_ENDPOINT, TYPESAFE_ENDPOINT]);
  // An invalid identifier that bypassed settings validation is never sent.
  let calls = 0;
  const invalid = await evaluateAdaptiveTopology(snapshot(), { apiKey: 'unit-fixture', model: 'https://evil.example' },
    { fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal(calls, 0);
  assert.equal(invalid.providerStatus, 'unavailable');
  assert.equal(invalid.requestedModel, null);
  assert.equal(invalid.targetTopology, 'brain_multi_room', 'failure preserves the current topology');
});

function runtime(t: TestContext) {
  const dir = tempHome(t);
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' }).agent;
  for (let index = 0; index < 2; index++) hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.channels.openDm(human, brain.name);
  let target: AdaptiveTopology = 'single', resolved: ((requested: string) => string) = requested => requested;
  let unavailable: string | null = null, hook: (() => void) | undefined, serial = 0;
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), TYPESAFE_ENDPOINT);
    const body = JSON.parse(String(init?.body)) as { model: string };
    requested.push(body.model);
    const currentHook = hook; hook = undefined; currentHook?.();
    if (body.model === unavailable) return Response.json({ error: { message: 'model not found' } }, { status: 404 });
    return Response.json({ ...jevTopologyResponse(body, target), model: resolved(body.model) });
  });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); });
  return { hive, human, brain, dm, dir, requested,
    start: () => hive.adaptiveTopology.routeHumanRequest(human,
      { channel: dm.id, body: 'Do the bounded Human request.', requestId: `request-${++serial}` }, 'auto', 'none'),
    recheck: () => hive.adaptiveTopology.revalidateForActor(brain, {
      actorId: brain.id, actorRole: 'brain', kind: 'brain_message', channelId: dm.id, eventId: `event-${++serial}` }),
    choose: (topology: AdaptiveTopology) => { target = topology; },
    resolveAs: (fn: (requested: string) => string) => { resolved = fn; },
    makeUnavailable: (model: string) => { unavailable = model; },
    beforeReply: (work: () => void) => { hook = work; },
    view: () => hive.adaptiveTopology.view(human, dm.id),
    calls: () => hive.adaptiveTopology.observations.jevCalls.view(dm.projectId).requests.flatMap(group => group.calls),
  };
}

test('an unchanged legacy config never calls the provider while Jev stays disabled', async t => {
  const f = runtime(t);
  writeFileSync(path.join(f.dir, 'adaptive-routing.json'), JSON.stringify({ version: 1, enabled: false, apiKey: 'legacy-fixture-key' }));
  assert.equal(await f.start(), null);
  assert.deepEqual(f.requested, []);
});

test('Routing log and evidence export record requested and resolved models independently, including drift', async t => {
  const f = runtime(t);
  saveAdaptiveRouting(f.dir, { enabled: true, apiKey: 'fixture-key', model: PINNED });
  f.resolveAs(() => 'jev-2026-09-01-build-7');
  const started = await f.start(); assert.ok(started);
  f.resolveAs(() => 'jev-2026-09-01-build-8');
  await f.recheck();
  assert.deepEqual(f.requested, [PINNED, PINNED]);
  const calls = f.calls();
  assert.deepEqual(calls.map(call => [call.requestedModel, call.model]),
    [[PINNED, 'jev-2026-09-01-build-7'], [PINNED, 'jev-2026-09-01-build-8']]);
  const detail = f.hive.adaptiveTopology.observations.jevCalls.get(f.dm.projectId, calls[0]!.id);
  assert.equal((detail.sent as { model: string }).model, PINNED, 'the exact sent payload holds the requested identifier');
  assert.equal((detail.received as { model: string }).model, 'jev-2026-09-01-build-7');
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.deepEqual(report.requestedModels, [PINNED]);
  assert.equal(report.requestedModelsTruncated, false);
  assert.deepEqual(report.models, ['jev-2026-09-01-build-7', 'jev-2026-09-01-build-8']);
  assert.deepEqual(report.attempts.map(a => [a.requestedModel, a.model]),
    [[PINNED, 'jev-2026-09-01-build-7'], [PINNED, 'jev-2026-09-01-build-8']]);
  assert.doesNotMatch(JSON.stringify(report), /fixture-key/);
});

test('an unavailable pinned model fails visibly and preserves the current topology without falling back to the alias', async t => {
  const f = runtime(t);
  saveAdaptiveRouting(f.dir, { enabled: true, apiKey: 'fixture-key' });
  const started = await f.start(); assert.ok(started);
  saveAdaptiveRouting(f.dir, { model: PINNED });
  f.makeUnavailable(PINNED); f.choose('brain_multi_room');
  await f.recheck();
  assert.deepEqual(f.requested, [TYPESAFE_MODEL, PINNED], 'no silent retry with another identifier');
  const view = f.view();
  assert.equal(view.state?.currentTopology, 'single');
  assert.match(view.state?.warning ?? '', /Jev unavailable/);
  const failed = f.calls().at(-1)!;
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.error, 'http_404');
  assert.equal(failed.requestedModel, PINNED);
  assert.equal(failed.model, null);
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.deepEqual(report.requestedModels, [TYPESAFE_MODEL, PINNED]);
  assert.deepEqual(report.attempts.at(-1), { ...report.attempts.at(-1), status: 'unavailable', requestedModel: PINNED, model: null });
});

test('changing the model invalidates in-flight initial and continuous classifications', async t => {
  const f = runtime(t);
  saveAdaptiveRouting(f.dir, { enabled: true, apiKey: 'fixture-key' });
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { model: PINNED }); });
  await assert.rejects(f.start(), /settings changed during initial routing/);
  assert.equal(f.view().state, null);
  const started = await f.start(); assert.ok(started);
  assert.deepEqual(f.requested, [TYPESAFE_MODEL, PINNED]);
  f.choose('brain_multi_room');
  const before = f.view();
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { model: 'jev-2026-10-01' }); });
  await f.recheck();
  const stale = f.view();
  assert.equal(stale.state?.currentTopology, 'single', 'a late result for the previous model is discarded');
  assert.equal(stale.state?.revision, before.state?.revision);
  assert.equal(stale.events.length, before.events.length);
  await f.recheck();
  assert.equal(f.requested.at(-1), 'jev-2026-10-01');
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
});

test('the Human connection test uses the configured model, and a model change revokes its revision', async t => {
  const dir = tempHome(t);
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); });
  const sent: unknown[] = [];
  const app = createApp(hive, { jevDiagnosticFetch: async (input, init) => {
    assert.equal(String(input), TYPESAFE_ENDPOINT);
    sent.push((JSON.parse(String(init?.body)) as { model: unknown }).model);
    return Response.json({ model: 'jev-resolved', answers: { connection_check: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const put = (body: unknown) => app.request('/api/ui/adaptive-routing', { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const state = async () => (await app.request('/api/ui/adaptive-routing/connection-test')).json() as Promise<JevDiagnosticState>;
  const probe = async (revision: string) => (await app.request('/api/ui/adaptive-routing/connection-test', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }) })).json() as Promise<JevDiagnosticResult>;
  assert.equal((await put({ enabled: false, apiKey: 'fixture-diagnostic-key', model: PINNED })).status, 200);
  const first = await state();
  assert.equal((await probe(first.revision)).code, 'success');
  assert.deepEqual(sent, [PINNED]);
  const rejected = await put({ model: 'https://evil.example/v1' });
  assert.equal(rejected.status, 400);
  assert.equal((await put({ model: null })).status, 200);
  assert.equal((await probe(first.revision)).code, 'settings_changed');
  assert.equal((await probe((await state()).revision)).code, 'success');
  assert.deepEqual(sent, [PINNED, TYPESAFE_MODEL]);
  const settings = await (await app.request('/api/ui/adaptive-routing')).json() as { model: string; modelPinned: boolean };
  assert.deepEqual([settings.model, settings.modelPinned], [TYPESAFE_MODEL, false]);
});
