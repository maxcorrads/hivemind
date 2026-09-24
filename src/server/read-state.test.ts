import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Agent, Message } from "../shared/types.ts";
import type { ActivityItem, ActivityPage, ReadSnapshot } from "../shared/read-state.ts";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { startServer } from "./serve.ts";
import { countRows, deleteRows, failWrites, markLegacyStorage, updateRows } from "./test-fixtures.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-read-state-"));
  const dbPath = path.join(dir, "hive.db");
  let hive = new Hive(dbPath);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const first = hive.projects.listProjects()[0]!;
  const brain = hive.identity.join({ role: "brain", project: first.slug }).agent;
  const room = hive.channels.getChannel("general", first.id);
  return {
    get hive() { return hive; }, human, first, brain, room,
    post: (body = "@Human question", threadId: string | null = null, actor: Agent = brain, channel = room.id) =>
      hive.messages.postMessage(actor, { channel, body, threadId }),
    reopen: () => { hive.db.close(); hive = new Hive(dbPath); },
    legacy: () => {
      hive.db.close();
      const db = new DatabaseSync(dbPath);
      // Remove only this new schema to create an actual pre-feature database.
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ui_read_%'").all()) {
        db.exec(`DROP TRIGGER "${row.name}"`);
      }
      db.exec("DROP TABLE message_reads; DROP TABLE ui_read_revision");
      markLegacyStorage(db);
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
  const other = f.hive.projects.createProject(f.human, { name: "Other", slug: "other" });
  const otherBrain = f.hive.identity.join({ role: "brain", project: other.slug }).agent;
  const otherRoom = f.hive.channels.getChannel("general", other.id);
  const wanted = Array.from({ length: 65 }, (_, n) => f.post(`@Human wanted ${n}`));
  for (let n = 0; n < 550; n++) f.post(`@Human other ${n}`, null, otherBrain, otherRoom.id);
  const alreadyRead: Message[] = [];
  for (let n = 0; n < 550; n++) alreadyRead.push(f.post(`@Human already read ${n}`));
  for (let n = 0; n < alreadyRead.length; n += 200) {
    f.hive.reads.markMessagesRead(f.human, f.room.id, alreadyRead.slice(n, n + 200).map((m) => m.seq));
  }
  const found: Message[] = [];
  let before: number | undefined;
  for (let i = 0; i < 4; i++) {
    const page = f.hive.reads.mentionInbox(f.human, 30, before, f.first.id);
    found.push(...page.messages);
    if (!page.hasMore) break;
    before = page.messages.at(-1)!.seq;
  }
  assertIds(found, [...wanted].reverse());
  assert.equal(new Set(found.map((m) => m.seq)).size, wanted.length);
  assert.equal(f.hive.reads.readSnapshot(f.human).mentionCounts[f.first.slug], 65);
  assert.equal(f.hive.reads.readSnapshot(f.human).mentionCounts.other, 550);
  assert.equal(f.hive.reads.mentionInbox(f.human, 30, wanted[0]!.seq, f.first.id).hasMore, false);
});

test("mention identity is exact and author/self messages never count as unread", (t) => {
  const f = fixture(t);
  const ordinary = f.post("ordinary");
  const similar = f.post("ordinary");
  updateRows(f.hive, "messages", { mentions: '["human-extra"]' }, { id: similar.id });
  const own = f.post("@Human self", null, f.human);
  const mention = f.post();
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [mention]);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 3);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [ordinary.seq, similar.seq, own.seq, mention.seq]);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 0);
});

test("hidden channels and other projects cannot consume a visible actor's mention page", (t) => {
  const f = fixture(t);
  const worker = f.hive.identity.join({ role: "worker", seniority: "mid", project: f.first.slug }).agent;
  const visible = f.post(`@${worker.name} visible`);
  const secret = f.hive.channels.getChannel("brains", f.first.id);
  const other = f.hive.projects.createProject(f.human, { name: "Other", slug: "other" });
  const otherRoom = f.hive.channels.getChannel("general", other.id);
  for (let n = 0; n < 40; n++) {
    const hidden = f.post("hidden", null, f.brain, secret.id);
    updateRows(f.hive, "messages", { mentions: JSON.stringify([worker.id]) }, { id: hidden.id });
    const foreign = f.post("foreign", null, f.human, otherRoom.id);
    updateRows(f.hive, "messages", { mentions: JSON.stringify([worker.id]) }, { id: foreign.id });
  }
  assertIds(f.hive.reads.mentionInbox(worker, 1).messages, [visible]);
  assert.equal(f.hive.reads.mentionInbox(worker, 1).hasMore, false);
  assert.deepEqual(f.hive.reads.mentionInbox(worker, 30, undefined, other.id).messages, []);
  assert.equal(f.hive.reads.unreadCounts(worker)[secret.id], undefined);
  assert.throws(() => f.hive.reads.markMessagesRead(worker, secret.id, [visible.seq]), /Cannot read/);
  assert.throws(() => f.hive.reads.markMessagesRead(worker, otherRoom.id, [visible.seq]));
});

