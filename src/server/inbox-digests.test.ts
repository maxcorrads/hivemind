import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { waitWireBytes } from "./wait-format.ts";
import { WAIT_MAX_BYTES, type DigestExpansionResult, type Message, type WaitResult } from "../shared/types.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-digests-"));
  const file = path.join(dir, "hive.db");
  let hive = new Hive(file);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const room = hive.createChannel(brain.agent, { name: "parallel-work", type: "private", memberNames: [worker.agent.name] });
  hive.db.prepare("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages) WHERE id = ?").run(brain.agent.id);
  const sessionId = hive.openInboxSession(brain.agent, crypto.randomUUID());
  const send = (body: string, eventType?: Message["eventType"], threadId?: string, channel = dm.id) =>
    hive.postMessage(worker.agent, { channel, body, eventType, threadId });
  const other = () => send("Other task", "progress", undefined, room.id);
  const wait = () => hive.wait(brain.agent, 1, undefined, { compact: true, sessionId });
  return { get hive() { return hive; }, dir, file, brain, worker, dm, room, sessionId, send, other, wait,
    reopen() { hive.db.close(); hive = new Hive(file); return hive; },
  };
}

function bounded(result: WaitResult | DigestExpansionResult) {
  const text = JSON.stringify(result, null, 2);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] })) <= WAIT_MAX_BYTES);
  if ("idle" in result) assert.ok(waitWireBytes(result) <= WAIT_MAX_BYTES);
}

test("blockers, questions, actions and untyped legacy messages stay full after later progress", async t => {
  const f = fixture(t);
  const important = [undefined, "blocker", "question", "action_required"].map(eventType =>
    f.send("Context ".repeat(30) + "BLOCKED: decision required", eventType as Message["eventType"]));
  for (const root of important) f.send("Thanks", "progress", root.id);
  f.other();
  const result = await f.wait(); bounded(result);
  for (const message of important) {
    const item = result.mail!.find(m => m.seq === message.seq)!;
    assert.equal(item.body, message.body);
    assert.equal(item.eventType, message.eventType);
    assert.equal(item.messageId, message.id);
    assert.equal(item.rootId, message.id);
    assert.equal(item.expand, undefined);
  }
  assert.match(result.next, /summarized, not handled/);
});

test("digests separate roots and authors and include exact IDs, sequence bounds and root references", async t => {
  const f = fixture(t);
  const roots = [f.send("Task A progress", "progress"), f.send("Task B progress", "progress")];
  const expected = roots.map(root => [root, f.send("Update", "progress", root.id), f.send("Thanks", "progress", root.id)]);
  const secondWorker = f.hive.join({ role: "worker", seniority: "mid" });
  f.hive.invite(f.brain.agent, f.room.id, [secondWorker.agent.name]);
  const roomRoot = f.send("Room update", "progress", undefined, f.room.id);
  const otherAuthor = f.hive.postMessage(secondWorker.agent, { channel: f.room.id, threadId: roomRoot.id, body: "Different author", eventType: "progress" });
  const result = await f.wait(); bounded(result);
  for (const messages of expected) {
    const digest = result.mail!.find(m => m.rootId === messages[0].id)!;
    assert.equal(digest.count, 3);
    assert.equal(digest.firstSeq, messages[0].seq);
    assert.equal(digest.lastSeq, messages.at(-1)!.seq);
    assert.equal(digest.messageId, messages.at(-1)!.id);
    assert.equal(digest.attachmentCount, 0);
    assert.deepEqual(digest.expand, { channel: f.dm.id, messageIds: messages.map(m => m.id) });
    assert.deepEqual(f.hive.expandDigest(f.brain.agent, digest.expand).messages.map(m => m.id), messages.map(m => m.id));
  }
  const roomEntries = result.mail!.filter(m => m.rootId === roomRoot.id);
  assert.equal(roomEntries.length, 2);
  assert.ok(roomEntries.some(m => m.messageId === otherAuthor.id && m.count === 1));
});

