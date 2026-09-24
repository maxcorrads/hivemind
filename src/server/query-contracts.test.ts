import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import type { Message, WaitMailItem } from "../shared/types.ts";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { InboxReader } from "./inbox-reader.ts";
import { addChannelMember, insertRows, markInboxRead, seedMessages } from "./test-fixtures.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-queries-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const worker = hive.identity.join({ role: "worker", seniority: "mid" }).agent;
  const project = hive.projects.getProject(worker.projectId!);
  const other = hive.projects.createProject(human, { name: "Other", slug: "other" });
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
  const expectedAgents = hive.identity.listAgents(worker);
  const expectedChannels = hive.channels.listChannels(worker);
  const baseline = initial.calls.map(({ count }) => count);
  initial.restore();
  fillAgents(hive, other.id, 50_000, "other-agent-");
  fillChannels(hive, other.id, "other-agent-0", 2_000, "other-channel-");
  const observed = record(t, hive);
  assert.deepEqual(hive.identity.listAgents(worker), expectedAgents);
  assert.deepEqual(hive.channels.listChannels(worker), expectedChannels);
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
  const channels = hive.channels.listChannels(worker);
  assert.equal(channels.length, 33_001); // includes the built-in general channel
  assert.equal(listing.calls.length, 2);
  assert.ok(listing.calls.every((call) => call.args.length === 3));
  assert.deepEqual(channels.find((c) => c.id === "room-32999")!.memberIds, [human.id, worker.id].sort());
  listing.restore();
  // Insert a single deliverable row directly to avoid generating a notification recount for every fixture room.
  seedMessages(hive, [{ id: "large-inbox", channelId: "room-32999", authorId: "human", body: "fixture", createdAt: 2 }]);
  const inbox = record(t, hive);
  const result = await hive.delivery.wait(worker, 100);
  const captured = [...inbox.calls]; inbox.restore();
  assert.deepEqual(result.messages.map((m) => m.id), ["large-inbox"]);
  assert.ok(captured.every((call) => call.args.length <= 400));
  const scan = captured.find((call) => /WITH scanned AS MATERIALIZED/.test(call.sql));
  assert.ok(scan);
  assert.ok(scan.args.length <= 8, `InboxReader scan must keep a constant bind count, got ${scan.args.length}`);
  assert.match(scan.sql, /FROM messages WHERE seq > \? ORDER BY seq LIMIT \?/);
  assert.doesNotMatch(scan.sql, /channel_id IN \(\?(?:,\?)+/);
  const search = record(t, hive);
  assert.deepEqual(hive.messageQueries.searchMessages(worker, { q: "fixture" }).hits.map((hit) => hit.body), ["fixture"]);
  assert.ok(search.calls.every((call) => call.args.length <= 400));
  search.restore();
});