test("channel receipts leave unopened thread replies unread and thread receipts are independent", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human in thread", root.id);
  const otherRoot = f.post();
  const otherReply = f.post("@Human other thread", otherRoot.id);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq, otherRoot.seq]);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [otherReply, reply]);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 2);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq, reply.seq], root.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [otherReply]);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 1);
  const later = f.post("@Human later", root.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [later, otherReply]);
  f.reopen();
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [later, otherReply]);
});

test("receipts acknowledge exact rendered rows, not hidden gaps or a later arriving reply", (t) => {
  const f = fixture(t);
  const root = f.post();
  const hidden = f.post("@Human older", root.id);
  const displayed = f.post("@Human displayed", root.id);
  const later = f.post("@Human arrives after snapshot", root.id);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [displayed.seq], root.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [later, hidden, root]);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq, hidden.seq], root.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [later]);
});

test("legacy channel read-through remains valid after a real old-schema upgrade and restart", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human legacy read reply", root.id);
  f.hive.reads.markRead(f.human, f.room.id, reply.seq);
  f.legacy();
  assert.deepEqual(f.hive.reads.mentionInbox(f.human).messages, []);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 0);
  const later = f.post("@Human new reply", root.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [later]);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [later.seq], root.id);
  const version = f.hive.reads.readSnapshot(f.human);
  f.reopen();
  const after = f.hive.reads.readSnapshot(f.human);
  assert.equal(after.readRevision, version.readRevision);
  assert.notEqual(after.readInstance, version.readInstance);
  assert.deepEqual(after.mentions, []);
});

test("replayed and out-of-order receipts are idempotent without moving a read cursor", (t) => {
  const f = fixture(t);
  const first = f.post();
  const second = f.post();
  f.hive.reads.markMessagesRead(f.human, f.room.id, [second.seq, second.seq]);
  const version = f.hive.reads.readSnapshot(f.human);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [second.seq]);
  assert.equal(f.hive.reads.readSnapshot(f.human).readRevision, version.readRevision);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [first]);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [first.seq]);
  assert.deepEqual(f.hive.reads.mentionInbox(f.human).messages, []);
  assert.deepEqual(f.hive.reads.readsFor(f.human), {});
});

test("invalid/mixed-scope receipts fail atomically and do not change the read revision", (t) => {
  const f = fixture(t);
  const root = f.post();
  const reply = f.post("@Human reply", root.id);
  const other = f.post();
  const prior = f.hive.reads.readSnapshot(f.human);
  const invalid: unknown[] = [[], [0], [-1], [1.5], [NaN], [Infinity], "1", null, Array(201).fill(root.seq), [root.seq, 999999]];
  for (const seqs of invalid) assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, seqs as number[]));
  assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq, reply.seq]));
  assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, [reply.seq, other.seq], root.id));
  assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, [reply.seq], reply.id));
  assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq], 4 as unknown as string));
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.reads.readSnapshot(f.human).readRevision, prior.readRevision);
  // An actual mid-transaction SQLite fault rolls back both receipt and revision.
  failWrites(f.hive, "message_reads", { when: `NEW.message_id = '${other.id}'`, message: "injected read failure", persistent: true });
  assert.throws(() => f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq, other.seq]), /injected read failure/);
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.reads.readSnapshot(f.human).readRevision, prior.readRevision);
});

