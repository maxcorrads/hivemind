import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Agent, Message } from "../shared/types.ts";
import type { ReadSnapshot } from "../shared/read-state.ts";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { countRows, deleteRows, failWrites, updateRows } from "./test-fixtures.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-read-state-"));
  const dbPath = path.join(dir, "hive.db");
  let hive = new Hive(dbPath);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent("human");
  const first = hive.listProjects()[0]!;
  const brain = hive.join({ role: "brain", project: first.slug }).agent;
  const room = hive.getChannel("general", first.id);
  return {
    get hive() { return hive; }, human, first, brain, room,
    post: (body = "@Human question", threadId: string | null = null, actor: Agent = brain, channel = room.id) =>
      hive.postMessage(actor, { channel, body, threadId }),
    reopen: () => { hive.db.close(); hive = new Hive(dbPath); },
    legacy: () => {
      hive.db.close();
      const db = new DatabaseSync(dbPath);
      // Remove only this new schema to create an actual pre-feature database.
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ui_read_%'").all()) {
        db.exec(`DROP TRIGGER "${row.name}"`);
      }
      db.exec("DROP TABLE message_reads; DROP TABLE ui_read_revision");
      db.close();
      hive = new Hive(dbPath);
    },
    receipts: () => countRows(hive, "message_reads"),
  };
}

function assertIds(actual: Message[], expected: Message[]) {
  assert.deepEqual(actual.map((m) => m.id), expected.map((m) => m.id));
}

test("project/unread filtering precedes LIMIT even behind 1,100 ineligible recent rows", (t) => {
  const f = fixture(t);
  const other = f.hive.createProject(f.human, { name: "Other", slug: "other" });
  const otherBrain = f.hive.join({ role: "brain", project: other.slug }).agent;
  const otherRoom = f.hive.getChannel("general", other.id);
  const wanted = Array.from({ length: 65 }, (_, n) => f.post(`@Human wanted ${n}`));
  for (let n = 0; n < 550; n++) f.post(`@Human other ${n}`, null, otherBrain, otherRoom.id);
  const alreadyRead: Message[] = [];
  for (let n = 0; n < 550; n++) alreadyRead.push(f.post(`@Human already read ${n}`));
  for (let n = 0; n < alreadyRead.length; n += 200) {
    f.hive.markMessagesRead(f.human, f.room.id, alreadyRead.slice(n, n + 200).map((m) => m.seq));
  }
  const found: Message[] = [];
  let before: number | undefined;
  for (let i = 0; i < 4; i++) {
    const page = f.hive.mentionInbox(f.human, 30, before, f.first.id);
    found.push(...page.messages);
    if (!page.hasMore) break;
    before = page.messages.at(-1)!.seq;
  }
  assertIds(found, [...wanted].reverse());
  assert.equal(new Set(found.map((m) => m.seq)).size, wanted.length);
  assert.equal(f.hive.readSnapshot(f.human).mentionCounts[f.first.slug], 65);
  assert.equal(f.hive.readSnapshot(f.human).mentionCounts.other, 550);
  assert.equal(f.hive.mentionInbox(f.human, 30, wanted[0]!.seq, f.first.id).hasMore, false);
});

test("mention identity is exact and author/self messages never count as unread", (t) => {
  const f = fixture(t);
  const ordinary = f.post("ordinary");
  const similar = f.post("ordinary");
  updateRows(f.hive, "messages", { mentions: '["human-extra"]' }, { id: similar.id });
  const own = f.post("@Human self", null, f.human);
  const mention = f.post();
  assertIds(f.hive.mentionInbox(f.human).messages, [mention]);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 3);
  f.hive.markMessagesRead(f.human, f.room.id, [ordinary.seq, similar.seq, own.seq, mention.seq]);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 0);
});

test("hidden channels and other projects cannot consume a visible actor's mention page", (t) => {
  const f = fixture(t);
  const worker = f.hive.join({ role: "worker", seniority: "mid", project: f.first.slug }).agent;
  const visible = f.post(`@${worker.name} visible`);
  const secret = f.hive.getChannel("brains", f.first.id);
  const other = f.hive.createProject(f.human, { name: "Other", slug: "other" });
  const otherRoom = f.hive.getChannel("general", other.id);
  for (let n = 0; n < 40; n++) {
    const hidden = f.post("hidden", null, f.brain, secret.id);
    updateRows(f.hive, "messages", { mentions: JSON.stringify([worker.id]) }, { id: hidden.id });
    const foreign = f.post("foreign", null, f.human, otherRoom.id);
    updateRows(f.hive, "messages", { mentions: JSON.stringify([worker.id]) }, { id: foreign.id });
  }
  assertIds(f.hive.mentionInbox(worker, 1).messages, [visible]);
  assert.equal(f.hive.mentionInbox(worker, 1).hasMore, false);
  assert.deepEqual(f.hive.mentionInbox(worker, 30, undefined, other.id).messages, []);
  assert.equal(f.hive.unreadCounts(worker)[secret.id], undefined);
  assert.throws(() => f.hive.markMessagesRead(worker, secret.id, [visible.seq]), /Cannot read/);
  assert.throws(() => f.hive.markMessagesRead(worker, otherRoom.id, [visible.seq]));
});

