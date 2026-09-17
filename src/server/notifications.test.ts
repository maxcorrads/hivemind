import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { ROUTINE_BATCH_MS } from '../shared/notifications.ts';
import { WAIT_SCAN_MAX, type WaitResult, type Message } from '../shared/types.ts';
import { waitUntilMail } from '../mcp/wait-loop.ts';

function fixture(t: TestContext, fakeClock = false) {
  if (fakeClock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-notifications-'));
  const file = path.join(dir, 'hive.db'); let hive = new Hive(file);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: 'brain' }), peer = hive.join({ role: 'brain' });
  const worker = hive.join({ role: 'worker', seniority: 'mid' });
  const room = hive.createChannel(brain.agent, { name: 'work', type: 'private', memberNames: [peer.agent.name, worker.agent.name] });
  hive.db.exec('UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages)');
  const session = hive.openInboxSession(brain.agent, crypto.randomUUID());
  const wait = (ms = 1) => hive.wait(brain.agent, ms, undefined, { sessionId: session, compact: true });
  const ack = (mail: WaitResult) => hive.acknowledgeInbox(brain.agent, session, mail.delivery!.id);
  const send = (body: string, eventType?: Message['eventType'], threadId?: string) =>
    hive.postMessage(worker.agent, { channel: room.id, body, eventType, threadId });
  return { get hive() { return hive; }, file, brain, peer, worker, room, session, wait, ack, send,
    reopen() { hive.db.close(); hive = new Hive(file); },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('subscriptions persist, scope to self and never grant private/cross-project access', async t => {
  const f = fixture(t), general = f.hive.getChannel('general', f.brain.agent.projectId);
  f.hive.notifications.set(f.brain.agent, { channel: general.id, eventTypes: ['blocker'] });
  const post = (eventType?: Message['eventType']) => f.hive.postMessage(f.worker.agent, { channel: general.id, body: 'Observation', eventType });
  const quiet = post('progress'), alert = post('blocker'), legacy = post();
  assert.equal(f.hive.isFor(f.brain.agent, quiet), false);
  assert.equal(f.hive.isFor(f.peer.agent, alert), false);
  assert.equal(f.hive.isFor(f.brain.agent, legacy), false);
  const mail = await f.wait(); assert.deepEqual(mail.delivery!.messageSeqs, [alert.seq]); f.ack(mail);
  f.reopen(); assert.deepEqual(f.hive.notifications.list(f.brain.agent), [{ channel: general.id, eventTypes: ['blocker'] }]);
  const outsider = f.hive.join({ role: 'brain' });
  assert.throws(() => f.hive.notifications.set(outsider.agent, { channel: f.room.id, eventTypes: ['message'] }), /access/);
  f.hive.createProject(f.hive.getAgent('human'), { name: 'Other', slug: 'other' });
  const other = f.hive.join({ role: 'brain', project: 'other' });
  assert.throws(() => f.hive.notifications.set(other.agent, { channel: f.room.id, eventTypes: ['blocker'] }), /not found/);
  assert.throws(() => f.hive.notifications.set(f.brain.agent, { channel: general.id, eventTypes: ['run'] }), /Invalid/);
  assert.throws(() => f.hive.notifications.set(f.brain.agent, { channel: general.id, eventTypes: [], agentId: f.peer.agent.id }), /Invalid/);
  const bot = f.hive.createBot(f.hive.getAgent('human'), f.room.projectId, { name: 'ObservationBot' });
  assert.throws(() => f.hive.notifications.set(bot.bot, { channel: general.id, eventTypes: [] }), /Only agents/);
  f.hive.notifications.reset(f.brain.agent, { channel: general.id });
  assert.equal(f.hive.isFor(f.brain.agent, post('blocker')), false);
});

test('thread overrides channel, directed mail bypasses filters and reset restores inherited defaults', async t => {
  const f = fixture(t);
  const root = f.send('Root'); f.ack(await f.wait());
  f.hive.notifications.set(f.brain.agent, { channel: f.room.id, eventTypes: [] });
  f.hive.notifications.set(f.brain.agent, { channel: f.room.id, threadId: root.id, eventTypes: ['blocker'] });
  const ordinary = f.send('Quiet', 'progress', root.id), blocker = f.send('Need input', 'blocker', root.id);
  const unrelated = f.send('Other task', 'blocker');
  const direct = f.hive.postMessage(f.worker.agent, { channel: f.room.id, body: 'Target', recipients: [f.brain.agent.name], eventType: 'decision' });
  const mention = f.send(`@${f.brain.agent.name} Question`, 'question');
  assert.equal(f.hive.isFor(f.peer.agent, direct), false);
  const result = await f.wait(); assert.deepEqual(result.delivery!.messageSeqs, [blocker.seq, direct.seq, mention.seq]); f.ack(result);
  assert.ok(!result.delivery!.messageSeqs.includes(ordinary.seq) && !result.delivery!.messageSeqs.includes(unrelated.seq));
  assert.deepEqual(f.hive.getMessageById(direct.id).recipientIds, [f.brain.agent.id]);
  f.hive.notifications.reset(f.brain.agent, { channel: f.room.id, threadId: root.id });
  assert.equal(f.hive.isFor(f.brain.agent, f.send('Inherited mute', 'blocker', root.id)), false);
  f.hive.notifications.reset(f.brain.agent, { channel: f.room.id });
  assert.equal(f.hive.isFor(f.brain.agent, f.send('Default', undefined, root.id)), true);
  assert.throws(() => f.hive.notifications.set(f.brain.agent, { channel: f.room.id, threadId: blocker.id, eventTypes: [] }), /root/);
});

test('pending receipts replay unchanged across subscription edits and restart; revoked access still rejects replay', async t => {
  const f = fixture(t); const original = f.send('Pending'); const first = await f.wait();
  f.hive.notifications.set(f.brain.agent, { channel: f.room.id, eventTypes: [] });
  f.reopen(); const replay = await f.wait();
  assert.equal(replay.delivery!.id, first.delivery!.id); assert.deepEqual(replay.delivery!.messageSeqs, [original.seq]);
  f.hive.db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?').run(f.room.id, f.brain.agent.id);
  await assert.rejects(f.wait(), /no longer accessible/);
  assert.equal(f.hive.inbox.pending(f.brain.agent.id)!.id, first.delivery!.id);
});

test('upgrade adds routing storage without reclassifying legacy chat or losing an offered receipt', async t => {
  const f = fixture(t); const original = f.send('Legacy chat'); const before = await f.wait();
  f.hive.db.exec('DROP TABLE notification_subscriptions; ALTER TABLE messages DROP COLUMN recipients');
  f.reopen(); const replay = await f.wait();
  assert.equal(replay.delivery!.id, before.delivery!.id);
  assert.deepEqual(replay.delivery!.messageSeqs, [original.seq]);
  assert.equal(replay.mail![0].body, original.body);
  assert.deepEqual(f.hive.notifications.list(f.brain.agent), []);
  f.ack(replay);
});

test('structured tasks notify participants, not unrelated room peers, with optional observer subscription', async t => {
  const f = fixture(t);
  const peerSession = f.hive.openInboxSession(f.peer.agent, crypto.randomUUID());
  const assigned = f.hive.tasks.assign(f.brain.agent, { requestId: 'assignment', channel: f.room.id, worker: f.worker.agent.name,
    contract: { objective: 'Fixture task', scope: ['Parser'], nonGoals: [], acceptanceCriteria: ['Checked'], dependencies: [], evidenceSeqs: [] } });
  assert.equal(f.hive.isFor(f.worker.agent, assigned.message), true);
  assert.equal(f.hive.isFor(f.peer.agent, assigned.message), false);
  assert.equal((await f.hive.wait(f.peer.agent, 1, undefined, { sessionId: peerSession })).idle, true);
  f.hive.notifications.set(f.peer.agent, { channel: f.room.id, threadId: assigned.task.id, eventTypes: ['blocker'] });
  f.hive.tasks.event(f.worker.agent, assigned.task.id, { requestId: 'accept', expectedRevision: 1, action: { type: 'accept' } });
  const blocked = f.hive.tasks.event(f.worker.agent, assigned.task.id, { requestId: 'block', expectedRevision: 2,
    action: { type: 'block', needed: 'Supply fixture' } });
  const peerMail = await f.hive.wait(f.peer.agent, 1, undefined, { sessionId: peerSession });
  assert.deepEqual(peerMail.delivery!.messageSeqs, [blocked.message.seq]);
  assert.ok(peerMail.messages[0].taskEvent);
});

test('acknowledgement-only chatter creates no wake loop, including mentions; evidence and Human decisions remain deliverable', async t => {
  const f = fixture(t, true); let returned = false;
  const pending = f.wait(1000).then(value => { returned = true; return value; });
  for (let i = 0; i < 20; i++) f.send(`@${f.brain.agent.name} Thanks ${i}`, 'acknowledgement');
  await flush(); assert.equal(returned, false);
  t.mock.timers.tick(1000); const idle = await pending; assert.equal(idle.idle, true);
  const file = await f.hive.createFileFromBytes(f.worker.agent, { name: 'evidence.txt', mime: 'text/plain', bytes: new TextEncoder().encode('fixture') });
  const evidence = f.hive.postMessage(f.worker.agent, { channel: f.room.id, body: 'Receipt with evidence', eventType: 'acknowledgement', attachmentIds: [file.id] });
  const human = f.hive.postMessage(f.hive.getAgent('human'), { channel: f.room.id, body: 'Proceed', eventType: 'decision' });
  const delivered = await f.wait(); assert.deepEqual(delivered.delivery!.messageSeqs, [evidence.seq, human.seq]);
  assert.equal(f.hive.listMessages(f.brain.agent, f.room.id, { limit: 100 }).messages.filter(m => m.eventType === 'acknowledgement').length, 21);
});

test('fixed progress window coalesces same-thread mail for one channel; blockers and Human decisions bypass it', async t => {
  const f = fixture(t, true); let returned = false;
  const pending = f.wait(1000).then(value => { returned = true; return value; });
  const root = f.send('Step 0', 'progress');
  t.mock.timers.tick(100); f.send('Step 1', 'progress', root.id);
  t.mock.timers.tick(149); await flush(); assert.equal(returned, false);
  t.mock.timers.tick(1); const mail = await pending;
  assert.equal(mail.mail!.length, 1); assert.equal(mail.mail![0].count, 2);
  assert.equal(Date.now(), 1_000_000 + ROUTINE_BATCH_MS);
  assert.equal(f.hive.expandDigest(f.brain.agent, mail.mail![0].expand).messages.length, 2); f.ack(mail);
  for (const author of [f.worker.agent, f.hive.getAgent('human')]) {
    const active = f.wait(1000); f.send('Batch next progress', 'progress', root.id);
    t.mock.timers.tick(10);
    const urgent = f.hive.postMessage(author, { channel: f.room.id, body: 'Need decision now',
      eventType: author.role === 'human' ? 'decision' : 'blocker', threadId: root.id });
    const before = Date.now(); const result = await active;
    assert.ok(result.delivery!.messageSeqs.includes(urgent.seq)); assert.equal(Date.now(), before); f.ack(result);
  }
});

test('short polls and restart preserve the progress deadline without consuming mail early', async t => {
  const f = fixture(t, true); const original = f.send('Update', 'progress');
  const earlyWait = f.wait(10); t.mock.timers.tick(10); const early = await earlyWait;
  assert.equal(early.idle, true); assert.equal(early.retryAfterMs, 240); assert.equal(early.delivery, undefined);
  assert.ok(early.page!.afterAckThroughSeq < original.seq);
  f.reopen(); t.mock.timers.tick(90);
  f.send('Still updating', 'progress', original.id);
  const next = f.wait(1000); t.mock.timers.tick(150); const mail = await next;
  assert.equal(mail.mail![0].count, 2); assert.equal(Date.now(), 1_000_250);
});

test('cancellation and session replacement clean up routine timers without reserving unsent mail', async t => {
  const f = fixture(t, true); f.send('Pending progress', 'progress');
  const abort = new AbortController();
  const old = f.hive.wait(f.brain.agent, 1000, abort.signal, { sessionId: f.session });
  abort.abort(); assert.equal((await old).delivery, undefined);
  const replaced = f.wait(1000);
  const rejection = assert.rejects(replaced, /superseded/);
  const nextSession = f.hive.openInboxSession(f.brain.agent, crypto.randomUUID()); await rejection;
  t.mock.timers.tick(ROUTINE_BATCH_MS);
  assert.equal(f.hive.inbox.pending(f.brain.agent.id), undefined);
  const mail = await f.hive.wait(f.brain.agent, 1000, undefined, { sessionId: nextSession });
  assert.equal(mail.delivery!.messageSeqs.length, 1);
});

test('round-robin conversation delivery and reserved critical slots preserve ACK holes under continuous noise', async t => {
  const f = fixture(t, true);
  const readerSession = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  const root = f.hive.postMessage(f.brain.agent, { channel: f.room.id, body: 'Busy task' });
  const expected = [root.seq];
  for (let i = 0; i < 32; i++) expected.push(f.hive.postMessage(f.brain.agent, { channel: f.room.id, threadId: root.id, body: 'Busy status' }).seq);
  const quiet = f.hive.postMessage(f.brain.agent, { channel: f.room.id, body: 'Quiet task' }); expected.push(quiet.seq);
  const urgent = f.hive.postMessage(f.brain.agent, { channel: f.room.id, body: 'Blocked', eventType: 'blocker' }); expected.push(urgent.seq);
  const seen: number[] = [];
  for (let batch = 0; seen.length < expected.length; batch++) {
    assert.ok(batch < 12, 'No task may starve behind newer noise');
    const result = await f.hive.wait(f.worker.agent, 1000, undefined, { sessionId: readerSession, compact: true });
    assert.ok(result.page!.scannedRows <= WAIT_SCAN_MAX);
    if (batch === 0) {
      assert.ok(result.delivery!.messageSeqs.includes(quiet.seq)); assert.ok(result.delivery!.messageSeqs.includes(urgent.seq));
      assert.ok(result.page!.afterAckThroughSeq < quiet.seq);
    }
    seen.push(...result.delivery!.messageSeqs);
    f.hive.acknowledgeInbox(f.worker.agent, readerSession, result.delivery!.id);
    if (batch < 3) expected.push(f.hive.postMessage(f.brain.agent, { channel: f.room.id, body: 'New busy status', threadId: root.id }).seq);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), expected.sort((a, b) => a - b)); assert.equal(new Set(seen).size, seen.length);
});

