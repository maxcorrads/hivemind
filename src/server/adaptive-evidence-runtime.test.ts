import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { saveAdaptiveRouting } from './adaptive-config.ts';
import { exportAdaptiveEvidence, EVIDENCE_RUN_LIMIT } from './adaptive-evidence.ts';
import { jevTopologyResponse } from './fixtures/jev-topology.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-evidence-runtime-'));
  let hive = new Hive(path.join(dir, 'hive.db'));
  const human = hive.getAgent('human');
  const brain = hive.join({ role: 'brain', project: 'chapter' }).agent;
  const workers = [0, 1, 2].map(() => hive.join({ role: 'worker', seniority: 'senior', project: 'chapter' }).agent);
  const dm = hive.openDm(human, brain.name);
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
    { channel: dm.id, body: 'Private original Human request', requestId: 'root-request' }, 'auto', 'none');
  const check = (id: string) => hive.adaptiveTopology.revalidateForActor(brain, {
    kind: 'brain_message', actorId: brain.id, actorRole: 'brain', channelId: dm.id, eventId: id,
  });
  return { get hive() { return hive; }, dir, human, brain, workers, dm, start, check, calls: () => calls,
    restart: async () => { await hive.adaptiveTopology.stop(); hive.db.close(); hive = new Hive(path.join(dir, 'hive.db')); },
    fail: () => { fail = true; }, beforeReply: (action: () => void) => { hook = action; } };
}

test('runtime evidence counts distinct successful/failing calls but never duplicate votes or agent mail', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const messages = Number(f.hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n);
  await f.check('first-check'); await f.check('first-check'); f.fail(); await f.check('offline-check');
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.equal(report.coverage.attemptsStarted, 3); assert.equal(f.calls(), 3);
  assert.equal(report.overhead.tokenObservations, 2); assert.equal(report.overhead.totalInputTokens, null);
  assert.equal(report.overhead.knownInputTokens, 160);
  assert.equal(Number(f.hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n), messages);
  assert.doesNotMatch(JSON.stringify(report), /Private original|never-export|secret-provider-error/);
  assert.doesNotMatch(JSON.stringify(f.hive.adaptiveTopology.forAgent(f.brain)), /overhead|inputTokens|models|attempts/);
});

test('capacity refresh attempts are retained even when only the final decision starts execution', async t => {
  const f = fixture(t);
  f.beforeReply(() => f.hive.db.prepare('UPDATE agents SET online=0 WHERE id=?').run(f.workers[0]!.id));
  const started = await f.start(); assert.ok(started);
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.equal(f.calls(), 2); assert.equal(report.coverage.attemptsStarted, 2);
  assert.deepEqual(report.attempts.map(a => a.usableWorkers), [3, 2]);
  assert.equal(report.policyEvents.length, 1);
  assert.equal(report.overhead.totalInputTokens, 160);
});

test('stale-key output is charged to observed attempts, not silently dropped from overhead', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const before = f.hive.adaptiveTopology.view(f.human, f.dm.id);
  f.beforeReply(() => saveAdaptiveRouting(f.dir, { apiKey: 'replacement-private-key' }));
  await f.check('stale-check');
  const after = f.hive.adaptiveTopology.view(f.human, f.dm.id);
  assert.equal(after.events.length, before.events.length);
  const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
  assert.equal(report.coverage.attemptsStarted, 2); assert.equal(report.overhead.totalInputTokens, 160);
  assert.doesNotMatch(JSON.stringify(report), /replacement-private-key/);
});

test('recorder failure warns without changing a valid Jev decision or adding a second provider call', async t => {
  const f = fixture(t), started = await f.start(); assert.ok(started);
  const errors: string[] = []; t.mock.method(console, 'error', (message: string) => errors.push(message));
  f.hive.db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON adaptive_evidence_attempts BEGIN SELECT RAISE(ABORT,'secret-database-error'); END;");
  const result = await f.check('recording-fails');
  assert.equal(result?.currentTopology, 'single'); assert.equal(f.calls(), 2);
  assert.ok(errors.some(message => message.includes('measurements may be incomplete')));
  assert.doesNotMatch(errors.join('\n'), /secret-database-error|never-export-this-key/);
});

for (const interleaved of [false, true]) {
  test(`active evidence survives rejected starts and restart with ${interleaved ? 'interleaved' : 'deferred'} revalidation`, async t => {
    const f = fixture(t), started = await f.start(); assert.ok(started);
    const initial = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
    f.hive.db.prepare("UPDATE agents SET online=0 WHERE role='worker'").run();
    for (let i = 0; i < EVIDENCE_RUN_LIMIT; i++) {
      await assert.rejects(f.hive.adaptiveTopology.routeHumanRequest(f.human,
        { channel: f.dm.id, body: 'Rejected manual request', requestId: `rejected-${i}` }, 'brain_multi_room', 'task'),
      /needs 2 available workers/);
      if (i === Math.floor(EVIDENCE_RUN_LIMIT / 2)) await f.restart();
      if (interleaved) await f.check(`between-${i}`);
    }
    assert.equal(f.hive.adaptiveTopology.view(f.human, f.dm.id).state?.executionId, started.state.executionId);
    await f.check('after-rejections');
    const report = exportAdaptiveEvidence(f.hive.db, started.state.executionId);
    const expected = 2 + (interleaved ? EVIDENCE_RUN_LIMIT : 0);
    assert.equal(f.calls(), expected + EVIDENCE_RUN_LIMIT);
    assert.equal(report.coverage.attemptsStarted, expected);
    assert.equal(report.coverage.attemptsFinished, expected);
    assert.equal(report.coverage.startedAt, initial.coverage.startedAt);
    assert.equal(report.coverage.historyComplete, true);
    assert.equal(report.coverage.prunedAttempts, 0);
    assert.equal(report.overhead.totalInputTokens, expected * 80);
    assert.equal(f.hive.db.prepare('SELECT COUNT(*) AS n FROM adaptive_evidence_runs').get()!.n, EVIDENCE_RUN_LIMIT);
  });
}