test("channel receipts leave unopened thread replies unread and thread receipts are independent", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human in thread", root.id);
  const otherRoot = f.post();
  const otherReply = f.post("@Human other thread", otherRoot.id);
  f.hive.markMessagesRead(f.human, f.room.id, [root.seq, otherRoot.seq]);
  assertIds(f.hive.mentionInbox(f.human).messages, [otherReply, reply]);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 2);
  f.hive.markMessagesRead(f.human, f.room.id, [root.seq, reply.seq], root.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [otherReply]);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 1);
  const later = f.post("@Human later", root.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [later, otherReply]);
  f.reopen();
  assertIds(f.hive.mentionInbox(f.human).messages, [later, otherReply]);
});

test("receipts acknowledge exact rendered rows, not hidden gaps or a later arriving reply", (t) => {
  const f = fixture(t);
  const root = f.post();
  const hidden = f.post("@Human older", root.id);
  const displayed = f.post("@Human displayed", root.id);
  const later = f.post("@Human arrives after snapshot", root.id);
  f.hive.markMessagesRead(f.human, f.room.id, [displayed.seq], root.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [later, hidden, root]);
  f.hive.markMessagesRead(f.human, f.room.id, [root.seq, hidden.seq], root.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [later]);
});

test("legacy channel read-through remains valid after a real old-schema upgrade and restart", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human legacy read reply", root.id);
  f.hive.markRead(f.human, f.room.id, reply.seq);
  f.legacy();
  assert.deepEqual(f.hive.mentionInbox(f.human).messages, []);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 0);
  const later = f.post("@Human new reply", root.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [later]);
  f.hive.markMessagesRead(f.human, f.room.id, [later.seq], root.id);
  const version = f.hive.readSnapshot(f.human);
  f.reopen();
  const after = f.hive.readSnapshot(f.human);
  assert.equal(after.readRevision, version.readRevision);
  assert.notEqual(after.readInstance, version.readInstance);
  assert.deepEqual(after.mentions, []);
});

test("replayed and out-of-order receipts are idempotent without moving a read cursor", (t) => {
  const f = fixture(t);
  const first = f.post();
  const second = f.post();
  f.hive.markMessagesRead(f.human, f.room.id, [second.seq, second.seq]);
  const version = f.hive.readSnapshot(f.human);
  f.hive.markMessagesRead(f.human, f.room.id, [second.seq]);
  assert.equal(f.hive.readSnapshot(f.human).readRevision, version.readRevision);
  assertIds(f.hive.mentionInbox(f.human).messages, [first]);
  f.hive.markMessagesRead(f.human, f.room.id, [first.seq]);
  assert.deepEqual(f.hive.mentionInbox(f.human).messages, []);
  assert.deepEqual(f.hive.readsFor(f.human), {});
});

test("invalid/mixed-scope receipts fail atomically and do not change the read revision", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human reply", root.id);
  const other = f.post();
  const prior = f.hive.readSnapshot(f.human);
  const invalid: unknown[] = [[], [0], [-1], [1.5], [NaN], [Infinity], "1", null, Array(201).fill(root.seq), [root.seq, 999999]];
  for (const seqs of invalid) assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, seqs as number[]));
  assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, [root.seq, reply.seq]));
  assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, [reply.seq, other.seq], root.id));
  assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, [reply.seq], reply.id));
  assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, [root.seq], 4 as unknown as string));
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.readSnapshot(f.human).readRevision, prior.readRevision);
  // An actual mid-transaction SQLite fault rolls back both receipt and revision.
  failWrites(f.hive, "message_reads", { when: `NEW.message_id = '${other.id}'`, message: "injected read failure", persistent: true });
  assert.throws(() => f.hive.markMessagesRead(f.human, f.room.id, [root.seq, other.seq]), /injected read failure/);
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.readSnapshot(f.human).readRevision, prior.readRevision);
});

test("mark-all-mentions handles over 400 rows and leaves ordinary/project-external messages unread", (t) => {
  const f = fixture(t);
  const ordinary = f.post("ordinary");
  for (let n = 0; n < 450; n++) f.post("@Human question", n % 2 ? ordinary.id : null);
  const other = f.hive.createProject(f.human, { name: "Other", slug: "other" });
  const otherBrain = f.hive.join({ role: "brain", project: other.slug }).agent;
  const otherRoom = f.hive.getChannel("general", other.id);
  const foreign = f.post("@Human other", null, otherBrain, otherRoom.id);
  f.hive.markMentionsSeen(f.human, f.first.id);
  assertIds(f.hive.mentionInbox(f.human).messages, [foreign]);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 1);
  assert.equal(f.hive.readSnapshot(f.human).mentionCounts[f.first.slug], 0);
  const rev = f.hive.readSnapshot(f.human).readRevision;
  f.hive.markMentionsSeen(f.human, f.first.id);
  assert.equal(f.hive.readSnapshot(f.human).readRevision, rev);
  f.hive.markMentionsSeen(f.human);
  assert.equal(f.hive.mentionInbox(f.human).messages.length, 0);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 1);
});

