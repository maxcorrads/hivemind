import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import type { AdaptiveTopology } from '../shared/adaptive-topology.ts';
import { countRows } from './test-fixtures.ts';

// Intentionally equal suffixes: key hints must never be used to fence a rotation.
const originalKey = 'ts_prior_fixture_secret_same';
const replacementKey = 'ts_rotated_fixture_secret_same';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-topology-settings-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' }).agent;
  for (let index = 0; index < 2; index++) hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' });
  const dm = hive.channels.openDm(human, brain.name);
  let target: AdaptiveTopology = 'single';
  let hook: (() => void) | undefined;
  let serial = 0;
  const authorizations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    const payload = jevTopologyResponse(String(init?.body), target);
    const currentHook = hook; hook = undefined; currentHook?.();
    return Response.json(payload);
  });
  saveAdaptiveRouting(dir, { enabled: true, apiKey: originalKey });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = () => hive.adaptiveTopology.routeHumanRequest(human,
    { channel: dm.id, body: 'Do the bounded Human request.', requestId: `request-${++serial}` }, 'auto', 'none');
  const recheck = () => hive.adaptiveTopology.revalidateForActor(brain, {
    actorId: brain.id, actorRole: 'brain', kind: 'brain_message', channelId: dm.id, eventId: `event-${++serial}`,
  });
  return { hive, human, brain, dm, dir, start, recheck, authorizations,
    choose: (topology: AdaptiveTopology) => { target = topology; },
    beforeReply: (work: () => void) => { hook = work; },
    view: () => hive.adaptiveTopology.view(human, dm.id),
    messageCount: () => countRows(hive, 'messages'),
  };
}

test('initial Jev response cannot commit after API-key rotation with the same public key hint', async t => {
  const f = fixture(t), before = f.messageCount();
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { apiKey: replacementKey }); });
  await assert.rejects(f.start(), /settings changed during initial routing/);
  assert.equal(f.messageCount(), before, 'neither the directive nor the Human request may commit');
  assert.equal(f.view().state, null);
  assert.equal(f.view().events.length, 0);
  const started = await f.start();
  assert.ok(started);
  assert.equal(f.authorizations.at(-1), `Bearer ${replacementKey}`);
});

test('continuous revalidation discards a stale-key result without changing policy or adding confirmation votes', async t => {
  const f = fixture(t); await f.start(); f.choose('brain_multi_room');
  const before = f.view(), messages = f.messageCount();
  // Simulate an atomic config-file update, without relying on the UI revision bump.
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { apiKey: replacementKey }); });
  await f.recheck();
  const stale = f.view();
  assert.equal(stale.state?.currentTopology, 'single');
  assert.equal(stale.state?.revision, before.state?.revision);
  assert.equal(stale.state?.confirmations, before.state?.confirmations);
  assert.equal(stale.events.length, before.events.length);
  await f.recheck();
  assert.equal(f.authorizations.at(-1), `Bearer ${replacementKey}`);
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  assert.equal(f.messageCount(), messages, 'evaluations remain Human-only audit events');
  assert.doesNotMatch(JSON.stringify(f.view()), /ts_prior_fixture_secret|ts_rotated_fixture_secret/);
});

test('re-reading equivalent settings during evaluation is not mistaken for a rotation', async t => {
  const f = fixture(t);
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { enabled: true, apiKey: originalKey }); });
  const started = await f.start(); assert.ok(started);
  f.choose('brain_multi_room');
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { enabled: true, apiKey: originalKey }); });
  await f.recheck();
  assert.equal(f.view().state?.currentTopology, 'brain_multi_room');
  assert.ok(f.view().events.some(event => event.kind === 'transition'));
});

test('non-secret policy changes also invalidate an in-flight initial Jev decision', async t => {
  const f = fixture(t);
  f.beforeReply(() => { saveAdaptiveRouting(f.dir, { topologyFallback: 'brain_multi_room' }); });
  await assert.rejects(f.start(), /settings changed during initial routing/);
  assert.equal(f.view().state, null);
});