test("mark-all-mentions handles over 400 rows and leaves ordinary/project-external messages unread", (t) => {
  const f = fixture(t);
  const ordinary = f.post("ordinary");
  for (let n = 0; n < 450; n++) f.post("@Human question", n % 2 ? ordinary.id : null);
  const other = f.hive.projects.createProject(f.human, { name: "Other", slug: "other" });
  const otherBrain = f.hive.identity.join({ role: "brain", project: other.slug }).agent;
  const otherRoom = f.hive.channels.getChannel("general", other.id);
  const foreign = f.post("@Human other", null, otherBrain, otherRoom.id);
  f.hive.reads.markMentionsSeen(f.human, f.first.id);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [foreign]);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 1);
  assert.equal(f.hive.reads.readSnapshot(f.human).mentionCounts[f.first.slug], 0);
  const rev = f.hive.reads.readSnapshot(f.human).readRevision;
  f.hive.reads.markMentionsSeen(f.human, f.first.id);
  assert.equal(f.hive.reads.readSnapshot(f.human).readRevision, rev);
  f.hive.reads.markMentionsSeen(f.human);
  assert.equal(f.hive.reads.mentionInbox(f.human).messages.length, 0);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 1);
});

test("project/message/agent deletion cleans receipts while other projects retain their state", (t) => {
  const f = fixture(t);
  const root = f.post();
  f.hive.reads.markMessagesRead(f.human, f.room.id, [root.seq]);
  const other = f.hive.projects.createProject(f.human, { name: "Other", slug: "other" });
  const b = f.hive.identity.join({ role: "brain", project: other.slug }).agent;
  const room = f.hive.channels.getChannel("general", other.id);
  const read = f.post("@Human read", null, b, room.id);
  const unread = f.post("@Human unread", null, b, room.id);
  f.hive.reads.markMessagesRead(f.human, room.id, [read.seq]);
  f.hive.identity.setOffline(f.brain.id);
  const before = f.hive.reads.readSnapshot(f.human);
  f.hive.projects.deleteProject(f.human, f.first.slug);
  assert.equal(f.receipts(), 1);
  assertIds(f.hive.reads.mentionInbox(f.human).messages, [unread]);
  assert.ok(f.hive.reads.readSnapshot(f.human).readRevision > before.readRevision);
  assert.equal(f.hive.reads.readSnapshot(f.human).readSeq, before.readSeq);
  deleteRows(f.hive, "messages", { id: read.id });
  assert.equal(f.receipts(), 0);
  f.hive.reads.markMessagesRead(b, room.id, [unread.seq]);
  deleteRows(f.hive, "agents", { id: b.id });
  assert.equal(f.receipts(), 0);
  assert.equal(f.hive.db.prepare("PRAGMA foreign_key_check").all().length, 0); // schema-level assertion
});

test("mention cursors and numeric limits have deterministic inclusive/exclusive boundaries", (t) => {
  const f = fixture(t);
  const rows = [f.post(), f.post(), f.post()];
  assertIds(f.hive.reads.mentionInbox(f.human, 1.9).messages, [rows[2]!]);
  assertIds(f.hive.reads.mentionInbox(f.human, 0).messages, [rows[2]!]);
  assertIds(f.hive.reads.mentionInbox(f.human, Infinity).messages, [...rows].reverse());
  assertIds(f.hive.reads.mentionInbox(f.human, 200, rows[2]!.seq).messages, [rows[1]!, rows[0]!]);
  for (const before of [0, -1, 1.1, NaN, Infinity]) assert.throws(() => f.hive.reads.mentionInbox(f.human, 30, before));
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
  const page = f.hive.messageQueries.listMessages(f.human, f.room.id, { threadId: root.id });
  assert.equal(page.messages.length, 80);
  assert.equal(page.messages[0]!.id, root.id);
  assert.equal(page.hasNewer, true);
  f.hive.reads.markMessagesRead(f.human, f.room.id, page.messages.map((m) => m.seq), root.id);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 21);
  const rest = f.hive.messageQueries.listMessages(f.human, f.room.id, { threadId: root.id, afterSeq: page.cursors.after });
  assert.equal(rest.messages.length, 21);
  assert.equal(rest.hasNewer, false);
  f.hive.reads.markMessagesRead(f.human, f.room.id, rest.messages.map((m) => m.seq), root.id);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 0);
});

const entries = (items: ActivityItem[]) => items.map((item) => [item.message.id, item.reason, item.read]);

