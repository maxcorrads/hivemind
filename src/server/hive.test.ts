import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hive } from "./hive.ts";

function tempHive() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  return { hive, dir };
}

test("workers cannot forge control messages", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const peer = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  assert.throws(
    () =>
      hive.postMessage(worker.agent, {
        channel: "general",
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () =>
      hive.postMessage(worker.agent, {
        channel: dm.id,
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () => hive.postMessage(peer.agent, { channel: "general", body: "join", kind: "system" }),
    /system/,
  );
  hive.clearContext(brain.agent, worker.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

test("workers cannot mention Human or open a DM with Human", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  assert.equal(worker.agent.role, "worker");
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "general", body: "hello @Human" }),
    /cannot mention/,
  );
  assert.throws(() => hive.openDm(worker.agent, "Human"), /cannot open a DM with Human/);
  rmSync(dir, { recursive: true, force: true });
});

test("workers cannot see or post in #brains", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const channels = hive.listChannels(worker.agent).map((c) => c.name);
  assert.ok(!channels.includes("brains"));
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "brains", body: "nope" }),
    /cannot post/,
  );
  const msg = hive.postMessage(brain.agent, { channel: "brains", body: "hello @Human we need a goal" });
  assert.ok(msg.mentions.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("role is sticky and offline work waits", async () => {
  const { hive, dir } = tempHive();
  const first = hive.join({ role: "worker", seniority: "junior", focus: "frontend" });
  assert.throws(
    () => hive.join({ role: "brain", token: first.token }),
    /cannot change/,
  );
  hive.setOffline(first.agent.id);
  const brain = hive.join({ role: "brain" });
  hive.openDm(brain.agent, first.agent.name);
  hive.postMessage(brain.agent, {
    channel: hive.findDm(brain.agent.id, first.agent.id)!.id,
    body: "when you are back, fix the login",
  });
  const back = hive.join({ role: "worker", seniority: "junior", token: first.token });
  const inbox = await hive.wait(back.agent, 500);
  assert.equal(inbox.idle, false);
  const all = [...inbox.control, ...inbox.mentions, ...inbox.messages];
  assert.ok(all.some((m) => /login/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("stale token plus resume name remints that identity", () => {
  const { hive, dir } = tempHive();
  const first = hive.join({ role: "brain" });
  const again = hive.join({ role: "brain", token: "dead-token", resumeName: first.agent.name });
  assert.equal(again.agent.id, first.agent.id);
  assert.notEqual(again.token, first.token);
  rmSync(dir, { recursive: true, force: true });
});

test("resume name cannot use another agent's token", () => {
  const { hive, dir } = tempHive();
  const a = hive.join({ role: "brain" });
  const b = hive.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.join({ role: "worker", seniority: "mid", token: a.token, resumeName: b.agent.name }),
    /not /,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("two joins without a token create two employees", () => {
  const { hive, dir } = tempHive();
  const a = hive.join({ role: "brain" });
  const b = hive.join({ role: "worker", seniority: "mid" });
  assert.notEqual(a.agent.id, b.agent.id);
  assert.notEqual(a.agent.name, b.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

test("public chatter does not wake a waiting worker", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  const sleeping = hive.wait(worker.agent, 400);
  await new Promise((r) => setTimeout(r, 40));
  hive.postMessage(brain.agent, { channel: "general", body: "noise one" });
  hive.postMessage(brain.agent, { channel: "general", body: "noise two" });
  const started = Date.now();
  const result = await sleeping;
  assert.equal(result.idle, true);
  assert.ok(Date.now() - started >= 300);
  rmSync(dir, { recursive: true, force: true });
});

test("restart does not add Human to brain-worker DMs", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  assert.ok(!dm.memberIds.includes("human"));
  const again = new Hive(path.join(dir, "hive.db"));
  assert.ok(!again.getChannel(dm.id).memberIds.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("wait wakes workers only for addressed mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  hive.postMessage(brain.agent, { channel: "general", body: "status update, no mention" });
  const idle = await hive.wait(worker.agent, 400);
  assert.equal(idle.idle, true);
  hive.postMessage(brain.agent, { channel: "general", body: `please take this @${worker.agent.name}` });
  const hit = await hive.wait(worker.agent, 400);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(worker.agent.name)));
  rmSync(dir, { recursive: true, force: true });
});

test("brains do not wake on #general unless mentioned", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  hive.postMessage(worker.agent, { channel: "general", body: "status only" });
  const idle = await hive.wait(brain.agent, 300);
  assert.equal(idle.idle, true);
  hive.postMessage(worker.agent, { channel: "general", body: `need a call @${brain.agent.name}` });
  const hit = await hive.wait(brain.agent, 300);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(brain.agent.name)));
  const other = hive.join({ role: "brain" });
  hive.postMessage(brain.agent, { channel: "brains", body: "coord ping" });
  const brainsMail = await hive.wait(other.agent, 300);
  assert.equal(brainsMail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("last wait wins and the old one is superseded", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const first = hive.wait(worker.agent, 8_000);
  await new Promise((r) => setTimeout(r, 30));
  const second = hive.wait(worker.agent, 8_000);
  await assert.rejects(first, /superseded/);
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "only the new waiter" });
  const got = await second;
  assert.equal(got.idle, false);
  assert.ok(got.messages.some((m) => /only the new waiter/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("brain compact wait keeps full bodies on one conversation", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const task =
    "implement deadline_ms on the settings page and wire validation for all form fields including edge cases around timezone offsets";
  hive.postMessage(worker.agent, { channel: dm.id, body: "first update with enough text" });
  hive.postMessage(worker.agent, { channel: dm.id, body: task });
  const compact = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(compact.mail?.length, 2);
  assert.ok(compact.mail?.every((m) => (m.body ?? "").length > 0));
  assert.ok(compact.mail?.some((m) => m.body === task));
  assert.ok(!("createdAt" in compact.you));
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait: worker gets body, brain digest on many DMs, cursor keeps the rest", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const workers = [0, 1, 2].map(() => hive.join({ role: "worker", seniority: "mid" }));
  for (const w of workers) {
    const dm = hive.openDm(brain.agent, w.agent.name);
    hive.postMessage(w.agent, { channel: dm.id, body: `report from ${w.agent.name} with enough text`, eventType: "progress" });
  }
  const compact = await hive.wait(brain.agent, 300, undefined, { compact: true });
  assert.equal(compact.idle, false);
  assert.match(compact.next, /wait again/);
  assert.equal(compact.messages.length, 0);
  assert.ok((compact.mail?.length ?? 0) >= 1);
  assert.ok(compact.mail?.every((m) => m.excerpt && m.expand));

  const worker = workers[0]!;
  const dm = hive.findDm(brain.agent.id, worker.agent.id)!;
  hive.postMessage(brain.agent, { channel: dm.id, body: "implement the settings page please" });
  const wmail = await hive.wait(worker.agent, 300, undefined, { compact: true });
  assert.ok(wmail.mail?.some((m) => /settings page/.test(m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait caps conversations not a single flooded DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const flooded = hive.join({ role: "worker", seniority: "mid" });
  const other = hive.join({ role: "worker", seniority: "mid" });
  const floodDm = hive.openDm(brain.agent, flooded.agent.name);
  const otherDm = hive.openDm(brain.agent, other.agent.name);
  let root: string | undefined;
  for (let i = 0; i < 8; i += 1) {
    const message = hive.postMessage(flooded.agent, { channel: floodDm.id, body: `flood ${i}`, threadId: root, eventType: "progress" });
    root ??= message.id;
  }
  hive.postMessage(other.agent, { channel: otherDm.id, body: "second conversation", eventType: "progress" });
  const first = await hive.wait(brain.agent, 500, undefined, { compact: true });
  assert.equal(first.mail?.length, 2);
  assert.equal(first.mail?.find(m => m.rootId === root)?.count, 8);
  assert.ok(first.mail?.some((m) => /second conversation/.test(m.excerpt ?? m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("inbox cursor does not skip capped mail", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const workers = Array.from({ length: 10 }, () => hive.join({ role: "worker", seniority: "junior" }));
  for (const w of workers) {
    const dm = hive.openDm(brain.agent, w.agent.name);
    hive.postMessage(w.agent, { channel: dm.id, body: `ping ${w.agent.name}` });
  }
  const first = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(first.idle, false);
  assert.ok((first.more ?? 0) > 0);
  hive.acknowledgeInbox(brain.agent, first.delivery!.sessionId, first.delivery!.id);
  const second = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(second.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait skips a pile of #general and still gets the DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  for (let i = 0; i < 250; i += 1) {
    hive.postMessage(worker.agent, { channel: "general", body: `noise ${i}` });
  }
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(worker.agent, { channel: dm.id, body: "the real task" });
  const mail = await hive.wait(brain.agent, 400);
  assert.equal(mail.idle, false);
  assert.ok(mail.messages.some((m) => /real task/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("sweep keeps waiters online and drops stale agents", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const sleeping = hive.wait(worker.agent, 4_000);
  await new Promise((r) => setTimeout(r, 20));
  hive.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(Date.now() - 60_000, worker.agent.id);
  hive.sweepPresence(1_000);
  assert.equal(hive.getAgent(worker.agent.id).online, true);
  const idle = hive.join({ role: "worker", seniority: "junior" });
  hive.db.prepare("UPDATE agents SET last_seen_at = ?, online = 1 WHERE id = ?").run(
    Date.now() - 60_000,
    idle.agent.id,
  );
  hive.sweepPresence(1_000);
  assert.equal(hive.getAgent(idle.agent.id).online, false);
  hive.postMessage(hive.getAgent("human"), { channel: "general", body: `x @${worker.agent.name}` });
  const mail = await sleeping;
  assert.equal(mail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("attachments and reactions stay on the message", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const file = await hive.createFileFromBytes(human, {
    name: "note.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("hello file"),
  });
  const msg = hive.postMessage(human, { channel: "general", body: "", attachmentIds: [file.id] });
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]?.name, "note.txt");
  const reacted = hive.toggleReaction(brain.agent, msg.seq, "👍");
  assert.equal(reacted.added, true);
  assert.ok(reacted.message.reactions?.some((r) => r.emoji === "👍"));
  const worker = hive.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "brains", body: "x", attachmentIds: [] }),
    /cannot post/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("body longer than 4k is rejected", () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  assert.throws(
    () => hive.postMessage(brain.agent, { channel: "general", body: "x".repeat(4001) }),
    /too long/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait control includes the full body", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" });
  hive.clearContext(human, worker.agent.name);
  const mail = await hive.wait(worker.agent, 300, undefined, { compact: true });
  const control = mail.control[0] as { action?: string; body?: string };
  assert.equal(control.action, "clear_context");
  assert.ok(control.body && control.body.length > 20);
  rmSync(dir, { recursive: true, force: true });
});

test("queued counts pending isFor mail and drops after wait", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "do the settings" });
  assert.equal(hive.queuedCounts()[worker.agent.id], 1);
  assert.equal(hive.queuedCounts()[brain.agent.id] ?? 0, 0);
  await hive.wait(worker.agent, 200);
  assert.equal(hive.queuedCounts()[worker.agent.id], 0);
  rmSync(dir, { recursive: true, force: true });
});

test("aborted wait keeps the agent online and does not consume mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const ac = new AbortController();
  const pending = hive.wait(worker.agent, 8_000, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  const aborted = await pending;
  assert.equal(aborted.idle, true);
  assert.equal(hive.getAgent(worker.agent.id).online, true);
  hive.postMessage(brain.agent, { channel: dm.id, body: "do not lose this" });
  const mail = await hive.wait(worker.agent, 200);
  assert.equal(mail.idle, false);
  assert.ok([...mail.messages, ...mail.mentions].some((m) => /do not lose this/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("For you hides mentions after the channel is read", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const msg = hive.postMessage(brain.agent, { channel: "general", body: "need a goal @Human" });
  const open = hive.mentionInbox(human, 30);
  assert.equal(open.messages.length, 1);
  hive.markRead(human, "general", msg.seq);
  const seen = hive.mentionInbox(human, 30);
  assert.equal(seen.messages.length, 0);
  const again = hive.postMessage(brain.agent, { channel: "general", body: "another ask @Human" });
  assert.equal(hive.mentionInbox(human, 30).messages.length, 1);
  hive.markMentionsSeen(human);
  assert.equal(hive.mentionInbox(human, 30).messages.length, 0);
  assert.equal(hive.unreadCounts(human).general ?? 0, 0);
  assert.ok(again.seq > msg.seq);
  rmSync(dir, { recursive: true, force: true });
});

test("hasReaction is true for the acting agent even without decorate actor", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const msg = hive.postMessage(brain.agent, { channel: "brains", body: "ping @Human" });
  hive.toggleReaction(human, msg.seq, "👍");
  const raw = hive.getMessageBySeq(msg.seq);
  assert.equal(raw.reactions?.some((r) => r.emoji === "👍" && r.mine), false);
  assert.equal(hive.hasReaction(human.id, msg.id, "👍"), true);
  hive.toggleReaction(human, msg.seq, "👍");
  assert.equal(hive.hasReaction(human.id, msg.id, "👍"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("Human can see brain-worker DMs and invite to private rooms", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "secret assignment" });
  const humanChannels = hive.listChannels(human).map((c) => c.id);
  assert.ok(humanChannels.includes(dm.id));
  const privateCh = hive.createChannel(brain.agent, { name: "login", type: "private" });
  hive.invite(brain.agent, privateCh.id, [worker.agent.name]);
  const room = hive.getChannel(privateCh.id);
  assert.ok(room.memberIds.includes(worker.agent.id));
  rmSync(dir, { recursive: true, force: true });
});

test("search stays in one project and only rooms the actor can see", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const chapter = hive.listProjects()[0]!;
  const solace = hive.join({ role: "brain" });
  const dowel = hive.join({ role: "worker", seniority: "senior" });
  hive.createProject(human, { name: "Altro", slug: "altro" });
  const atlas = hive.join({ role: "brain", project: "altro" });
  const rivet = hive.join({ role: "worker", seniority: "mid", project: "altro" });
  const secret = hive.createChannel(solace.agent, { name: "secret", type: "private", memberNames: [] });
  hive.postMessage(solace.agent, { channel: "general", body: "oauth login on feat/login" });
  hive.postMessage(solace.agent, { channel: "brains", body: "brain-only oauth note @Human" });
  hive.postMessage(solace.agent, { channel: secret.id, body: "private oauth stash" });
  const dm = hive.openDm(solace.agent, dowel.agent.name);
  hive.postMessage(solace.agent, { channel: dm.id, body: "worker may see this oauth dm" });
  const file = await hive.createFileFromBytes(human, {
    name: "oauth-plan.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("plan"),
  });
  const attached = hive.postMessage(human, { channel: "general", body: "file follows", attachmentIds: [file.id] });
  hive.toggleReaction(solace.agent, attached.seq, "✅");
  hive.postMessage(atlas.agent, { channel: "general", body: "altro oauth must not leak" });

  const humanHits = hive.searchMessages(human, { q: "oauth", project: "chapter" });
  assert.ok(humanHits.hits.some((h) => /feat\/login/.test(h.body)));
  assert.ok(humanHits.hits.some((h) => h.channelName === "brains"));
  assert.ok(humanHits.hits.some((h) => h.channelName === "secret"));
  assert.equal(humanHits.hits.some((h) => /must not leak/.test(h.body)), false);

  const brainHits = hive.searchMessages(solace.agent, { q: "oauth" });
  assert.ok(brainHits.hits.some((h) => h.channelName === "brains"));
  assert.equal(brainHits.hits.some((h) => /must not leak/.test(h.body)), false);
  assert.throws(() => hive.searchMessages(solace.agent, { q: "oauth", project: "altro" }), /other projects/);

  const workerHits = hive.searchMessages(dowel.agent, { q: "oauth" });
  assert.ok(workerHits.hits.some((h) => /feat\/login/.test(h.body)));
  assert.ok(workerHits.hits.some((h) => /oauth dm/.test(h.body)));
  assert.equal(workerHits.hits.some((h) => h.channelName === "brains"), false);
  assert.equal(workerHits.hits.some((h) => h.channelName === "secret"), false);
  assert.throws(() => hive.searchMessages(dowel.agent, { q: "oauth", channel: "brains" }), /Cannot search/);

  const fileHits = hive.searchMessages(dowel.agent, { q: "oauth-plan.txt" });
  assert.ok(fileHits.hits.some((h) => h.seq === attached.seq));
  const reactHits = hive.searchMessages(human, { q: "✅", project: "chapter" });
  assert.ok(reactHits.hits.some((h) => h.seq === attached.seq));
  const mentionHits = hive.searchMessages(solace.agent, { q: "Human" });
  assert.ok(mentionHits.hits.some((h) => h.channelName === "brains"));
  const seqHits = hive.searchMessages(human, { q: String(attached.seq), project: "chapter" });
  assert.ok(seqHits.hits.some((h) => h.seq === attached.seq));
  let lonely = hive.postMessage(human, { channel: "general", body: "no digits in this line" });
  while (lonely.seq < 10) {
    lonely = hive.postMessage(human, { channel: "general", body: "no digits in this line" });
  }
  const digit = String(lonely.seq)[0]!;
  assert.equal(
    hive.searchMessages(human, { q: digit, project: "chapter" }).hits.some((h) => h.seq === lonely.seq),
    false,
  );
  const quoted = hive.searchMessages(human, { q: `"feat/login`, project: "chapter" });
  assert.ok(quoted.hits.some((h) => /feat\/login/.test(h.body)));
  const paged = hive.searchMessages(human, { q: "oauth", project: "chapter", limit: 1 });
  assert.equal(paged.hits.length, 1);
  assert.equal(paged.hasMore, true);
  const next = hive.searchMessages(human, {
    q: "oauth",
    project: "chapter",
    limit: 20,
    beforeSeq: paged.hits[0]!.seq,
  });
  assert.ok(next.hits.every((h) => h.seq < paged.hits[0]!.seq));
  const fromStart = hive.searchMessages(human, { q: "oauth", project: "chapter", beforeSeq: 0 });
  assert.equal(fromStart.hits.length, hive.searchMessages(human, { q: "oauth", project: "chapter" }).hits.length);
  assert.throws(() => hive.searchMessages(human, { q: "oauth" }), /Project required/);
  assert.equal(hive.searchMessages(rivet.agent, { q: "oauth" }).hits.some((h) => /feat\/login/.test(h.body)), false);
  rmSync(dir, { recursive: true, force: true });
});

test("projects are isolated: roster, DM, mentions, wait, join cwd", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const chapter = hive.listProjects()[0]!;
  assert.equal(chapter.slug, "chapter");
  hive.updateProject(human, "chapter", { worktree: dir });
  const solace = hive.join({ role: "brain" });
  const dowel = hive.join({ role: "worker", seniority: "senior" });
  const other = hive.createProject(human, { name: "Altro", slug: "altro", worktree: path.join(dir, "altro") });
  const atlas = hive.join({ role: "brain", project: "altro" });
  const rivet = hive.join({ role: "worker", seniority: "mid", cwd: path.join(dir, "altro") });
  assert.equal(atlas.agent.project, "altro");
  assert.equal(rivet.agent.project, "altro");
  assert.throws(() => hive.createProject(atlas.agent, { name: "Nope", slug: "nope" }), /Only Human/);
  assert.deepEqual(
    hive.listAgents(atlas.agent).filter((a) => a.role !== "human").map((a) => a.name).sort(),
    [atlas.agent.name, rivet.agent.name].sort(),
  );
  assert.ok(!hive.listChannels(atlas.agent).some((c) => c.id === "general" || c.project === "chapter"));
  assert.notEqual(hive.getChannel("general", atlas.agent.projectId).id, "general");
  assert.throws(() => hive.openDm(atlas.agent, dowel.agent.name), /not in your project/);
  assert.throws(() => hive.join({ role: "worker", seniority: "junior", cwd: path.join(dir, "unknown") }), /Pass project=slug/);
  assert.throws(
    () => hive.join({ role: "brain", resumeName: solace.agent.name, project: "altro" }),
    /project cannot change/,
  );
  const back = hive.join({ role: "brain", resumeName: solace.agent.name });
  assert.equal(back.agent.project, "chapter");
  hive.postMessage(atlas.agent, { channel: "general", body: `take this @${rivet.agent.name}` });
  const idle = await hive.wait(dowel.agent, 200);
  assert.equal(idle.idle, true);
  const hit = await hive.wait(rivet.agent, 200);
  assert.equal(hit.idle, false);
  const mention = hive.postMessage(atlas.agent, { channel: "general", body: "need a goal @Human" });
  const inbox = hive.mentionInbox(human, 30, undefined, other.id);
  assert.ok(inbox.messages.some((m) => m.id === mention.id));
  const chapterInbox = hive.mentionInbox(human, 30, undefined, chapter.id);
  assert.ok(!chapterInbox.messages.some((m) => m.id === mention.id));
  rmSync(dir, { recursive: true, force: true });
});

test("Human can delete an idle project but not one with online or waiting agents", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  hive.createProject(human, { name: "Altro", slug: "altro" });
  const brain = hive.join({ role: "brain", project: "altro" });
  hive.postMessage(brain.agent, { channel: "general", body: "keep this until delete" });
  assert.throws(() => hive.deleteProject(brain.agent, "altro"), /Only Human/);
  assert.throws(() => hive.deleteProject(human, "altro"), /still online or waiting/);
  const ac = new AbortController();
  const pending = hive.wait(brain.agent, 8_000, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  assert.throws(() => hive.deleteProject(human, "altro"), new RegExp(brain.agent.name));
  ac.abort();
  await pending;
  hive.setOffline(brain.agent.id);
  hive.db.prepare(
    "INSERT INTO telegram_hold (telegram_chat_id, telegram_message_id, telegram_thread_id, payload) VALUES (?, ?, ?, ?)",
  ).run(-1003, 7, 2, "{}");
  hive.db.prepare("INSERT INTO telegram_state (key, value) VALUES (?, ?)").run("mute:-1003", "1");
  hive.db.prepare("INSERT INTO telegram_state (key, value) VALUES (?, ?)").run("offset", "9");
  const chapterGeneral = hive.getChannel("general", hive.getProjectBySlug("chapter").id);
  hive.postMessage(human, { channel: chapterGeneral.id, body: "chapter stays" });
  hive.deleteProject(human, "altro", { telegramChatId: -1003 });
  assert.equal(hive.listProjects().some((p) => p.slug === "altro"), false);
  assert.equal(hive.getAgentByName(brain.agent.name), null);
  assert.equal(hive.listProjects()[0]?.slug, "chapter");
  assert.ok(hive.getChannel("general", hive.listProjects()[0]!.id));
  assert.equal(
    (hive.db.prepare("SELECT COUNT(*) AS n FROM telegram_hold WHERE telegram_chat_id = -1003").get() as { n: number }).n,
    0,
  );
  assert.equal(hive.db.prepare("SELECT value FROM telegram_state WHERE key = 'mute:-1003'").get(), undefined);
  assert.equal((hive.db.prepare("SELECT value FROM telegram_state WHERE key = 'offset'").get() as { value: string }).value, "9");
  assert.ok(hive.listMessages(human, chapterGeneral.id).messages.some((m) => /chapter stays/.test(m.body)));
  assert.equal(hive.findProjectBySlug("altro"), null);
  assert.equal(hive.findProjectBySlug("!!!"), null);
  assert.equal(hive.findProjectBySlug("chapter")?.slug, "chapter");
  hive.deleteProject(human, "chapter");
  assert.equal(hive.listProjects().length, 0);
  const again = hive.createProject(human, { name: "Nuovo", slug: "nuovo" });
  assert.equal(again.slug, "nuovo");
  rmSync(dir, { recursive: true, force: true });
});