test("a first-message compact result can start a reply without a history scan", async t => {
  const f = fixture(t);
  const root = f.send("Can you clarify?", "question");
  const result = await f.wait(); bounded(result);
  const item = result.mail![0];
  const reply = f.hive.postMessage(f.brain.agent, { channel: item.channelId, threadId: item.rootId, body: "Here is the clarification" });
  assert.equal(item.messageId, root.id);
  assert.equal(reply.threadId, root.id);
  const control = f.hive.clearContext(f.brain.agent, f.worker.agent.name);
  const workerSession = f.hive.openInboxSession(f.worker.agent, crypto.randomUUID());
  const workerMail = await f.hive.wait(f.worker.agent, 1, undefined, { compact: true, sessionId: workerSession });
  const compactControl = workerMail.control.find(m => m.seq === control.seq)!;
  assert.ok("messageId" in compactControl);
  assert.equal(compactControl.messageId, control.id);
  assert.equal(compactControl.channelId, control.channelId);
});

test("exact digest expansion paginates after ACK and restart without including interleaved or newer mail", async t => {
  const f = fixture(t);
  const root = f.send("Step zero", "progress");
  const expected = [root];
  for (let i = 1; i < 35; i++) {
    f.hive.postMessage(f.brain.agent, { channel: f.dm.id, threadId: root.id, body: "Interleaved instruction" });
    expected.push(f.send(`Step ${i}`, "progress", root.id));
  }
  f.other();
  const batch = await f.wait(); bounded(batch);
  const digest = batch.mail!.find(m => m.rootId === root.id)!;
  assert.equal(digest.count, expected.length);
  const pending = f.hive.inbox.status(f.brain.agent.id);
  const first = f.hive.expandDigest(f.brain.agent, digest.expand); bounded(first);
  assert.equal(first.hasMore, true);
  assert.equal(first.messages.length, 8);
  assert.deepEqual(f.hive.inbox.status(f.brain.agent.id), pending, "Expansion must not ACK");
  f.hive.acknowledgeInbox(f.brain.agent, f.sessionId, batch.delivery!.id);
  const acked = f.hive.inbox.status(f.brain.agent.id);
  f.send("Later update", "progress", root.id);
  f.reopen();
  const seen = [...first.messages];
  let page = first;
  while (page.hasMore) {
    page = f.hive.expandDigest(f.brain.agent, { ...digest.expand!, afterSeq: page.nextAfterSeq });
    bounded(page); seen.push(...page.messages);
  }
  assert.equal(page.nextAfterSeq, null);
  assert.deepEqual(seen.map(m => m.id), expected.map(m => m.id));
  assert.deepEqual(f.hive.inbox.status(f.brain.agent.id), acked);
  assert.deepEqual(f.hive.expandDigest(f.brain.agent, { ...digest.expand!, afterSeq: expected.at(-1)!.seq }),
    { messages: [], hasMore: false, nextAfterSeq: null });
});

test("expansion rejects invisible, mixed-channel, missing and invalid references without altering receipts", async t => {
  const f = fixture(t);
  const message = f.send("Selected", "progress");
  const other = f.other();
  const batch = await f.wait();
  const reference = { channel: f.dm.id, messageIds: [message.id] };
  const before = f.hive.inbox.status(f.brain.agent.id);
  const outsider = f.hive.join({ role: "worker", seniority: "mid" });
  assert.throws(() => f.hive.expandDigest(outsider.agent, reference), /Cannot read/);
  assert.throws(() => f.hive.expandDigest(f.brain.agent, { ...reference, messageIds: [message.id, other.id] }), /outside this channel/);
  assert.throws(() => f.hive.expandDigest(f.brain.agent, { ...reference, messageIds: [crypto.randomUUID()] }), /missing/);
  for (const change of [{ messageIds: [] }, { messageIds: [message.id, message.id] }, { messageIds: ["not-an-id"] },
    { messageIds: Array.from({ length: 101 }, () => crypto.randomUUID()) }, { afterSeq: -1 }, { afterSeq: NaN },
    { afterSeq: message.seq + 1000 }, { extra: true }])
    assert.throws(() => f.hive.expandDigest(f.brain.agent, { ...reference, ...change }));
  f.hive.createProject(f.hive.getAgent("human"), { name: "Isolated", slug: "isolated" });
  const outside = f.hive.join({ role: "brain", project: "isolated" });
  assert.throws(() => f.hive.expandDigest(outside.agent, reference), /Channel not found/);
  assert.deepEqual(f.hive.inbox.status(f.brain.agent.id), before);
  assert.equal(f.hive.inbox.pending(f.brain.agent.id)!.id, batch.delivery!.id);
});