test("project/message/agent deletion cleans receipts while other projects retain their state", (t) => {
  const f = fixture(t);
  const root = f.post();
  f.hive.markMessagesRead(f.human, f.room.id, [root.seq]);
  const other = f.hive.createProject(f.human, { name: "Other", slug: "other" });
  const b = f.hive.join({ role: "brain", project: other.slug }).agent;
  const room = f.hive.getChannel("general", other.id);
  const read = f.post("@Human read", null, b, room.id);
  const unread = f.post("@Human unread", null, b, room.id);
  f.hive.markMessagesRead(f.human, room.id, [read.seq]);
  f.hive.setOffline(f.brain.id);
  const before = f.hive.readSnapshot(f.human);
  f.hive.deleteProject(f.human, f.first.slug);
  assert.equal(f.receipts(), 1);
  assertIds(f.hive.mentionInbox(f.human).messages, [unread]);
  assert.ok(f.hive.readSnapshot(f.human).readRevision > before.readRevision);
  assert.equal(f.hive.readSnapshot(f.human).readSeq, before.readSeq);
  deleteRows(f.hive, "messages", { id: read.id });
  assert.equal(f.receipts(), 0);
  f.hive.markMessagesRead(b, room.id, [unread.seq]);
  deleteRows(f.hive, "agents", { id: b.id });
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.db.prepare("PRAGMA foreign_key_check").all().length, 0); // schema-level assertion
});

test("mention cursors and numeric limits have deterministic inclusive/exclusive boundaries", (t) => {
  const f = fixture(t);
  const rows = [f.post(), f.post(), f.post()];
  assertIds(f.hive.mentionInbox(f.human, 1.9).messages, [rows[2]!]);
  assertIds(f.hive.mentionInbox(f.human, 0).messages, [rows[2]!]);
  assertIds(f.hive.mentionInbox(f.human, Infinity).messages, [...rows].reverse());
  assertIds(f.hive.mentionInbox(f.human, 200, rows[2]!.seq).messages, [rows[1]!, rows[0]!]);
  for (const before of [0, -1, 1.1, NaN, Infinity]) assert.throws(() => f.hive.mentionInbox(f.human, 30, before));
});

test("real HTTP GETs are read-only; exact receipt POSTs converge with a later reconnect snapshot", async (t) => {
  const f = fixture(t);
  const app = createApp(f.hive);
  const root = f.post();
  const reply = f.post("@Human reply", root.id);
  const get = async <T = ReadSnapshot>(url: string): Promise<T> => {
    const response = await app.request(url);
    assert.equal(response.status, 200);
    return response.json() as Promise<T>;
  };
  const post = async (body: unknown) => app.request("/api/ui/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const before = await get("/api/ui/snapshot");
  const channel = await get<{ threadId: string | null; messages: Message[] }>(`/api/ui/channels/${f.room.id}/messages`);
  assert.equal(channel.threadId, null);
  assert.equal(channel.messages.some((m: Message) => m.id === reply.id), false);
  await get(`/api/ui/channels/${f.room.id}/messages?threadId=${root.id}`);
  assert.deepEqual((await get("/api/ui/snapshot")).unread, before.unread);
  const receipt = await post({ channelId: f.room.id, messageSeqs: [root.seq] });
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json() as ReadSnapshot).unread[f.room.id], 1);
  const invalid = await post({ channelId: f.room.id, threadId: 123, messageSeqs: [reply.seq] });
  assert.equal(invalid.status, 400);
  const readReply = await post({ channelId: f.room.id, threadId: root.id, messageSeqs: [reply.seq] });
  assert.equal(readReply.status, 200);
  const next = f.post("@Human arrives afterwards", root.id);
  assertIds((await get("/api/ui/read-state")).mentions, [next]);
  assertIds((await get("/api/ui/snapshot")).mentions, [next]);
  const oldResponseReplay = await post({ channelId: f.room.id, threadId: root.id, messageSeqs: [reply.seq] });
  assert.equal(oldResponseReplay.status, 200);
  assertIds((await oldResponseReplay.json() as ReadSnapshot).mentions, [next]);
});

test("forward thread pages keep unrequested replies unread and expose a usable continuation cursor", (t) => {
  const f = fixture(t);
  const root = f.post();
  for (let i = 0; i < 100; i++) f.post(`@Human reply ${i}`, root.id);
  const page = f.hive.listMessages(f.human, f.room.id, { threadId: root.id });
  assert.equal(page.messages.length, 80);
  assert.equal(page.messages[0]!.id, root.id);
  assert.equal(page.hasNewer, true);
  f.hive.markMessagesRead(f.human, f.room.id, page.messages.map((m) => m.seq), root.id);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 21);
  const rest = f.hive.listMessages(f.human, f.room.id, { threadId: root.id, afterSeq: page.cursors.after });
  assert.equal(rest.messages.length, 21);
  assert.equal(rest.hasNewer, false);
  f.hive.markMessagesRead(f.human, f.room.id, rest.messages.map((m) => m.seq), root.id);
  assert.equal(f.hive.unreadCounts(f.human)[f.room.id], 0);
});
