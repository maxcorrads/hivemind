import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hive } from './hive.ts';
import { filePathForHash } from './files.ts';
import { DEFAULT_RETENTION_DAYS, retentionDays, runMaintenance, startMaintenance, type MaintenanceResult } from './maintenance.ts';
import { backdate, countRows, countTables, insertRows, readValue } from './test-fixtures.ts';

const DAY = 86_400_000;
/** What retention must never delete (#217). */
const DURABLE = ['messages', 'threads', 'task_records', 'task_events', 'decision_requests', 'decision_mutations', 'rooms', 'room_events',
  'inbox_receipts', 'inbox_receipt_totals'] as const;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-retention-')), file = path.join(dir, 'hive.db');
  const hive = new Hive(file);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent('human'), brain = hive.identity.join({ role: 'brain' }).agent;
  const a = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent, b = hive.identity.join({ role: 'worker', seniority: 'senior' }).agent;
  const room = hive.channels.createChannel(brain, { name: 'retention-fixture', type: 'private', memberNames: [a.name, b.name] });
  // A room contract lives in its own channel (a contracted room only takes room-keyed assignments).
  const contracted = hive.channels.createChannel(brain, { name: 'retention-room', type: 'private', memberNames: [a.name, b.name] });
  hive.rooms.event(brain, contracted.id, { requestId: 'room-1', expectedRevision: 0, humanInstructionSeq:
    hive.messages.postMessage(human, { channel: contracted.id, body: 'Keep monitoring the fixture.' }).seq,
    action: { type: 'configure', reason: 'Human request', contract: { mode: 'ongoing', purpose: 'Fixture', rules: ['Rule'], limits: ['Limit'],
      coordinator: brain.name, participants: [{ name: a.name, boundary: 'A' }, { name: b.name, boundary: 'B' }], completion: ['Done'], originTaskId: null } } });
  const task = hive.tasks.assign(brain, { requestId: 'task', worker: a.name, channel: room.id,
    contract: { objective: 'Pick a boundary', scope: ['src'], nonGoals: [], acceptanceCriteria: ['Decided'], dependencies: [], evidenceSeqs: [] } }).task;
  const decision = hive.decisions.create(brain, { requestId: 'decision', taskId: task.id,
    expectedTaskRevision: hive.tasks.get(brain, task.id).revision, question: 'Which boundary?',
    options: [{ id: 'x', label: 'X', impact: 'x' }, { id: 'y', label: 'Y', impact: 'y' }],
    recommendation: { optionId: 'x', rationale: 'Simple', uncertainty: 'Low' }, evidenceSeqs: [], artifacts: [],
    affectedWorkers: [a.name, b.name], relatedDecisionIds: [] }).decision;
  const answered = hive.decisions.answer(human, decision.id, { requestId: 'answer', expectedRevision: decision.revision, body: 'Take X.' });
  // Worker A receives and acknowledges its mail; worker B is offered its mail and leaves it pending.
  const sessionA = hive.delivery.openInboxSession(a, crypto.randomUUID());
  for (;;) {
    const got = await hive.delivery.wait(a, 1, undefined, { sessionId: sessionA, compact: true });
    if (!got.delivery) break;
    hive.delivery.acknowledgeInbox(a, sessionA, got.delivery.id);
  }
  const sessionB = hive.delivery.openInboxSession(b, crypto.randomUUID());
  const pending = (await hive.delivery.wait(b, 1, undefined, { sessionId: sessionB, compact: true })).delivery!;
  insertRows(hive, 'inbox_deliveries', [{ id: 'superseded', agent_id: b.id, session_id: sessionB, through_seq: 0, seqs: '[1]', attempts: 1,
    offered_at: 1, lease_until: 2, acknowledged_at: null, superseded_by: pending.id }]);
  insertRows(hive, 'jev_calls', [{ id: 'jev-old', route_id: 'route-old', project_id: room.projectId, channel_id: room.id,
    execution_id: 'execution', created_at: 1, summary: '{}' }]);
  const receipts = () => hive.decisions.get(human, decision.id).delivery.map(item => [item.name, item.state] as const);
  assert.deepEqual(new Map(receipts()).get(a.name), 'acknowledged');
  // Everything is older than the window.
  for (const [table, column] of [['messages', 'created_at'], ['inbox_deliveries', 'offered_at'], ['decision_requests', 'created_at']] as const)
    backdate(hive, table, column);
  backdate(hive, 'inbox_deliveries', 'acknowledged_at', { agent_id: a.id }, 1);
  assert.equal(new Map(receipts()).get(b.name), 'offered');
  return { hive, human, a, b, room, contracted, task, decision, answered, pending, receipts, dir };
}

