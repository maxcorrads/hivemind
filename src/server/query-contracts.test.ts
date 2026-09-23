import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import type { Message, WaitMailItem } from "../shared/types.ts";
import { Hive } from "./hive.ts";
import { addChannelMember, insertRows, markInboxRead, seedMessages } from "./test-fixtures.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-queries-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const project = hive.getProject(worker.projectId!);
  const other = hive.createProject(human, { name: "Other", slug: "other" });
  return { hive, human, worker, project, other };
}

type Call = { sql: string; args: SQLInputValue[]; count: number };
function record(t: TestContext, hive: Hive) {
  const calls: Call[] = [];
  const prepare = hive.db.prepare.bind(hive.db);
  const mock = t.mock.method(hive.db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { value: (...args: SQLInputValue[]) => {
        const result = original(...args);
        calls.push({ sql, args, count: Array.isArray(result) ? result.length : Number(Boolean(result)) });
        return result;
      } });
    }
    return statement;
  });
  return { calls, restore: () => mock.mock.restore() };
}

function fillAgents(hive: Hive, projectId: string, count: number, prefix: string) {
  insertRows(hive, "agents", Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}`, role: "worker",
    seniority: "mid", token_hash: `${prefix}${i}`, online: 0, last_seen_at: 1, created_at: 1, inbox_cursor: 0, project_id: projectId })));
}
function fillChannels(hive: Hive, projectId: string, actorId: string, count: number, prefix: string) {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  insertRows(hive, "channels", ids.map(id => ({ id, name: id, type: "private", topic: null, created_by: "human", created_at: 1, project_id: projectId })));
  insertRows(hive, "channel_members", ids.flatMap(id => [{ channel_id: id, agent_id: actorId }, { channel_id: id, agent_id: "human" }]));
}
function plan(hive: Hive, call: Call): string {
  // schema-level assertion: inspects SQLite query plans.
  return (hive.db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as { detail: string }[]).map((row) => row.detail).join("\n");
}

test("50,000 unrelated agents and 2,000 channels do not enter scoped hydration; both roster OR arms use indexes", (t) => {
  const { hive, worker, project, other } = setup(t);
  const initial = record(t, hive);
  const expectedAgents = hive.listAgents(worker);
  const expectedChannels = hive.listChannels(worker);
  const baseline = initial.calls.map(({ count }) => count);
  initial.restore();
  fillAgents(hive, other.id, 50_000, "other-agent-");
  fillChannels(hive, other.id, "other-agent-0", 2_000, "other-channel-");
  const observed = record(t, hive);
  assert.deepEqual(hive.listAgents(worker), expectedAgents);
  assert.deepEqual(hive.listChannels(worker), expectedChannels);
  assert.deepEqual(observed.calls.map(({ count }) => count), baseline);
  assert.equal(observed.calls.length, 3, "one roster query and two channel queries, regardless of unrelated project size");
  const rosterCall = observed.calls[0]!;
  observed.restore();
  const explain = plan(hive, rosterCall);
  assert.match(explain, /MULTI-INDEX OR/);
  assert.match(explain, /SEARCH a USING INDEX idx_agents_role/);
  assert.match(explain, /SEARCH a USING INDEX idx_agents_project_role/);
  assert.doesNotMatch(explain, /SCAN a\b/);
  assert.ok(expectedAgents.every((a) => a.role === "human" || (a.projectId === project.id && a.project === project.slug)));
});

test("33,000 visible channels hydrate in two constant-parameter statements and inbox reads avoid the SQLite bind limit", async (t) => {
  const { hive, human, worker, project } = setup(t);
  fillChannels(hive, project.id, worker.id, 33_000, "room-");
  const listing = record(t, hive);
  const channels = hive.listChannels(worker);
  assert.equal(channels.length, 33_001); // includes the built-in general channel
  assert.equal(listing.calls.length, 2);
  assert.ok(listing.calls.every((call) => call.args.length === 3));
  assert.deepEqual(channels.find((c) => c.id === "room-32999")!.memberIds, [human.id, worker.id].sort());
  listing.restore();
  // Insert a single deliverable row directly to avoid generating a notification recount for every fixture room.
  seedMessages(hive, [{ id: "large-inbox", channelId: "room-32999", authorId: "human", body: "fixture", createdAt: 2 }]);
  const inbox = record(t, hive);
  const result = await hive.wait(worker, 100);
  const captured = [...inbox.calls]; inbox.restore();
  assert.deepEqual(result.messages.map((m) => m.id), ["large-inbox"]);
  assert.ok(captured.every((call) => call.args.length <= 400));
  const scan = captured.find((call) => /WITH scanned AS MATERIALIZED/.test(call.sql));
  assert.ok(scan);
  assert.ok(scan.args.length <= 8, `InboxReader scan must keep a constant bind count, got ${scan.args.length}`);
  assert.match(scan.sql, /FROM messages WHERE seq > \? ORDER BY seq LIMIT \?/);
  assert.doesNotMatch(scan.sql, /channel_id IN \(\?(?:,\?)+/);
  const search = record(t, hive);
  assert.deepEqual(hive.searchMessages(worker, { q: "fixture" }).hits.map((hit) => hit.body), ["fixture"]);
  assert.ok(search.calls.every((call) => call.args.length <= 400));
  search.restore();
});

test("SQL visibility matches point authorization across projects, private rooms, brains and damaged membership", () => {
  // This fixture also closes all handles on an assertion failure.
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-query-auth-"));
  const file = path.join(dir, "hive.db");
  let hive = new Hive(file);
  try {
    const human = hive.getAgent("human");
    const brain = hive.join({ role: "brain" }).agent;
    const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
    const other = hive.createProject(human, { name: "Other", slug: "other" });
    const foreign = hive.createChannel(human, { name: "foreign", type: "private", project: other.slug });
    const privateRoom = hive.createChannel(brain, { name: "secret", type: "private" });
    const brains = hive.getChannel("brains", brain.projectId);
    addChannelMember(hive, foreign.id, worker.id);
    addChannelMember(hive, brains.id, worker.id);
    for (const actor of [human, brain, worker, { ...worker, projectId: null }]) {
      const listed = hive.listChannels(actor).map((c) => c.id).sort();
      const allowed = hive.listChannels(human).filter((c) => hive.canSeeChannel(actor, c)).map((c) => c.id).sort();
      assert.deepEqual(listed, allowed);
      for (const id of [foreign.id, privateRoom.id, brains.id]) {
        if (!allowed.includes(id)) assert.throws(() => hive.listMessages(actor, id), /Cannot read|not found/i);
      }
    }
    hive.invite(brain, privateRoom.id, [worker.name]);
    assert.ok(hive.listChannels(worker).some((c) => c.id === privateRoom.id));
    hive.db.close(); hive = new Hive(file);
    assert.ok(hive.listChannels(hive.getAgent(worker.id)).some((c) => c.id === privateRoom.id));
    assert.ok(!hive.listChannels(hive.getAgent(worker.id)).some((c) => c.id === foreign.id || c.id === brains.id));
  } finally { hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const compact of [false, true]) {
  test(`600-message brain wait keeps bounded scoped hydration across receipt pages (compact=${compact})`, async (t) => {
    const { hive, human, project, other } = setup(t);
    const brain = hive.join({ role: "brain", project: project.slug }).agent;
    const room = hive.createChannel(brain, { name: "work", type: "private" });
    markInboxRead(hive);
    const mail = Array.from({ length: 600 }, (_, i) => i);
    fillAgents(hive, project.id, 600, "author-");
    seedMessages(hive, mail.map(i => ({ id: `mail-${i}`, channelId: room.id,
      authorId: i === 599 ? "deleted-author" : `author-${i}`, body: `body-${i}`, createdAt: 1 })));
    insertRows(hive, "attachments", mail.map(i => ({ id: `attachment-${i}`, message_id: `mail-${i}`, name: `${i}.txt`,
      mime: "text/plain", bytes: 3, sha256: "f".repeat(64), created_by: "human", created_at: 1 })));
    insertRows(hive, "reactions", mail.map(i => ({ message_id: `mail-${i}`, agent_id: "human", emoji: "👍", created_at: 1 })));
    fillAgents(hive, other.id, 1, "outsider-");
    fillChannels(hive, other.id, "outsider-0", 1, "outside-room-");
    seedMessages(hive, Array.from({ length: 10_000 }, (_, i) => ({ id: `outside-${i}`, channelId: "outside-room-0",
      authorId: "outsider-0", body: "not visible", createdAt: 1 })));

    const observed = record(t, hive);
    const receivedRaw: Message[] = [];
    const receivedCompact: WaitMailItem[] = [];
    let pages = 0;
    let receivedCount = 0;
    let lastMore = -1;
    while (receivedCount < 600) {
      assert.ok(++pages <= 6, "100-message receipt cap should require exactly six pages");
      const result = await hive.wait(brain, 100, undefined, { compact });
      assert.equal(result.idle, false);
      assert.ok(result.delivery);
      assert.ok(result.delivery.messageSeqs.length <= 100);
      lastMore = result.more ?? 0;
      if (compact) receivedCompact.push(...(result.mail ?? []));
      else receivedRaw.push(...result.messages);
      receivedCount += result.delivery.messageSeqs.length;
      hive.acknowledgeInbox(brain, result.delivery.sessionId, result.delivery.id);
    }
    const calls = [...observed.calls];
    observed.restore();

    assert.equal(pages, 6);
    assert.equal(receivedCount, 600);
    assert.equal(lastMore, 0);
    if (compact) {
      assert.equal(receivedCompact.length, 600);
      assert.equal(receivedCompact[599]!.from, "unknown");
      assert.equal(receivedCompact[599]!.authorRole, "worker");
      assert.deepEqual(receivedCompact[20]!.attachments?.map((attachment) => ({
        id: attachment.id, name: attachment.name, mime: attachment.mime, bytes: attachment.bytes,
      })), [
        { id: "attachment-20", name: "20.txt", mime: "text/plain", bytes: 3 },
      ]);
      assert.ok(receivedCompact.every((item) => item.ch === "#work"));
    } else {
      assert.equal(receivedRaw.length, 600);
      assert.equal(receivedRaw[599]!.authorName, "unknown");
      assert.equal(receivedRaw[599]!.authorRole, "worker");
      assert.deepEqual(receivedRaw[20]!.attachments?.map((attachment) => ({
        id: attachment.id, name: attachment.name, mime: attachment.mime, bytes: attachment.bytes,
      })), [
        { id: "attachment-20", name: "20.txt", mime: "text/plain", bytes: 3 },
      ]);
      assert.equal(receivedRaw[20]!.reactions, undefined, "wait omits reaction rosters by design");
      assert.deepEqual(hive.getVisibleMessage(brain, receivedRaw[20]!.seq).reactions,
        [{ emoji: "👍", count: 1, mine: false }], "history preserves the complete reaction state");
    }

    const scans = calls.filter((call) => /WITH scanned AS MATERIALIZED/.test(call.sql));
    const hydrates = calls.filter((call) =>
      /FROM messages m LEFT JOIN agents a ON a.id = m.author_id WHERE m.seq = \?/.test(call.sql));
    const attachmentLoads = calls.filter((call) =>
      /SELECT id, name, mime, bytes FROM attachments/.test(call.sql));
    const botLoads = calls.filter((call) =>
      /SELECT substr\(metadata, 1, 16384\)/.test(call.sql));
    const reactionLoads = calls.filter((call) => /FROM reactions/.test(call.sql));
    assert.ok(scans.length <= 18, `unexpected header-scan fanout: ${scans.length}`);
    assert.equal(hydrates.length, 600);
    assert.equal(attachmentLoads.length, 600);
    assert.equal(botLoads.length, 600);
    assert.equal(reactionLoads.length, 0, "wait delivery must not hydrate reaction rosters");
    assert.ok(calls.every((call) => call.args.length <= 16));
    assert.ok(calls.every((call) => !call.args.includes("outsider-0")));
    // The unrelated 10k-message backlog is never hydrated into delivery metadata.
    assert.ok(hive.listAgents(human).some((a) => a.projectId === other.id));
  });
}
