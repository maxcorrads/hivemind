import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { exportAdaptiveEvidence, EVIDENCE_RUN_LIMIT } from './adaptive-evidence.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';
import { countRows, failWrites } from './test-fixtures.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-evidence-runtime-'));
  let hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.identity.getAgent('human');
  const brain = hive.identity.join({ role: 'brain', project: 'chapter' }).agent;
  const workers = [0, 1, 2].map(() => hive.identity.join({ role: 'worker', seniority: 'senior', project: 'chapter' }).agent);
  const dm = hive.channels.openDm(human, brain.name);
  saveAdaptiveRouting(dir, { enabled: true, apiKey: 'never-export-this-key' });
  let calls = 0, fail = false, hook: (() => void) | null = null;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone'); calls++;
    if (fail) throw new Error('secret-provider-error');
    const response = jevTopologyResponse(String(init?.body), 'single');
    const action = hook; hook = null; action?.();
    return Response.json(response);
  });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = () => hive.adaptiveTopology.routeHumanRequest(human,
    { channel: dm.id, body: 'Private original Human request', requestId: 'root-request' });
  const check = (summary: string) => hive.adaptiveTopology.adviseBrainAction(brain, { kind: 'brain_message', channelId: dm.id, summary });
  return { get hive() { return hive; }, dir, human, brain, workers, dm, start, check, calls: () => calls,
    restart: async () => { await hive.adaptiveTopology.stop(); hive.db.close(); hive = new Hive(path.join(dir, 'hive.db')); },
    fail: () => { fail = true; }, beforeReply: (action: () => void) => { hook = action; } };
}

test('runtime evidence counts every successful and failing advice call, and never becomes agent mail', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const messages = countRows(f.hive, 'messages');
  const advice = await f.check('first-check'); await f.check('second-check'); f.fail(); await f.check('offline-check');
  const report = exportAdaptiveEvidence(f.hive.db, started.states[0]!.executionId);
  assert.equal(report.coverage.attemptsStarted, 4); assert.equal(f.calls(), 4);
  assert.equal(report.policyVersion, 'topology-advisory-v1');
  assert.equal(report.overhead.tokenObservations, 3); assert.equal(report.overhead.totalInputTokens, null);
  assert.equal(report.overhead.knownInputTokens, 240);
  assert.deepEqual(report.policyEvents.map(event => [event.kind, event.changed]), Array(4).fill(['advice', false]));
  assert.equal(countRows(f.hive, 'messages'), messages);
  assert.doesNotMatch(JSON.stringify(report), /Private original|never-export|secret-provider-error/);
  assert.doesNotMatch(JSON.stringify(advice), /overhead|inputTokens|models|attempts/);
});

test('recorder failure warns without changing valid advice or adding a second provider call', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const errors: string[] = []; t.mock.method(console, 'error', (message: string) => errors.push(message));
  failWrites(f.hive, 'adaptive_evidence_attempts', { message: 'secret-database-error', persistent: true });
  const result = await f.check('recording-fails');
  assert.equal(result?.plan, 'single'); assert.equal(result?.state, 'ok'); assert.equal(f.calls(), 2);
  assert.ok(errors.some(message => message.includes('measurements may be incomplete')));
  assert.doesNotMatch(errors.join('\n'), /secret-database-error|never-export-this-key/);
});

test('evidence of the open request survives a restart and later requests in the channel', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const executionId = started.states[0]!.executionId;
  const initial = exportAdaptiveEvidence(f.hive.db, executionId);
  await f.restart();
  await f.check('after-restart');
  const report = exportAdaptiveEvidence(f.hive.db, executionId);
  assert.equal(report.coverage.attemptsStarted, 2);
  assert.equal(report.coverage.startedAt, initial.coverage.startedAt);
  assert.equal(report.coverage.historyComplete, true);
  assert.equal(countRows(f.hive, 'adaptive_evidence_runs'), 1);
  assert.ok(EVIDENCE_RUN_LIMIT > 1);
});