test("the Unread tab lists exactly what the sidebar counts: DM badges and the For you badge", (t) => {
  const f = fixture(t);
  const dm = f.hive.channels.openDm(f.human, f.brain.name);
  const direct = [f.post("plain DM", null, f.brain, dm.id), f.post("another plain DM", null, f.brain, dm.id)];
  f.post("my own DM", null, f.human, dm.id);
  const mention = f.post();
  f.post("ordinary chatter");
  const unread = () => f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: true });
  const directOnly = () => f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: true, reasons: ["direct"] });
  assert.deepEqual(entries(unread().items), [[mention.id, "mention", false], [direct[1]!.id, "direct", false], [direct[0]!.id, "direct", false]]);
  let snapshot = f.hive.reads.readSnapshot(f.human);
  assert.equal(snapshot.mentionCounts[f.first.slug], unread().items.length);
  assert.equal(snapshot.unread[dm.id], directOnly().items.length);
  assertIds(snapshot.mentions, [mention, direct[1]!, direct[0]!]);

  f.hive.reads.markMessagesRead(f.human, dm.id, [direct[0]!.seq]);
  snapshot = f.hive.reads.readSnapshot(f.human);
  assert.equal(snapshot.unread[dm.id], 1);
  assert.equal(directOnly().items.length, 1);
  assert.equal(snapshot.mentionCounts[f.first.slug], 2);

  // Activity keeps read entries, with their read state from the server.
  assert.deepEqual(entries(f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: false }).items),
    [[mention.id, "mention", false], [direct[1]!.id, "direct", false], [direct[0]!.id, "direct", true]]);
  f.hive.reads.markMentionsSeen(f.human, f.first.id);
  snapshot = f.hive.reads.readSnapshot(f.human);
  assert.equal(snapshot.mentionCounts[f.first.slug], 0);
  assert.equal(snapshot.unread[dm.id], 0);
  assert.deepEqual(unread().items, []);
  assert.ok(f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: false }).items.every((item) => item.read));
});

test("thread replies are For you once the reader took part; DMs between agents are not", (t) => {
  const f = fixture(t);
  const worker = f.hive.identity.join({ role: "worker", seniority: "mid", project: f.first.slug }).agent;
  const between = f.hive.channels.openDm(f.brain, worker.name);
  f.post("agents talking", null, f.brain, between.id);
  const root = f.post("ordinary root");
  f.post("before the Human replied", root.id);
  f.post("the Human replies", root.id, f.human);
  const after = f.post("after the Human replied", root.id);
  const humanRoot = f.post("the Human starts a thread", null, f.human);
  const reply = f.post("reply to the Human", humanRoot.id);
  const all = f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: false });
  assert.deepEqual(entries(all.items), [[reply.id, "thread", false], [after.id, "thread", false]]);
  assert.equal(f.hive.reads.readSnapshot(f.human).mentionCounts[f.first.slug], 2);
});

test("Activity pages newest first through read and unread entries, per project and type", (t) => {
  const f = fixture(t);
  const other = f.hive.projects.createProject(f.human, { name: "Other", slug: "other" });
  const otherBrain = f.hive.identity.join({ role: "brain", project: other.slug }).agent;
  const otherRoom = f.hive.channels.getChannel("general", other.id);
  const dm = f.hive.channels.openDm(f.human, f.brain.name);
  const wanted: Message[] = [];
  for (let n = 0; n < 45; n++) {
    wanted.push(f.post(`@Human ${n}`));
    wanted.push(f.post(`direct ${n}`, null, f.brain, dm.id));
    f.post("noise");
    f.post(`@Human elsewhere ${n}`, null, otherBrain, otherRoom.id);
  }
  f.hive.reads.markMessagesRead(f.human, dm.id, wanted.filter((m) => m.channelId === dm.id).slice(0, 30).map((m) => m.seq));
  const found: ActivityItem[] = [];
  let before: number | undefined;
  for (let i = 0; i < 10; i++) {
    const page = f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: false, beforeSeq: before, limit: 25 });
    found.push(...page.items);
    if (!page.hasMore) break;
    before = page.items.at(-1)!.message.seq;
  }
  assertIds(found.map((item) => item.message), [...wanted].reverse());
  assert.ok(found.every((item) => item.project === f.first.slug));
  assert.equal(found.filter((item) => item.read).length, 30);
  const directs = f.hive.reads.activity(f.human, { projectId: f.first.id, unreadOnly: false, reasons: ["direct"], limit: 200 });
  assert.equal(directs.items.length, 45);
  assert.ok(directs.items.every((item) => item.reason === "direct"));
  assert.throws(() => f.hive.reads.activity(f.human, { beforeSeq: 0 }), /beforeSeq/);
});

