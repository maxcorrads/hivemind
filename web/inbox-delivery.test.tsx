import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from '../src/server/hive.ts';

test("queue badge distinguishes exact, lower-bound and unknown counts", () => {
  assert.equal(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 0, exact: true }} />), "");
  assert.match(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 3, exact: true }} />), />3</);
  assert.match(renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 3, exact: false }} />), />3\+</);
  const unknown = renderToStaticMarkup(<QueueBadge estimate={{ atLeast: 0, exact: false }} />);
  assert.match(unknown, /Queue size unknown/);
  assert.match(unknown, />…</);
  assert.match(renderToStaticMarkup(<QueueBadge count={2} />), />2</);
});

test("receipt UI distinguishes offered mail from confirmed receipt and never claims task completion", () => {
  const html = renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 2, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />);
  assert.match(html, /Receipt pending: 2/); assert.match(html, /Received: 5/);
  assert.match(html, /does not mean the tasks were accepted, completed or reviewed/);
  assert.match(html, /Retained for redelivery/);
  assert.equal(renderToStaticMarkup(<InboxReceipt />), "");
  assert.doesNotMatch(renderToStaticMarkup(<InboxReceipt status={{ awaitingReceipt: 0, acknowledgedMessages: 5, lastAcknowledgedAt: 10 }} />), /Receipt pending/);
});

test('explicit Human recipients enter For you once and remain until the exact scoped receipt', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'human-target-read-'));
  const hive = new Hive(path.join(dir, 'hive.db'));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent('human'), brain = hive.join({ role: 'brain' }).agent;
  const room = hive.createChannel(brain, { name: 'targeted-read', type: 'private' });
  const root = hive.postMessage(brain, { channel: room.id, body: 'Decision needed', recipients: ['Human'] });
  const reply = hive.postMessage(brain, { channel: room.id, threadId: root.id,
    body: '@Human follow-up', recipients: ['Human'] });
  const before = hive.readSnapshot(human);
  assert.deepEqual(before.mentions.map(m => m.id), [reply.id, root.id]);
  assert.equal(before.mentionCounts[brain.project!], 2);
  // A GET/open view is read-only. Mention plus explicit recipient must count once.
  hive.listMessages(human, room.id);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id, root.id]);
  hive.markMessagesRead(human, room.id, [root.seq]);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id]);
  hive.markMessagesRead(human, room.id, [root.seq]);
  assert.deepEqual(hive.readSnapshot(human).mentions.map(m => m.id), [reply.id]);
  hive.markMessagesRead(human, room.id, [reply.seq], root.id);
  assert.deepEqual(hive.readSnapshot(human).mentions, []);
  const next = hive.postMessage(brain, { channel: room.id, body: 'Next decision', recipients: ['Human'] });
  assert.deepEqual(hive.mentionInbox(human).messages.map(m => m.id), [next.id]);
  hive.markMentionsSeen(human, brain.projectId!);
  assert.deepEqual(hive.readSnapshot(human).mentions, []);
  assert.equal(before.mentions.length, 2, 'Do not mutate previous read snapshots');
});