test("attachment-bearing progress stays full and expansion returns metadata without file contents", async t => {
  const f = fixture(t);
  const file = await f.hive.createFileFromBytes(f.worker.agent, { name: "evidence.txt", mime: "text/plain", bytes: new TextEncoder().encode("private fixture file bytes") });
  const original = f.hive.postMessage(f.worker.agent, { channel: f.dm.id, body: "Evidence", eventType: "progress", attachmentIds: [file.id] });
  f.send("Thanks", "progress", original.id); f.other();
  const batch = await f.wait(); bounded(batch);
  const item = batch.mail!.find(m => m.seq === original.seq)!;
  assert.equal(item.body, "Evidence"); assert.equal(item.attachmentCount, 1);
  assert.equal(item.attachments![0].id, file.id);
  const expanded = f.hive.expandDigest(f.brain.agent, { channel: f.dm.id, messageIds: [original.id] });
  assert.equal(expanded.messages[0].attachments![0].id, file.id);
  assert.equal(JSON.stringify(expanded).includes("private fixture file bytes"), false);
});

test("typed bot observations survive replay/restart and do not acquire command authority", async t => {
  const f = fixture(t);
  const bot = f.hive.createBot(f.hive.getAgent("human"), f.room.projectId, { name: "ReportBot" });
  f.hive.invite(f.brain.agent, f.room.id, [bot.bot.name]);
  const payload = { eventId: "event-1", body: "Permission denied", eventType: "blocker" };
  const sent = f.hive.postBotMessage(bot.bot, f.room.id, payload).message;
  f.hive.postBotMessage(bot.bot, f.room.id, { eventId: "event-2", threadId: sent.id, body: "Thanks", eventType: "progress" });
  f.send("Other task", "progress");
  const batch = await f.wait(); bounded(batch);
  const item = batch.mail!.find(m => m.seq === sent.seq)!;
  assert.equal(item.body, sent.body); assert.equal(item.eventType, "blocker");
  assert.equal(item.authorRole, "bot"); assert.equal(item.source, "bot");
  assert.equal(f.hive.postBotMessage(bot.bot, f.room.id, payload).duplicate, true);
  assert.throws(() => f.hive.postBotMessage(bot.bot, f.room.id, { ...payload, eventType: "progress" }), /already used/);
  const legacy = { eventId: "untyped", body: "Legacy sender" };
  f.hive.postBotMessage(bot.bot, f.room.id, legacy);
  f.reopen();
  assert.equal(f.hive.postBotMessage(bot.bot, f.room.id, legacy).duplicate, true);
  const replay = await f.wait(); bounded(replay);
  assert.equal(replay.delivery!.id, batch.delivery!.id);
  assert.deepEqual(replay.mail, batch.mail);
  assert.equal(f.hive.getVisibleMessage(f.brain.agent, sent.seq).eventType, "blocker");
});