test("the running server publishes every committed For you message on the bus as activity", async (t) => {
  const f = fixture(t);
  const server = startServer({ hive: f.hive, port: 0, telegram: false });
  t.after(() => server.shutdown());
  await server.ready;
  const published: ActivityItem[] = [];
  f.hive.bus.on("activity", (item) => published.push(item));
  const dm = f.hive.channels.openDm(f.human, f.brain.name);
  f.post("ordinary chatter");
  const mention = f.post();
  f.post("my own words", null, f.human);
  const direct = f.post("plain DM", null, f.brain, dm.id);
  assert.deepEqual(entries(published), [[mention.id, "mention", false], [direct.id, "direct", false]]);
  assert.deepEqual(published.map((item) => item.project), [f.first.slug, f.first.slug]);
});

test("GET /api/ui/activity serves Unread and Activity and rejects unknown types", async (t) => {
  const f = fixture(t);
  const app = createApp(f.hive);
  const mention = f.post();
  f.hive.reads.markMessagesRead(f.human, f.room.id, [mention.seq]);
  const later = f.post("@Human later");
  const get = async (query: string) => {
    const response = await app.request(`/api/ui/activity?project=${f.first.slug}${query}`);
    return { status: response.status, body: await response.json() as ActivityPage };
  };
  assert.deepEqual(entries((await get("&unread=1")).body.items), [[later.id, "mention", false]]);
  assert.deepEqual(entries((await get("")).body.items), [[later.id, "mention", false], [mention.id, "mention", true]]);
  assert.deepEqual((await get("&reason=direct,thread")).body.items, []);
  assert.equal((await get("&reason=gossip")).status, 400);
  assert.equal((await get("&beforeSeq=0")).status, 400);
});

test("the channel page reports its first unread root, and mark-unread reopens roots from a message on (#221)", async (t) => {
  const f = fixture(t);
  const app = createApp(f.hive);
  const page = async () => (await app.request(`/api/ui/channels/${f.room.id}/messages`)).json() as
    Promise<{ firstUnreadSeq: number | null; messages: Message[] }>;
  const unread = (body: unknown) => app.request("/api/ui/unread", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  f.hive.messages.postMessage(f.human, { channel: f.room.id, body: "Human's own message is never unread" });
  const first = f.post("first");
  const reply = f.post("a reply", first.id);
  const second = f.post("second");
  const third = f.post("third");
  assert.equal((await page()).firstUnreadSeq, first.seq);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [first.seq, second.seq, third.seq]);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [reply.seq], first.id);
  assert.equal((await page()).firstUnreadSeq, null);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 0);

  const response = await unread({ channelId: f.room.id, fromSeq: second.seq });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as ReadSnapshot).unread[f.room.id], 2);
  assert.equal((await page()).firstUnreadSeq, second.seq);

  // A lowered legacy cursor keeps the replies it covered read: only roots from the message on reopen.
  f.hive.reads.markMessagesRead(f.human, f.room.id, [second.seq, third.seq]);
  f.hive.reads.markRead(f.human, f.room.id, third.seq);
  const lateReply = f.post("late reply", first.id);
  f.hive.reads.markMessagesRead(f.human, f.room.id, [lateReply.seq], first.id);
  f.hive.reads.markUnreadFrom(f.human, f.room.id, first.seq);
  assert.equal(f.hive.reads.unreadCounts(f.human)[f.room.id], 3);
  assert.equal(f.hive.reads.readsFor(f.human)[f.room.id], first.seq - 1);

  assert.equal((await unread({ channelId: f.room.id, fromSeq: reply.seq })).status, 400, "replies are not roots");
  assert.equal((await unread({ channelId: f.room.id, fromSeq: 0 })).status, 400);
  assert.equal((await unread({ channelId: f.room.id })).status, 400);
  const thread = await (await app.request(`/api/ui/channels/${f.room.id}/messages?threadId=${first.id}`)).json() as Record<string, unknown>;
  assert.equal("firstUnreadSeq" in thread, false, "a thread page has no channel divider");
});
