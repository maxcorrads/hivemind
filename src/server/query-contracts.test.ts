import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import { Hive } from "./hive.ts";

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
  const insert = hive.db.prepare(`INSERT INTO agents
    (id,name,role,seniority,token_hash,online,last_seen_at,created_at,inbox_cursor,project_id)
    VALUES (?,?,'worker','mid',?,0,1,1,0,?)`);
  for (let i = 0; i < count; i++) insert.run(`${prefix}${i}`, `${prefix}${i}`, `${prefix}${i}`, projectId);
}
function fillChannels(hive: Hive, projectId: string, actorId: string, count: number, prefix: string) {
  const channel = hive.db.prepare("INSERT INTO channels VALUES (?,?,'private',NULL,'human',1,?)");
  const member = hive.db.prepare("INSERT INTO channel_members VALUES (?,?)");
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    channel.run(id, id, projectId); member.run(id, actorId); member.run(id, "human");
  }
}
function plan(hive: Hive, call: Call): string {
  return (hive.db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as { detail: string }[]).map((row) => row.detail).join("\n");
}

test("50,000 unrelated agents and 2,000 channels do not enter scoped hydration; both roster OR arms use indexes", (t) => {
  const { hive, worker, project, other } = setup(t);
  const initial = record(t, hive);
  const expectedAgents = hive.listAgents(worker);
  const expectedChannels = hive.listChannels(worker);
  const baseline = initial.calls.map(({ count }) => count);
  initial.restore();
  hive.db.exec("BEGIN");
  try {
    fillAgents(hive, other.id, 50_000, "other-agent-");
    fillChannels(hive, other.id, "other-agent-0", 2_000, "other-channel-");
    hive.db.exec("COMMIT");
  } catch (error) { hive.db.exec("ROLLBACK"); throw error; }
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
  hive.db.exec("BEGIN");
  try { fillChannels(hive, project.id, worker.id, 33_000, "room-"); hive.db.exec("COMMIT"); }
  catch (error) { hive.db.exec("ROLLBACK"); throw error; }
  const listing = record(t, hive);
  const channels = hive.listChannels(worker);
  assert.equal(channels.length, 33_001); // includes the built-in general channel
  assert.equal(listing.calls.length, 2);
  assert.ok(listing.calls.every((call) => call.args.length === 3));
  assert.deepEqual(channels.find((c) => c.id === "room-32999")!.memberIds, [human.id, worker.id].sort());
  listing.restore();
  // Insert a single deliverable row directly to avoid generating a notification recount for every fixture room.
  hive.db.prepare("INSERT INTO messages (id,channel_id,author_id,body,created_at) VALUES ('large-inbox','room-32999','human','fixture',2)").run();
  const inbox = record(t, hive);
  const result = await hive.wait(worker, 100);
  const captured = [...inbox.calls]; inbox.restore();
  assert.deepEqual(result.messages.map((m) => m.id), ["large-inbox"]);
  assert.ok(captured.every((call) => call.args.length <= 400));
  const scan = captured.find((call) => /SELECT \* FROM messages WHERE seq >/.test(call.sql))!;
  assert.ok(scan);
  const explain = plan(hive, scan);
  assert.match(explain, /SEARCH messages USING INDEX idx_messages_channel_seq/);
  assert.doesNotMatch(explain, /SCAN messages\b/);
  assert.match(explain, /SEARCH mine USING COVERING INDEX idx_channel_members_agent_channel/);
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
    hive.db.prepare("INSERT INTO channel_members VALUES (?,?)").run(foreign.id, worker.id);
    hive.db.prepare("INSERT INTO channel_members VALUES (?,?)").run(brains.id, worker.id);
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
  test(`600-message brain wait batches authors/metadata and memoizes compact labels (compact=${compact})`, async (t) => {
    const { hive, human, project, other } = setup(t);
    const brain = hive.join({ role: "brain", project: project.slug }).agent;
    const room = hive.createChannel(brain, { name: "work", type: "private" });
    hive.db.exec("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages)");
    const insert = hive.db.prepare("INSERT INTO messages (id,channel_id,author_id,body,created_at) VALUES (?,?,?,?,1)");
    const attachment = hive.db.prepare("INSERT INTO attachments VALUES (?,?,?,'text/plain',3,?,'human',1)");
    const reaction = hive.db.prepare("INSERT INTO reactions VALUES (?,'human','👍',1)");
    hive.db.exec("BEGIN");
    try {
      fillAgents(hive, project.id, 600, "author-");
      for (let i = 0; i < 600; i++) {
        const id = `mail-${i}`;
        insert.run(id, room.id, i === 599 ? "deleted-author" : `author-${i}`, `body-${i}`);
        attachment.run(`attachment-${i}`, id, `${i}.txt`, "f".repeat(64)); reaction.run(id);
      }
      fillAgents(hive, other.id, 1, "outsider-");
      fillChannels(hive, other.id, "outsider-0", 1, "outside-room-");
      for (let i = 0; i < 10_000; i++) insert.run(`outside-${i}`, "outside-room-0", "outsider-0", "not visible");
      hive.db.exec("COMMIT");
    } catch (error) { hive.db.exec("ROLLBACK"); throw error; }
    const observed = record(t, hive);
    const result = await hive.wait(brain, 100, undefined, { compact });
    const calls = [...observed.calls]; observed.restore();
    assert.equal(result.idle, false);
    assert.equal(compact ? result.mail?.length : result.messages.length, 600);
    assert.equal(result.more, 0);
    if (!compact) {
      assert.equal(result.messages[599]!.authorName, "unknown");
      assert.equal(result.messages[599]!.authorRole, "worker");
      assert.deepEqual(result.messages[20]!.attachments, [{ id: "attachment-20", name: "20.txt", mime: "text/plain", bytes: 3 }]);
      assert.deepEqual(result.messages[20]!.reactions, [{ emoji: "👍", count: 1, mine: false }]);
    } else assert.ok(result.mail?.every((m) => m.ch === "#work"));
    assert.equal(calls.filter((call) => /SELECT id, name, role FROM agents WHERE id IN/.test(call.sql)).length, 6);
    assert.equal(calls.filter((call) => /SELECT id, message_id, name, mime, bytes FROM attachments/.test(call.sql)).length, 2);
    assert.equal(calls.filter((call) => /SELECT message_id, emoji, agent_id FROM reactions/.test(call.sql)).length, 2);
    assert.ok(calls.every((call) => call.args.length <= 400));
    assert.ok(calls.length < 40, `unexpected N+1: ${calls.length} SQL calls`);
    // The unrelated backlog never becomes a message or author hydration row.
    const scans = calls.filter((call) => /SELECT \* FROM messages WHERE seq >/.test(call.sql));
    assert.equal(scans.reduce((sum, call) => sum + call.count, 0), 600);
    assert.ok(hive.listAgents(human).some((a) => a.projectId === other.id));
  });
}