test("HTTP send validates event types and exposes read-only exact expansion", async t => {
  const f = fixture(t); const app = createApp(f.hive);
  const post = (url: string, body: unknown, token = f.worker.token) => app.request(url, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const url = `/api/agent/channels/${f.dm.id}/messages`;
  for (const eventType of ["progress", "blocker", "question", "action_required"]) {
    const response = await post(url, { body: "Payload", eventType }); assert.equal(response.status, 200);
    const sent = await response.json() as { id: string; seq: number };
    const expanded = await post("/api/agent/messages/expand", { channel: f.dm.id, messageIds: [sent.id] }, f.brain.token);
    assert.equal(expanded.status, 200);
    assert.equal(((await expanded.json()) as DigestExpansionResult).messages[0].eventType, eventType);
  }
  for (const eventType of ["execute", "control", null, 123, {}])
    assert.equal((await post(url, { body: "Invalid", eventType })).status, 400);
});

test("digest references and expanded Unicode/control-character bodies fit the existing byte budget", async t => {
  const f = fixture(t);
  const originals: Message[] = [];
  const root = f.send("Root", "progress");
  for (let i = 0; i < 15; i++) originals.push(f.send("prefix\0" + "\u0001😀界\\\"".repeat(500), "progress", root.id));
  f.other();
  let received = 0;
  while (received < originals.length + 2) {
    const batch = await f.wait(); bounded(batch);
    for (const item of batch.mail ?? []) if (item.expand) {
      let afterSeq: number | undefined;
      const recovered: string[] = [];
      do {
        const page = f.hive.expandDigest(f.brain.agent, { ...item.expand, ...(afterSeq === undefined ? {} : { afterSeq }) });
        bounded(page);
        for (const message of page.messages) {
          assert.equal(message.body, f.hive.getVisibleMessage(f.brain.agent, message.seq).body);
          recovered.push(message.id);
        }
        afterSeq = page.nextAfterSeq ?? undefined;
      } while (afterSeq !== undefined);
      assert.deepEqual(recovered, item.expand.messageIds);
    }
    received += batch.delivery!.messageSeqs.length;
    f.hive.acknowledgeInbox(f.brain.agent, f.sessionId, batch.delivery!.id);
  }
  // Exercise expansion's own byte boundary, independent of wait's smaller batch.
  const refs = { channel: f.dm.id, messageIds: originals.map(m => m.id) };
  const page = f.hive.expandDigest(f.brain.agent, refs); bounded(page);
  assert.equal(page.hasMore, true); assert.ok(page.messages.length < 8);
});

test("an existing schema migrates without classifying legacy messages or breaking receipt replay", async t => {
  const f = fixture(t);
  const message = f.send("Unclassified blocker after upgrade"); f.other();
  const batch = await f.wait();
  f.hive.db.exec("ALTER TABLE messages DROP COLUMN event_type");
  f.reopen();
  const replay = await f.wait();
  assert.equal(replay.delivery!.id, batch.delivery!.id);
  assert.equal(replay.mail!.find(m => m.seq === message.seq)!.body, message.body);
  assert.equal(replay.mail!.find(m => m.seq === message.seq)!.eventType, undefined);
});

test("oversized legacy originals fail explicitly without skipping them or changing inbox state", async t => {
  const f = fixture(t);
  const first = f.send("Small original", "progress");
  const large = f.send("Legacy original", "progress", first.id);
  f.hive.db.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(WAIT_MAX_BYTES + 1), large.id);
  const reference = { channel: f.dm.id, messageIds: [first.id, large.id] };
  const before = f.hive.inbox.status(f.brain.agent.id);
  const page = f.hive.expandDigest(f.brain.agent, reference); bounded(page);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map(m => m.id), [first.id]);
  assert.equal(page.nextAfterSeq, first.seq);
  assert.throws(() => f.hive.expandDigest(f.brain.agent, { ...reference, afterSeq: page.nextAfterSeq }),
    error => error instanceof Error && error.message.includes("Use history") && error.message.includes(large.id));
  assert.deepEqual(f.hive.inbox.status(f.brain.agent.id), before);
});
