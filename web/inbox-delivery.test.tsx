import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxReceipt, QueueBadge } from "./InboxReceipt.tsx";
import { applyMessageToSnap } from './App.tsx';
import type { Snapshot } from './api.ts';
import type { Message } from '../src/shared/types.ts';

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

test('live explicit Human recipients enter For you once and obey the existing viewing rules', () => {
  const snap: Snapshot = { you: { id: 'human', name: 'Human', role: 'human', seniority: null, focus: null,
    online: true, lastSeenAt: 0, createdAt: 0, projectId: null, project: null },
    projects: [], agents: [], channels: [], unread: {}, mentions: [], queued: {} };
  const message: Message = { id: 'direct', seq: 1, channelId: 'work', threadId: null, authorId: 'brain',
    authorName: 'Aster', authorRole: 'brain', body: 'Decision needed', kind: 'chat', control: null,
    mentions: [], recipientIds: ['human'], createdAt: 0 };
  const live = applyMessageToSnap(snap, message, null);
  assert.deepEqual(live.mentions, [message]); assert.equal(live.unread.work, 1);
  assert.equal(applyMessageToSnap(live, message, null).mentions.length, 1);
  assert.equal(applyMessageToSnap(live, { ...message, mentions: ['human'] }, null).mentions.length, 1);
  assert.deepEqual(applyMessageToSnap(snap, message, 'work').mentions, []);
  const reply = { ...message, threadId: 'root' };
  assert.deepEqual(applyMessageToSnap(snap, reply, 'work', 'root').mentions, []);
  assert.deepEqual(applyMessageToSnap(snap, reply, 'work', 'other-root').mentions, [reply]);
  assert.deepEqual(applyMessageToSnap(snap, { ...message, recipientIds: ['another-agent'] }, null).mentions, []);
  assert.equal(applyMessageToSnap(snap, { ...message, recipientIds: undefined, mentions: ['human'] }, null).mentions.length, 1);
  assert.deepEqual(snap.mentions, [], 'Do not mutate the previous snapshot');
});