test('HTTP subscriptions and recipients reject forged identities and invalid targets without posting', async t => {
  const f = fixture(t), app = createApp(f.hive);
  const post = (url: string, body: unknown, token = f.brain.token) => app.request('/api/agent' + url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/subscriptions', { channel: f.room.id, eventTypes: ['decision'] })).status, 200);
  assert.equal((await post('/subscriptions', { channel: f.room.id, eventTypes: [], agentId: f.worker.agent.id })).status, 400);
  const before = f.hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n;
  for (const recipients of [[], 'all', [123], ['Nobody'], ['Human'], Array(33).fill(f.brain.agent.name)]) {
    const response = await post(`/channels/${f.room.id}/messages`, { body: 'Invalid', recipients }, f.worker.token);
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(f.hive.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, before);
  assert.equal((await post('/subscriptions/reset', { channel: f.room.id })).status, 200);
  assert.equal((await post(`/channels/${f.room.id}/messages`, { body: 'Direct', recipients: [f.brain.agent.name] }, f.worker.token)).status, 200);
});

test('explicit Human recipients populate For you on live ingress, snapshot and reload, respecting project and read state', async t => {
  const f = fixture(t); let app = createApp(f.hive);
  const human = f.hive.getAgent('human'), general = f.hive.getChannel('general', f.brain.agent.projectId);
  let live: Message | undefined;
  f.hive.bus.once('message', (message: Message) => { live = message; });
  const response = await app.request(`/api/agent/channels/${general.id}/messages`, { method: 'POST',
    headers: { authorization: `Bearer ${f.brain.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Decision needed', recipients: ['hUmAn'], eventType: 'question' }) });
  assert.equal(response.status, 200);
  const sent = await response.json() as { id: string; seq: number };
  assert.equal(live!.id, sent.id); assert.deepEqual(live!.recipientIds, ['human']);
  assert.deepEqual(live!.mentions, [], 'Recipient metadata must not manufacture a textual mention');
  const alsoMentioned = f.hive.postMessage(f.brain.agent, { channel: f.room.id,
    body: '@Human Another question', recipients: ['Human'], eventType: 'question' });
  const elsewhere = f.hive.createProject(human, { name: 'Other notifications', slug: 'other-notifications' });
  const otherBrain = f.hive.join({ role: 'brain', project: elsewhere.slug });
  const other = f.hive.postMessage(otherBrain.agent, { channel: 'general', body: 'Other decision', recipients: ['Human'] });
  const expected = [other.id, alsoMentioned.id, sent.id];
  const snapshot = await (await app.request('/api/ui/snapshot')).json() as { mentions: Message[] };
  assert.deepEqual(snapshot.mentions.map(m => m.id), expected);
  assert.deepEqual(f.hive.mentionInbox(human, 30, undefined, f.room.projectId).messages.map(m => m.id), [alsoMentioned.id, sent.id]);
  assert.deepEqual(f.hive.mentionInbox(human, 30, alsoMentioned.seq, f.room.projectId).messages.map(m => m.id), [sent.id]);
  f.reopen(); app = createApp(f.hive);
  const restored = await (await app.request('/api/ui/mentions')).json() as { messages: Message[] };
  assert.deepEqual(restored.messages.map(m => m.id), expected);
  f.hive.markRead(human, general.id, sent.seq);
  assert.deepEqual(f.hive.mentionInbox(human).messages.map(m => m.id), [other.id, alsoMentioned.id]);
  await app.request('/api/ui/mentions/seen', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: f.room.project }) });
  assert.deepEqual(f.hive.mentionInbox(human).messages.map(m => m.id), [other.id]);
});

test('attachment-only messages can target Human without permitting worker-to-Human messages', async t => {
  const f = fixture(t), human = f.hive.getAgent('human');
  const file = await f.hive.createFileFromBytes(f.brain.agent, { name: 'report.txt', mime: 'text/plain', bytes: new TextEncoder().encode('fixture report') });
  const sent = f.hive.postMessage(f.brain.agent, { channel: f.room.id, body: '', recipients: ['Human'], attachmentIds: [file.id] });
  const inbox = f.hive.mentionInbox(human).messages;
  assert.deepEqual(inbox.map(m => m.id), [sent.id]); assert.equal(inbox[0].attachments![0].id, file.id);
  for (const recipients of [['Human'], [f.brain.agent.name, 'hUmAn']])
    assert.throws(() => f.hive.postMessage(f.worker.agent, { channel: f.room.id, body: 'Request', recipients }), /permitted person/);
  assert.deepEqual(f.hive.mentionInbox(human).messages.map(m => m.id), [sent.id]);
});

test('directed progress stays immediate and full, retaining intended recipients through replay', async t => {
  const f = fixture(t, true);
  const original = f.hive.postMessage(f.worker.agent, { channel: f.room.id, body: 'Direct progress',
    eventType: 'progress', recipients: [f.brain.agent.name] });
  f.hive.postMessage(f.worker.agent, { channel: f.room.id, body: 'Direct progress two', threadId: original.id,
    eventType: 'progress', recipients: [f.brain.agent.name] });
  const mail = await f.wait(); assert.equal(mail.mail!.length, 2);
  assert.ok(mail.mail!.every(m => m.body && !m.expand));
  assert.ok(mail.mail!.every(m => m.recipientIds?.includes(f.brain.agent.id)));
  assert.equal(Date.now(), 1_000_000);
  f.reopen(); assert.deepEqual((await f.wait()).mail, mail.mail);
});

test('subscription cleanup follows project deletion without leaving stale channel rules', t => {
  const f = fixture(t);
  f.hive.notifications.set(f.brain.agent, { channel: f.room.id, eventTypes: ['message'] });
  f.hive.db.exec("UPDATE agents SET online = 0 WHERE role != 'human'");
  f.hive.deleteProject(f.hive.getAgent('human'), f.room.project);
  assert.equal(f.hive.db.prepare('SELECT COUNT(*) AS n FROM notification_subscriptions').get()!.n, 0);
});

test('controlled task replay measures model-returning waits, not idle HTTP polls', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const run = async (legacyPolicy: boolean) => {
    const f = fixture(t);
    if (legacyPolicy) {
      // Explicit reference-policy adapter, not an old-binary or model-cost benchmark.
      // Replay the previous broadcast/no-batching rule through the same actual wait/ACK pipeline.
      const classify = f.hive.notifications.classify.bind(f.hive.notifications);
      f.hive.notifications.classify = (actor, row, pending) => ({ ...classify(actor, row, pending),
        addressed: Number(Boolean(row.visible && !row.received && row.author_id !== actor.id &&
          (row.mentioned || row.kind === 'control' || ['dm', 'private', 'brains'].includes(row.type)))),
        urgent: Number(Boolean(row.mentioned || row.kind === 'control')), routine: false });
    }
    let httpCalls = 0, modelReturningWaits = 0, addressedWakeSignals = 0;
    f.hive.bus.on('message', (m: Message) => { if (f.hive.isFor(f.brain.agent, m)) addressedWakeSignals++; });
    const assigned = f.hive.tasks.assign(f.brain.agent, { requestId: 'measured-assignment', channel: f.room.id, worker: f.worker.agent.name,
      contract: { objective: 'Verify fixture', scope: ['Parser'], nonGoals: [], acceptanceCriteria: ['Checked'], dependencies: [], evidenceSeqs: [] } });
    const taskId = assigned.task.id;
    const consumer = (async () => {
      for (;;) {
        const mail = await waitUntilMail(async () => { httpCalls++; return f.wait(1000); });
        modelReturningWaits++; f.ack(mail);
        if (mail.mail?.some(m => m.taskEvent?.action.type === 'result')) {
          f.hive.tasks.event(f.brain.agent, taskId, { requestId: 'measured-review', expectedRevision: 3,
            action: { type: 'review', decision: 'accepted', summary: 'Fixture checked', evidenceSeqs: [] } });
          return;
        }
      }
    })();
    f.hive.tasks.event(f.worker.agent, taskId, { requestId: 'measured-accept', expectedRevision: 1, action: { type: 'accept' } });
    await flush();
    for (let i = 0; i < 8; i++) { f.send(`Progress ${i}`, 'progress', taskId); await flush(); t.mock.timers.tick(20); }
    t.mock.timers.tick(90); await flush();
    for (let i = 0; i < 8; i++) { f.send('Thanks', 'acknowledgement', taskId); await flush(); }
    f.hive.tasks.event(f.worker.agent, taskId, { requestId: 'measured-result', expectedRevision: 2,
      action: { type: 'result', result: { summary: 'Fixture checked', artifacts: [], checks: [], gaps: [], evidenceSeqs: [] } } });
    await consumer;
    assert.equal(f.hive.tasks.get(f.brain.agent, taskId).state, 'accepted_complete');
    assert.equal(f.hive.listMessages(f.brain.agent, f.room.id, { threadId: taskId, limit: 100 }).messages.length, 20);
    return { completedTasks: 1, httpCalls, modelReturningWaits, addressedWakeSignals };
  };
  const baseline = await run(true), targeted = await run(false);
  assert.deepEqual(baseline, { completedTasks: 1, httpCalls: 18, modelReturningWaits: 18, addressedWakeSignals: 18 });
  assert.deepEqual(targeted, { completedTasks: 1, httpCalls: 3, modelReturningWaits: 3, addressedWakeSignals: 10 });
  t.diagnostic(JSON.stringify({ referencePolicy: baseline, targetedPolicy: targeted }));
});
