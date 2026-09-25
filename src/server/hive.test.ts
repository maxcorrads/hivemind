import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { countRows, findRow, insertRow, readValue, setAgentPresence } from "./test-fixtures.ts";
import { BODY_MAX } from "../shared/types.ts";

function tempHive() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  return { hive, dir };
}

test("a new hive has no project until Human creates one", () => {
  const previous = process.env.HIVEMIND_FIXTURE_PROJECT;
  delete process.env.HIVEMIND_FIXTURE_PROJECT;
  try {
    const { hive, dir } = tempHive();
    assert.deepEqual(hive.projects.listProjects(), []);
    hive.close();
    rmSync(dir, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_FIXTURE_PROJECT;
    else process.env.HIVEMIND_FIXTURE_PROJECT = previous;
  }
});

test("workers cannot forge control messages", () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  const peer = hive.identity.join({ role: "worker", seniority: "mid" });
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  assert.throws(
    () =>
      hive.messages.postMessage(worker.agent, {
        channel: "general",
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () =>
      hive.messages.postMessage(worker.agent, {
        channel: dm.id,
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () => hive.messages.postMessage(peer.agent, { channel: "general", body: "join", kind: "system" }),
    /system/,
  );
  hive.messages.clearContext(brain.agent, worker.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

test("workers cannot mention Human or open a DM with Human", () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  assert.equal(worker.agent.role, "worker");
  assert.throws(
    () => hive.messages.postMessage(worker.agent, { channel: "general", body: "hello @Human" }),
    /cannot mention/,
  );
  assert.throws(() => hive.channels.openDm(worker.agent, "Human"), /cannot open a DM with Human/);
  rmSync(dir, { recursive: true, force: true });
});

test("workers cannot see or post in #brains", () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const brain = hive.identity.join({ role: "brain" });
  const channels = hive.channels.listChannels(worker.agent).map((c) => c.name);
  assert.ok(!channels.includes("brains"));
  assert.throws(
    () => hive.messages.postMessage(worker.agent, { channel: "brains", body: "nope" }),
    /cannot post/,
  );
  const msg = hive.messages.postMessage(brain.agent, { channel: "brains", body: "hello @Human we need a goal" });
  assert.ok(msg.mentions.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("channel references accept a display #name everywhere the server resolves them (#218)", () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const general = hive.channels.getChannel("general", brain.agent.projectId);
  assert.equal(hive.channels.getChannel("#general", brain.agent.projectId).id, general.id);
  assert.equal(hive.channels.getChannel(" #General ").id, general.id);
  const room = hive.channels.createChannel(brain.agent, { name: "ops", type: "private" });
  hive.channels.invite(brain.agent, "#ops", [worker.agent.name]);
  assert.ok(hive.channels.getChannel(room.id).memberIds.includes(worker.agent.id));
  assert.equal(hive.messages.postMessage(brain.agent, { channel: "#ops", body: "hi" }).channelId, room.id);
  rmSync(dir, { recursive: true, force: true });
});

test("role is sticky and offline work waits", async () => {
  const { hive, dir } = tempHive();
  const first = hive.identity.join({ role: "worker", seniority: "junior", focus: "frontend" });
  assert.throws(
    () => hive.identity.join({ role: "brain", token: first.token }),
    /cannot change/,
  );
  hive.identity.setOffline(first.agent.id);
  const brain = hive.identity.join({ role: "brain" });
  hive.channels.openDm(brain.agent, first.agent.name);
  hive.messages.postMessage(brain.agent, {
    channel: hive.channels.findDm(brain.agent.id, first.agent.id)!.id,
    body: "when you are back, fix the login",
  });
  const back = hive.identity.join({ role: "worker", seniority: "junior", token: first.token });
  const inbox = await hive.delivery.wait(back.agent, 500);
  assert.equal(inbox.idle, false);
  const all = [...inbox.control, ...inbox.mentions, ...inbox.messages];
  assert.ok(all.some((m) => /login/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("a stale session key plus resume name resumes by name and supersedes the old session", () => {
  const { hive, dir } = tempHive();
  const first = hive.identity.join({ role: "brain" });
  const resumed = hive.identity.join({ role: "brain", token: "dead-token", resumeName: first.agent.name });
  assert.equal(resumed.agent.id, first.agent.id);
  assert.equal(hive.identity.agentByToken(resumed.token).id, first.agent.id);
  assert.throws(() => hive.identity.agentByToken(first.token), /Invalid token/);
  rmSync(dir, { recursive: true, force: true });
});

test("resume name cannot use another agent's token", () => {
  const { hive, dir } = tempHive();
  const a = hive.identity.join({ role: "brain" });
  const b = hive.identity.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.identity.join({ role: "worker", seniority: "mid", token: a.token, resumeName: b.agent.name }),
    /not /,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("two joins without a token create two employees", () => {
  const { hive, dir } = tempHive();
  const a = hive.identity.join({ role: "brain" });
  const b = hive.identity.join({ role: "worker", seniority: "mid" });
  assert.notEqual(a.agent.id, b.agent.id);
  assert.notEqual(a.agent.name, b.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

test("public chatter does not wake a waiting worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  const brain = hive.identity.join({ role: "brain" });
  let settled = false;
  const sleeping = hive.delivery.wait(worker.agent, 400).finally(() => { settled = true; });
  hive.messages.postMessage(brain.agent, { channel: "general", body: "noise one" });
  hive.messages.postMessage(brain.agent, { channel: "general", body: "noise two" });
  t.mock.timers.tick(399);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "public chatter must not end the wait before its timeout");
  t.mock.timers.tick(1);
  const result = await sleeping;
  assert.equal(result.idle, true);
  rmSync(dir, { recursive: true, force: true });
});

test("restart does not add Human to brain-worker DMs", () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  assert.ok(!dm.memberIds.includes("human"));
  const again = new Hive(path.join(dir, "hive.db"));
  assert.ok(!again.channels.getChannel(dm.id).memberIds.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("wait wakes workers only for addressed mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  const brain = hive.identity.join({ role: "brain" });
  hive.messages.postMessage(brain.agent, { channel: "general", body: "status update, no mention" });
  const idle = await hive.delivery.wait(worker.agent, 400);
  assert.equal(idle.idle, true);
  hive.messages.postMessage(brain.agent, { channel: "general", body: `please take this @${worker.agent.name}` });
  const hit = await hive.delivery.wait(worker.agent, 400);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(worker.agent.name)));
  rmSync(dir, { recursive: true, force: true });
});

test("brains do not wake on #general unless mentioned", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  hive.messages.postMessage(worker.agent, { channel: "general", body: "status only" });
  const idle = await hive.delivery.wait(brain.agent, 300);
  assert.equal(idle.idle, true);
  hive.messages.postMessage(worker.agent, { channel: "general", body: `need a call @${brain.agent.name}` });
  const hit = await hive.delivery.wait(brain.agent, 300);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(brain.agent.name)));
  const other = hive.identity.join({ role: "brain" });
  hive.messages.postMessage(brain.agent, { channel: "brains", body: "coord ping" });
  const brainsMail = await hive.delivery.wait(other.agent, 300);
  assert.equal(brainsMail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("last wait wins and the old one is superseded", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  // wait() installs its waiter synchronously, so the next call supersedes it without any delay.
  const first = hive.delivery.wait(worker.agent, 8_000);
  const second = hive.delivery.wait(worker.agent, 8_000);
  await assert.rejects(first, /superseded/);
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  hive.messages.postMessage(brain.agent, { channel: dm.id, body: "only the new waiter" });
  const got = await second;
  assert.equal(got.idle, false);
  assert.ok(got.messages.some((m) => /only the new waiter/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("brain compact wait keeps full bodies on one conversation", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  const task =
    "implement deadline_ms on the settings page and wire validation for all form fields including edge cases around timezone offsets";
  hive.messages.postMessage(worker.agent, { channel: dm.id, body: "first update with enough text" });
  hive.messages.postMessage(worker.agent, { channel: dm.id, body: task });
  const compact = await hive.delivery.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(compact.mail?.length, 2);
  assert.ok(compact.mail?.every((m) => (m.body ?? "").length > 0));
  assert.ok(compact.mail?.some((m) => m.body === task));
  assert.ok(!("createdAt" in compact.you));
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait: worker gets body, brain digest on many DMs, cursor keeps the rest", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const workers = [0, 1, 2].map(() => hive.identity.join({ role: "worker", seniority: "mid" }));
  for (const w of workers) {
    const dm = hive.channels.openDm(brain.agent, w.agent.name);
    hive.messages.postMessage(w.agent, { channel: dm.id, body: `report from ${w.agent.name} with enough text`, eventType: "progress" });
  }
  const compact = await hive.delivery.wait(brain.agent, 300, undefined, { compact: true });
  assert.equal(compact.idle, false);
  assert.match(compact.next, /wait again/);
  assert.equal(compact.messages.length, 0);
  assert.ok((compact.mail?.length ?? 0) >= 1);
  assert.ok(compact.mail?.every((m) => m.excerpt && m.expand));

  const worker = workers[0]!;
  const dm = hive.channels.findDm(brain.agent.id, worker.agent.id)!;
  hive.messages.postMessage(brain.agent, { channel: dm.id, body: "implement the settings page please" });
  const wmail = await hive.delivery.wait(worker.agent, 300, undefined, { compact: true });
  assert.ok(wmail.mail?.some((m) => /settings page/.test(m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait caps conversations not a single flooded DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const flooded = hive.identity.join({ role: "worker", seniority: "mid" });
  const other = hive.identity.join({ role: "worker", seniority: "mid" });
  const floodDm = hive.channels.openDm(brain.agent, flooded.agent.name);
  const otherDm = hive.channels.openDm(brain.agent, other.agent.name);
  let root: string | undefined;
  for (let i = 0; i < 8; i += 1) {
    const message = hive.messages.postMessage(flooded.agent, { channel: floodDm.id, body: `flood ${i}`, threadId: root, eventType: "progress" });
    root ??= message.id;
  }
  hive.messages.postMessage(other.agent, { channel: otherDm.id, body: "second conversation", eventType: "progress" });
  const first = await hive.delivery.wait(brain.agent, 500, undefined, { compact: true });
  assert.equal(first.mail?.length, 2);
  assert.equal(first.mail?.find(m => m.rootId === root)?.count, 8);
  assert.ok(first.mail?.some((m) => /second conversation/.test(m.excerpt ?? m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("inbox cursor does not skip capped mail", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const workers = Array.from({ length: 10 }, () => hive.identity.join({ role: "worker", seniority: "junior" }));
  for (const w of workers) {
    const dm = hive.channels.openDm(brain.agent, w.agent.name);
    hive.messages.postMessage(w.agent, { channel: dm.id, body: `ping ${w.agent.name}` });
  }
  const first = await hive.delivery.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(first.idle, false);
  assert.ok((first.more ?? 0) > 0);
  hive.delivery.acknowledgeInbox(brain.agent, first.delivery!.sessionId, first.delivery!.id);
  const second = await hive.delivery.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(second.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait skips a pile of #general and still gets the DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  for (let i = 0; i < 250; i += 1) {
    hive.messages.postMessage(worker.agent, { channel: "general", body: `noise ${i}` });
  }
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  hive.messages.postMessage(worker.agent, { channel: dm.id, body: "the real task" });
  const mail = await hive.delivery.wait(brain.agent, 400);
  assert.equal(mail.idle, false);
  assert.ok(mail.messages.some((m) => /real task/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("sweep keeps waiters online and drops stale agents", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const sleeping = hive.delivery.wait(worker.agent, 4_000);
  setAgentPresence(hive, worker.agent.id, { lastSeenAt: Date.now() - 60_000 });
  hive.identity.sweepPresence(1_000);
  assert.equal(hive.identity.getAgent(worker.agent.id).online, true);
  const idle = hive.identity.join({ role: "worker", seniority: "junior" });
  setAgentPresence(hive, idle.agent.id, { lastSeenAt: Date.now() - 60_000, online: true });
  hive.identity.sweepPresence(1_000);
  assert.equal(hive.identity.getAgent(idle.agent.id).online, false);
  hive.messages.postMessage(hive.identity.getAgent("human"), { channel: "general", body: `x @${worker.agent.name}` });
  const mail = await sleeping;
  assert.equal(mail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("attachments and reactions stay on the message", async () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" });
  const file = await hive.files.createFileFromBytes(human, {
    name: "note.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("hello file"),
  });
  const msg = hive.messages.postMessage(human, { channel: "general", body: "", attachmentIds: [file.id] });
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]?.name, "note.txt");
  const reacted = hive.messages.toggleReaction(brain.agent, msg.seq, "👍");
  assert.equal(reacted.added, true);
  assert.ok(reacted.message.reactions?.some((r) => r.emoji === "👍"));
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.messages.postMessage(worker.agent, { channel: "brains", body: "x", attachmentIds: [] }),
    /cannot post/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("body longer than BODY_MAX (20,000) is rejected", () => {
  const { hive, dir } = tempHive();
  const brain = hive.identity.join({ role: "brain" });
  assert.throws(
    () => hive.messages.postMessage(brain.agent, { channel: "general", body: "x".repeat(BODY_MAX + 1) }),
    /too long/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait control includes the full body", async () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  hive.messages.clearContext(human, worker.agent.name);
  const mail = await hive.delivery.wait(worker.agent, 300, undefined, { compact: true });
  const control = mail.control[0] as { action?: string; body?: string };
  assert.equal(control.action, "clear_context");
  assert.ok(control.body && control.body.length > 20);
  rmSync(dir, { recursive: true, force: true });
});

test("queued counts pending isFor mail and drops after wait", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "senior" });
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  hive.messages.postMessage(brain.agent, { channel: dm.id, body: "do the settings" });
  assert.equal(hive.delivery.queuedCounts()[worker.agent.id], 1);
  assert.equal(hive.delivery.queuedCounts()[brain.agent.id] ?? 0, 0);
  await hive.delivery.wait(worker.agent, 200);
  assert.equal(hive.delivery.queuedCounts()[worker.agent.id], 0);
  rmSync(dir, { recursive: true, force: true });
});

test("aborted wait keeps the agent online and does not consume mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  const ac = new AbortController();
  const pending = hive.delivery.wait(worker.agent, 8_000, ac.signal);
  ac.abort();
  const aborted = await pending;
  assert.equal(aborted.idle, true);
  assert.equal(hive.identity.getAgent(worker.agent.id).online, true);
  hive.messages.postMessage(brain.agent, { channel: dm.id, body: "do not lose this" });
  const mail = await hive.delivery.wait(worker.agent, 200);
  assert.equal(mail.idle, false);
  assert.ok([...mail.messages, ...mail.mentions].some((m) => /do not lose this/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("For you hides mentions after the channel is read", () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" });
  const msg = hive.messages.postMessage(brain.agent, { channel: "general", body: "need a goal @Human" });
  const open = hive.reads.mentionInbox(human, 30);
  assert.equal(open.messages.length, 1);
  hive.reads.markRead(human, "general", msg.seq);
  const seen = hive.reads.mentionInbox(human, 30);
  assert.equal(seen.messages.length, 0);
  const again = hive.messages.postMessage(brain.agent, { channel: "general", body: "another ask @Human" });
  assert.equal(hive.reads.mentionInbox(human, 30).messages.length, 1);
  hive.reads.markMentionsSeen(human);
  assert.equal(hive.reads.mentionInbox(human, 30).messages.length, 0);
  assert.equal(hive.reads.unreadCounts(human).general ?? 0, 0);
  assert.ok(again.seq > msg.seq);
  rmSync(dir, { recursive: true, force: true });
});

test("hasReaction is true for the acting agent even without decorate actor", () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" });
  const msg = hive.messages.postMessage(brain.agent, { channel: "brains", body: "ping @Human" });
  hive.messages.toggleReaction(human, msg.seq, "👍");
  const raw = hive.messageQueries.getMessageBySeq(msg.seq);
  assert.equal(raw.reactions?.some((r) => r.emoji === "👍" && r.mine), false);
  assert.equal(hive.messageQueries.hasReaction(human.id, msg.id, "👍"), true);
  hive.messages.toggleReaction(human, msg.seq, "👍");
  assert.equal(hive.messageQueries.hasReaction(human.id, msg.id, "👍"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("Human can see brain-worker DMs and invite to private rooms", () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const brain = hive.identity.join({ role: "brain" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  hive.messages.postMessage(brain.agent, { channel: dm.id, body: "secret assignment" });
  const humanChannels = hive.channels.listChannels(human).map((c) => c.id);
  assert.ok(humanChannels.includes(dm.id));
  const privateCh = hive.channels.createChannel(brain.agent, { name: "login", type: "private" });
  hive.channels.invite(brain.agent, privateCh.id, [worker.agent.name]);
  const room = hive.channels.getChannel(privateCh.id);
  assert.ok(room.memberIds.includes(worker.agent.id));
  rmSync(dir, { recursive: true, force: true });
});

test("Human can remove a brain and keep their messages", () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const extra = hive.identity.join({ role: "brain" });
  const keep = hive.identity.join({ role: "brain" });
  const posted = hive.messages.postMessage(extra.agent, { channel: "general", body: "stay after I am gone" });
  assert.throws(() => hive.identity.removeAgent(keep.agent, extra.agent.name), /Only Human/);
  assert.throws(() => hive.identity.removeAgent(human, "Human"), /Cannot remove Human/);
  hive.identity.removeAgent(human, extra.agent.name);
  assert.equal(hive.identity.getAgentByName(extra.agent.name), null);
  assert.ok(hive.identity.getAgentByName(keep.agent.name));
  const still = hive.messageQueries.listMessages(human, "general").messages;
  assert.ok(still.some((m) => m.id === posted.id));
  rmSync(dir, { recursive: true, force: true });
});

test("search stays in one project and only rooms the actor can see", async () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const solace = hive.identity.join({ role: "brain" });
  const dowel = hive.identity.join({ role: "worker", seniority: "senior" });
  hive.projects.createProject(human, { name: "Altro", slug: "altro" });
  const atlas = hive.identity.join({ role: "brain", project: "altro" });
  const rivet = hive.identity.join({ role: "worker", seniority: "mid", project: "altro" });
  const secret = hive.channels.createChannel(solace.agent, { name: "secret", type: "private", memberNames: [] });
  hive.messages.postMessage(solace.agent, { channel: "general", body: "oauth login on feat/login" });
  hive.messages.postMessage(solace.agent, { channel: "brains", body: "brain-only oauth note @Human" });
  hive.messages.postMessage(solace.agent, { channel: secret.id, body: "private oauth stash" });
  const dm = hive.channels.openDm(solace.agent, dowel.agent.name);
  hive.messages.postMessage(solace.agent, { channel: dm.id, body: "worker may see this oauth dm" });
  const file = await hive.files.createFileFromBytes(human, {
    name: "oauth-plan.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("plan"),
  });
  const attached = hive.messages.postMessage(human, { channel: "general", body: "file follows", attachmentIds: [file.id] });
  hive.messages.toggleReaction(solace.agent, attached.seq, "✅");
  hive.messages.postMessage(atlas.agent, { channel: "general", body: "altro oauth must not leak" });

  const humanHits = hive.messageQueries.searchMessages(human, { q: "oauth", project: "chapter" });
  assert.ok(humanHits.hits.some((h) => /feat\/login/.test(h.body)));
  assert.ok(humanHits.hits.some((h) => h.channelName === "brains"));
  assert.ok(humanHits.hits.some((h) => h.channelName === "secret"));
  assert.equal(humanHits.hits.some((h) => /must not leak/.test(h.body)), false);

  const brainHits = hive.messageQueries.searchMessages(solace.agent, { q: "oauth" });
  assert.ok(brainHits.hits.some((h) => h.channelName === "brains"));
  assert.equal(brainHits.hits.some((h) => /must not leak/.test(h.body)), false);
  assert.throws(() => hive.messageQueries.searchMessages(solace.agent, { q: "oauth", project: "altro" }), /other projects/);

  const workerHits = hive.messageQueries.searchMessages(dowel.agent, { q: "oauth" });
  assert.ok(workerHits.hits.some((h) => /feat\/login/.test(h.body)));
  assert.ok(workerHits.hits.some((h) => /oauth dm/.test(h.body)));
  assert.equal(workerHits.hits.some((h) => h.channelName === "brains"), false);
  assert.equal(workerHits.hits.some((h) => h.channelName === "secret"), false);
  assert.throws(() => hive.messageQueries.searchMessages(dowel.agent, { q: "oauth", channel: "brains" }), /Cannot search/);

  const fileHits = hive.messageQueries.searchMessages(dowel.agent, { q: "oauth-plan.txt" });
  assert.ok(fileHits.hits.some((h) => h.seq === attached.seq));
  const reactHits = hive.messageQueries.searchMessages(human, { q: "✅", project: "chapter" });
  assert.ok(reactHits.hits.some((h) => h.seq === attached.seq));
  const mentionHits = hive.messageQueries.searchMessages(solace.agent, { q: "Human" });
  assert.ok(mentionHits.hits.some((h) => h.channelName === "brains"));
  const seqHits = hive.messageQueries.searchMessages(human, { q: String(attached.seq), project: "chapter" });
  assert.ok(seqHits.hits.some((h) => h.seq === attached.seq));
  let lonely = hive.messages.postMessage(human, { channel: "general", body: "no digits in this line" });
  while (lonely.seq < 10) {
    lonely = hive.messages.postMessage(human, { channel: "general", body: "no digits in this line" });
  }
  const digit = String(lonely.seq)[0]!;
  assert.equal(
    hive.messageQueries.searchMessages(human, { q: digit, project: "chapter" }).hits.some((h) => h.seq === lonely.seq),
    false,
  );
  const quoted = hive.messageQueries.searchMessages(human, { q: `"feat/login`, project: "chapter" });
  assert.ok(quoted.hits.some((h) => /feat\/login/.test(h.body)));
  const paged = hive.messageQueries.searchMessages(human, { q: "oauth", project: "chapter", limit: 1 });
  assert.equal(paged.hits.length, 1);
  assert.equal(paged.hasMore, true);
  const next = hive.messageQueries.searchMessages(human, {
    q: "oauth",
    project: "chapter",
    limit: 20,
    beforeSeq: paged.hits[0]!.seq,
  });
  assert.ok(next.hits.every((h) => h.seq < paged.hits[0]!.seq));
  const fromStart = hive.messageQueries.searchMessages(human, { q: "oauth", project: "chapter", beforeSeq: 0 });
  assert.equal(fromStart.hits.length, hive.messageQueries.searchMessages(human, { q: "oauth", project: "chapter" }).hits.length);
  assert.throws(() => hive.messageQueries.searchMessages(human, { q: "oauth" }), /Project required/);
  assert.equal(hive.messageQueries.searchMessages(rivet.agent, { q: "oauth" }).hits.some((h) => /feat\/login/.test(h.body)), false);
  rmSync(dir, { recursive: true, force: true });
});

test("projects are isolated: roster, DM, mentions, wait, join cwd", async () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const chapter = hive.projects.listProjects()[0]!;
  assert.equal(chapter.slug, "chapter");
  hive.projects.updateProject(human, "chapter", { worktree: dir });
  const solace = hive.identity.join({ role: "brain" });
  const dowel = hive.identity.join({ role: "worker", seniority: "senior" });
  const other = hive.projects.createProject(human, { name: "Altro", slug: "altro", worktree: path.join(dir, "altro") });
  const atlas = hive.identity.join({ role: "brain", project: "altro" });
  const rivet = hive.identity.join({ role: "worker", seniority: "mid", cwd: path.join(dir, "altro") });
  assert.equal(atlas.agent.project, "altro");
  assert.equal(rivet.agent.project, "altro");
  assert.throws(() => hive.projects.createProject(atlas.agent, { name: "Nope", slug: "nope" }), /Only Human/);
  assert.deepEqual(
    hive.identity.listAgents(atlas.agent).filter((a) => a.role !== "human").map((a) => a.name).sort(),
    [atlas.agent.name, rivet.agent.name].sort(),
  );
  assert.ok(!hive.channels.listChannels(atlas.agent).some((c) => c.id === "general" || c.project === "chapter"));
  assert.notEqual(hive.channels.getChannel("general", atlas.agent.projectId).id, "general");
  assert.throws(() => hive.channels.openDm(atlas.agent, dowel.agent.name), /not in your project/);
  assert.throws(() => hive.identity.join({ role: "worker", seniority: "junior", cwd: path.join(dir, "unknown") }), /Pass project=slug/);
  assert.throws(
    () => hive.identity.join({ role: "brain", token: solace.token, resumeName: solace.agent.name, project: "altro" }),
    /project cannot change/,
  );
  const back = hive.identity.join({ role: "brain", token: solace.token, resumeName: solace.agent.name });
  assert.equal(back.agent.project, "chapter");
  hive.messages.postMessage(atlas.agent, { channel: "general", body: `take this @${rivet.agent.name}` });
  const idle = await hive.delivery.wait(dowel.agent, 200);
  assert.equal(idle.idle, true);
  const hit = await hive.delivery.wait(rivet.agent, 200);
  assert.equal(hit.idle, false);
  const mention = hive.messages.postMessage(atlas.agent, { channel: "general", body: "need a goal @Human" });
  const inbox = hive.reads.mentionInbox(human, 30, undefined, other.id);
  assert.ok(inbox.messages.some((m) => m.id === mention.id));
  const chapterInbox = hive.reads.mentionInbox(human, 30, undefined, chapter.id);
  assert.ok(!chapterInbox.messages.some((m) => m.id === mention.id));
  rmSync(dir, { recursive: true, force: true });
});

test("Human can delete an idle project but not one with online or waiting agents", async () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  hive.projects.createProject(human, { name: "Altro", slug: "altro" });
  const brain = hive.identity.join({ role: "brain", project: "altro" });
  hive.messages.postMessage(brain.agent, { channel: "general", body: "keep this until delete" });
  assert.throws(() => hive.projects.deleteProject(brain.agent, "altro"), /Only Human/);
  assert.throws(() => hive.projects.deleteProject(human, "altro"), /still online or waiting/);
  const ac = new AbortController();
  const pending = hive.delivery.wait(brain.agent, 8_000, ac.signal);
  assert.throws(() => hive.projects.deleteProject(human, "altro"), new RegExp(brain.agent.name));
  ac.abort();
  await pending;
  hive.identity.setOffline(brain.agent.id);
  insertRow(hive, "telegram_hold", { telegram_chat_id: -1003, telegram_message_id: 7, telegram_thread_id: 2, payload: "{}" });
  insertRow(hive, "telegram_state", { key: "mute:-1003", value: "1" });
  insertRow(hive, "telegram_state", { key: "offset", value: "9" });
  const chapterGeneral = hive.channels.getChannel("general", hive.projects.getProjectBySlug("chapter").id);
  hive.messages.postMessage(human, { channel: chapterGeneral.id, body: "chapter stays" });
  hive.projects.deleteProject(human, "altro", { telegramChatId: -1003 });
  assert.equal(hive.projects.listProjects().some((p) => p.slug === "altro"), false);
  assert.equal(hive.identity.getAgentByName(brain.agent.name), null);
  assert.equal(hive.projects.listProjects()[0]?.slug, "chapter");
  assert.ok(hive.channels.getChannel("general", hive.projects.listProjects()[0]!.id));
  assert.equal(
    countRows(hive, "telegram_hold", { telegram_chat_id: -1003 }),
    0,
  );
  assert.equal(findRow(hive, "telegram_state", { key: "mute:-1003" }), undefined);
  assert.equal(readValue(hive, "telegram_state", "value", { key: "offset" }), "9");
  assert.ok(hive.messageQueries.listMessages(human, chapterGeneral.id).messages.some((m) => /chapter stays/.test(m.body)));
  assert.equal(hive.projects.findProjectBySlug("altro"), null);
  assert.equal(hive.projects.findProjectBySlug("!!!"), null);
  assert.equal(hive.projects.findProjectBySlug("chapter")?.slug, "chapter");
  hive.projects.deleteProject(human, "chapter");
  assert.equal(hive.projects.listProjects().length, 0);
  const again = hive.projects.createProject(human, { name: "Nuovo", slug: "nuovo" });
  assert.equal(again.slug, "nuovo");
  rmSync(dir, { recursive: true, force: true });
});

test("the picker's extra reactions are accepted; anything else is still rejected (#221)", () => {
  const { hive, dir } = tempHive();
  const human = hive.identity.getAgent("human");
  const msg = hive.messages.postMessage(human, { channel: "general", body: "ship it" });
  assert.equal(hive.messages.setReaction(human, msg.seq, "🎉", true).added, true);
  assert.equal(hive.messages.setReaction(human, msg.seq, "❤️", true).message.reactions?.some((r) => r.emoji === "❤️"), true);
  assert.throws(() => hive.messages.setReaction(human, msg.seq, "🦄", true), /Invalid reaction/);
  rmSync(dir, { recursive: true, force: true });
});