test('retention prunes only finished inbox deliveries and Jev calls; messages, tasks, decisions and contracts stay', async t => {
  const f = await fixture(t);
  const durable = countTables(f.hive, DURABLE), receipts = f.receipts(), room = f.hive.rooms.view(f.human, f.contracted.id);
  const history = f.hive.rooms.history(f.human, f.contracted.id), task = f.hive.tasks.get(f.human, f.task.id);
  assert.ok(Object.values(durable).every(n => n > 0), 'the fixture populates every durable table');
  const deliveries = countRows(f.hive, 'inbox_deliveries');
  const result = runMaintenance(f.hive, { retentionDays: 30 });
  assert.equal(result.inboxDeliveries, deliveries - 1, 'acknowledged and superseded deliveries are pruned');
  assert.equal(result.jevCalls, 1);
  assert.deepEqual(countTables(f.hive, DURABLE), durable);
  assert.equal(countRows(f.hive, 'inbox_deliveries'), 1);
  assert.equal(readValue(f.hive, 'inbox_deliveries', 'id'), f.pending.id, 'the live delivery is never pruned');
  assert.equal(countRows(f.hive, 'jev_calls'), 0);
  // Receipts survive the ledger: decision delivery stages and the Human views are unchanged.
  assert.deepEqual(f.receipts(), receipts);
  assert.deepEqual(f.hive.rooms.view(f.human, f.contracted.id), room);
  assert.deepEqual(f.hive.rooms.history(f.human, f.contracted.id), history);
  assert.deepEqual(f.hive.tasks.get(f.human, f.task.id), task);
  assert.equal(f.hive.messageQueries.getMessageById(f.answered.message!.id).body, 'Take X.');
  // The pending delivery can still be acknowledged.
  f.hive.delivery.acknowledgeInbox(f.b, f.pending.sessionId, f.pending.id);
  assert.equal(new Map(f.receipts()).get(f.b.name), 'acknowledged');
});

test('retention respects the window and is disabled at 0', async t => {
  const f = await fixture(t);
  const before = countTables(f.hive, ['inbox_deliveries', 'jev_calls', ...DURABLE]);
  const disabled = runMaintenance(f.hive, { retentionDays: 0 });
  assert.deepEqual({ cutoff: disabled.cutoff, inboxDeliveries: disabled.inboxDeliveries, jevCalls: disabled.jevCalls },
    { cutoff: null, inboxDeliveries: 0, jevCalls: 0 });
  assert.deepEqual(countTables(f.hive, ['inbox_deliveries', 'jev_calls', ...DURABLE]), before);
  // Rows are at the epoch: a window reaching back before them keeps everything.
  const wide = runMaintenance(f.hive, { retentionDays: 30, now: 10 * DAY });
  assert.equal(wide.cutoff, -20 * DAY);
  assert.deepEqual(countTables(f.hive, ['inbox_deliveries', 'jev_calls', ...DURABLE]), before);
  const narrow = runMaintenance(f.hive, { retentionDays: 1, now: 2 * DAY });
  assert.ok(narrow.inboxDeliveries > 0 && narrow.jevCalls === 1);
  assert.deepEqual(countTables(f.hive, DURABLE), Object.fromEntries(DURABLE.map(table => [table, before[table]])));
});

test('maintenance collects unsent uploads older than a day and their blobs, but never sent attachments', async t => {
  const f = await fixture(t);
  const sent = await f.hive.files.createFileFromBytes(f.human, { name: 'sent.txt', mime: 'text/plain', bytes: Buffer.from('sent') });
  f.hive.messages.postMessage(f.human, { channel: f.room.id, body: 'with file', attachmentIds: [sent.id] });
  const unsent = await f.hive.files.createFileFromBytes(f.human, { name: 'unsent.txt', mime: 'text/plain', bytes: Buffer.from('unsent') });
  const fresh = await f.hive.files.createFileFromBytes(f.human, { name: 'fresh.txt', mime: 'text/plain', bytes: Buffer.from('fresh') });
  const hash = (id: string) => f.hive.files.getAttachment(f.human, id).sha256;
  const [sentHash, unsentHash, freshHash] = [hash(sent.id), hash(unsent.id), hash(fresh.id)];
  backdate(f.hive, 'attachments', 'created_at', { id: unsent.id });
  backdate(f.hive, 'attachments', 'created_at', { id: sent.id });
  // Collection runs even when log retention is disabled.
  assert.deepEqual(runMaintenance(f.hive, { retentionDays: 0 }).uploads, { attachments: 1, blobs: 1 });
  assert.equal(existsSync(filePathForHash(unsentHash, f.dir)), false);
  assert.ok(existsSync(filePathForHash(sentHash, f.dir)) && existsSync(filePathForHash(freshHash, f.dir)));
  assert.equal(readValue(f.hive, 'upload_usage', 'bytes'), 'sent'.length + 'fresh'.length);
});

test('HIVEMIND_RETENTION_DAYS defaults to 30 days, accepts 0 to disable and rejects anything else', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.equal(retentionDays({}), 30);
  assert.equal(retentionDays({ HIVEMIND_RETENTION_DAYS: '' }), 30);
  assert.equal(retentionDays({ HIVEMIND_RETENTION_DAYS: '0' }), 0);
  assert.equal(retentionDays({ HIVEMIND_RETENTION_DAYS: ' 7 ' }), 7);
  for (const bad of ['-1', '1.5', 'thirty', '36501', '1e3'])
    assert.throws(() => retentionDays({ HIVEMIND_RETENTION_DAYS: bad }), /HIVEMIND_RETENTION_DAYS must be a whole number/);
});

test('the serve maintenance schedule runs a first pass and repeats until stopped', async t => {
  const f = await fixture(t);
  const results: MaintenanceResult[] = [];
  const stop = startMaintenance(f.hive, { retentionDays: 30, firstRunMs: 1, intervalMs: 5, onResult: result => results.push(result) });
  const until = Date.now() + 2000;
  while (results.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  stop();
  assert.ok(results.length >= 2, 'first run and at least one interval run');
  assert.equal(results[0]!.jevCalls, 1);
  const settled = results.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(results.length, settled, 'no pass after stop');
});