test("SQL visibility matches point authorization across projects, private rooms, brains and damaged membership", () => {
  // This fixture also closes all handles on an assertion failure.
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-query-auth-"));
  const file = path.join(dir, "hive.db");
  let hive = new Hive(file);
  try {
    const human = hive.identity.getAgent("human");
    const brain = hive.identity.join({ role: "brain" }).agent;
    const worker = hive.identity.join({ role: "worker", seniority: "mid" }).agent;
    const other = hive.projects.createProject(human, { name: "Other", slug: "other" });
    const foreign = hive.channels.createChannel(human, { name: "foreign", type: "private", project: other.slug });
    const privateRoom = hive.channels.createChannel(brain, { name: "secret", type: "private" });
    const brains = hive.channels.getChannel("brains", brain.projectId);
    addChannelMember(hive, foreign.id, worker.id);
    addChannelMember(hive, brains.id, worker.id);
    for (const actor of [human, brain, worker, { ...worker, projectId: null }]) {
      const listed = hive.channels.listChannels(actor).map((c) => c.id).sort();
      const allowed = hive.channels.listChannels(human).filter((c) => hive.channels.canSeeChannel(actor, c)).map((c) => c.id).sort();
      assert.deepEqual(listed, allowed);
      for (const id of [foreign.id, privateRoom.id, brains.id]) {
        if (!allowed.includes(id)) assert.throws(() => hive.messageQueries.listMessages(actor, id), /Cannot read|not found/i);
      }
    }
    hive.channels.invite(brain, privateRoom.id, [worker.name]);
    assert.ok(hive.channels.listChannels(worker).some((c) => c.id === privateRoom.id));
    hive.db.close(); hive = new Hive(file);
    assert.ok(hive.channels.listChannels(hive.identity.getAgent(worker.id)).some((c) => c.id === privateRoom.id));
    assert.ok(!hive.channels.listChannels(hive.identity.getAgent(worker.id)).some((c) => c.id === foreign.id || c.id === brains.id));
  } finally { hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const compact of [false, true]) {
  test(`600-message brain wait keeps bounded scoped hydration across receipt pages (compact=${compact})`, async (t) => {
    const { hive, human, project, other } = setup(t);
    const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
    const room = hive.channels.createChannel(brain, { name: "work", type: "private" });
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
      const result = await hive.delivery.wait(brain, 100, undefined, { compact });
      assert.equal(result.idle, false);
      assert.ok(result.delivery);
      assert.ok(result.delivery.messageSeqs.length <= 100);
      lastMore = result.more ?? 0;
      if (compact) receivedCompact.push(...(result.mail ?? []));
      else receivedRaw.push(...result.messages);
      receivedCount += result.delivery.messageSeqs.length;
      hive.delivery.acknowledgeInbox(brain, result.delivery.sessionId, result.delivery.id);
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
      assert.deepEqual(hive.messageQueries.getVisibleMessage(brain, receivedRaw[20]!.seq).reactions,
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
    assert.ok(hive.identity.listAgents(human).some((a) => a.projectId === other.id));
  });
}

function decisionFixture(t: TestContext) {
  const { hive, human, project } = setup(t);
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const workers = [0, 1].map(() => hive.identity.join({ role: "worker", seniority: "mid", project: project.slug }).agent);
  const room = hive.channels.createChannel(brain, { name: "decision-budget", type: "private", memberNames: workers.map(w => w.name) });
  const task = hive.tasks.assign(brain, { requestId: "budget-task", worker: workers[0]!.name, channel: room.id,
    contract: { objective: "Budget", scope: ["src"], nonGoals: [], acceptanceCriteria: ["Done"], dependencies: [], evidenceSeqs: [] } }).task;
  let serial = 0;
  const add = (count: number) => {
    for (let i = 0; i < count; i++) {
      const made = hive.decisions.create(brain, { requestId: `budget-${++serial}`, taskId: task.id,
        expectedTaskRevision: hive.tasks.get(brain, task.id).revision, question: `Question ${serial}?`,
        options: [{ id: "a", label: "A", impact: "a" }, { id: "b", label: "B", impact: "b" }],
        recommendation: { optionId: "a", rationale: "Simple", uncertainty: "Low" }, evidenceSeqs: [], artifacts: [],
        affectedWorkers: workers.map(w => w.name), relatedDecisionIds: [] }).decision;
      // Every other decision is answered, so its view carries per-recipient receipts.
      if (serial % 2 === 0) hive.decisions.answer(human, made.id, { requestId: `answer-${serial}`, expectedRevision: made.revision, body: "Take A." });
    }
  };
  return { hive, human, project: room.projectId, add };
}

test("the Human decision queue reads a constant number of statements however many decisions it shows", (t) => {
  const f = decisionFixture(t);
  f.add(4);
  const small = record(t, f.hive);
  assert.equal(f.hive.decisions.listHuman(f.human, f.project).items.length, 4);
  const smallCalls = [...small.calls]; small.restore();
  f.add(36);
  const large = record(t, f.hive);
  const page = f.hive.decisions.listHuman(f.human, f.project);
  const largeCalls = [...large.calls]; large.restore();
  assert.equal(page.items.length, 40);
  assert.ok(page.items.some(item => item.delivery.length === 3), "answered decisions list their recipients' receipts");
  assert.equal(largeCalls.length, smallCalls.length, "no per-decision task, channel or receipt query");
  assert.ok(largeCalls.length <= 12, `decision queue statement budget exceeded: ${largeCalls.length}`);
  const receipts = largeCalls.find(call => /FROM json_each\(\?\) p\s+JOIN inbox_receipts/.test(call.sql));
  assert.ok(receipts);
  assert.match(plan(f.hive, receipts), /SEARCH r USING INDEX sqlite_autoindex_inbox_receipts_1 \(agent_id=\? AND seq=\?\)/);
});

test("channel pages scope thread aggregates to their window and read them through indexes", async (t) => {
  const { hive, project } = setup(t);
  const channel = hive.channels.getChannel("general", project.id);
  // 2,000 threads with a reply each; the page shows the newest 20 messages.
  seedMessages(hive, Array.from({ length: 2_000 }, (_, i) => ({ id: `root-${i}`, channelId: channel.id, authorId: "human", body: `root ${i}`, createdAt: 1 })));
  seedMessages(hive, Array.from({ length: 2_000 }, (_, i) => ({ id: `reply-${i}`, channelId: channel.id, authorId: "human", body: "reply",
    threadId: `root-${i}`, createdAt: 1 })));
  insertRows(hive, "threads", Array.from({ length: 2_000 }, (_, i) => ({ id: `root-${i}`, channel_id: channel.id, status: "open" })));
  const observed = record(t, hive);
  const response = await createApp(hive).request(`/api/ui/channels/${channel.id}/messages?limit=20`);
  const calls = [...observed.calls]; observed.restore();
  const body = await response.json() as { messages: Message[]; threads: { id: string }[]; replyCounts: Record<string, number> };
  assert.equal(body.messages.length, 20);
  const roots = body.messages.map(message => message.id).filter(id => id.startsWith("root-")).sort();
  assert.ok(roots.length > 0);
  assert.deepEqual(Object.keys(body.replyCounts).sort(), roots);
  assert.ok(Object.values(body.replyCounts).every(n => n === 1));
  assert.deepEqual(body.threads.map(thread => thread.id).sort(), roots);
  const threads = calls.find(call => /FROM threads\s+WHERE id IN/.test(call.sql))!;
  const counts = calls.find(call => /COUNT\(\*\) AS n FROM messages/.test(call.sql))!;
  assert.ok(threads.count <= 20 && counts.count <= 20, "aggregates never return rows outside the page");
  assert.doesNotMatch(plan(hive, threads), /SCAN threads/);
  assert.match(plan(hive, counts), /SEARCH messages USING (?:COVERING )?INDEX idx_messages_channel_thread_seq \(channel_id=\? AND thread_id=\?\)/);
  assert.doesNotMatch(plan(hive, counts), /SCAN messages/);
});

test("the UI snapshot estimates each agent's inbox once, and room history uses its index", async (t) => {
  const { hive, human, project } = setup(t);
  hive.identity.join({ role: "brain", project: project.slug });
  const agents = hive.identity.listAgents().filter(agent => agent.role === "brain" || agent.role === "worker").length;
  const estimate = t.mock.method(InboxReader.prototype, "estimate");
  const snapshot = await (await createApp(hive).request("/api/ui/snapshot")).json() as { queued: Record<string, number>; inbox: Record<string, unknown> };
  assert.equal(estimate.mock.callCount(), agents);
  assert.deepEqual(Object.keys(snapshot.queued).sort(), Object.keys(snapshot.inbox).sort());
  const observed = record(t, hive);
  hive.rooms.history(human, "general");
  const history = observed.calls.find(call => /FROM room_events/.test(call.sql))!; observed.restore();
  assert.match(plan(hive, history), /SEARCH room_events USING INDEX idx_room_events_channel_revision \(channel_id=\? AND revision<\?\)/);
});
