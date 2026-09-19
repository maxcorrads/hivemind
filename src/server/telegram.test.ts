import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import {
  TELEGRAM_PENDING_CAP,
  chatIdForProject,
  enqueueTelegramPending,
  loadTelegramConfig,
  maskTelegramToken,
  projectSlugForChat,
  publicTelegramView,
  writeTelegramFile,
  removeTelegramProjectSlug,
  formatOutbound,
  inboundBody,
  inboundPostBody,
  isTelegramPermanentOutError,
  isTelegramTopicRightsError,
  nextTelegramFailure,
  hiveEmojiFromTelegram,
  telegramOutboundReactionPayload,
  reactionIgnoreKey,
  requireTelegramOk,
  shouldDropTelegramJob,
  shouldNotify,
  telegramFileTooLarge,
  telegramGeneralThreadId,
  telegramMessageHasFiles,
  telegramReplyThreadId,
  recordTelegramFailure,
  telegramPartDelivered,
} from "./telegram.ts";
import type { Channel, Message } from "../shared/types.ts";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m",
    seq: 1,
    channelId: "c",
    threadId: null,
    authorId: "b",
    authorName: "Solace",
    authorRole: "brain",
    body: "hello",
    kind: "chat",
    control: null,
    mentions: [],
    createdAt: 0,
    ...over,
  };
}

function ch(over: Partial<Channel> = {}): Channel {
  return {
    id: "c",
    name: "brains",
    type: "brains",
    topic: null,
    createdBy: "human",
    createdAt: 0,
    memberIds: ["human", "b"],
    projectId: "p1",
    project: "chapter",
    ...over,
  };
}

test("telegram notify: brains and @Human and Human DM, not worker DM or general", () => {
  assert.equal(shouldNotify(msg(), ch(), false), true);
  assert.equal(shouldNotify(msg({ mentions: ["human"] }), ch({ type: "public", name: "general" }), false), true);
  assert.equal(
    shouldNotify(msg(), ch({ type: "dm", name: "Solace · Human", memberIds: ["human", "b"] }), false),
    true,
  );
  assert.equal(
    shouldNotify(
      msg({ authorRole: "worker", authorName: "Dowel" }),
      ch({ type: "dm", name: "Dowel · Solace", memberIds: ["b", "w"] }),
      false,
    ),
    false,
  );
  assert.equal(shouldNotify(msg({ mentions: [] }), ch({ type: "public", name: "general" }), false), false);
  assert.equal(shouldNotify(msg(), ch(), true), false);
});

test('Telegram treats explicit Human recipients like mentions without bypassing mute or message-kind checks', () => {
  for (const type of ['public', 'private'] as const) {
    const channel = ch({ type, name: 'work' });
    assert.equal(shouldNotify(msg({ recipientIds: ['human'] }), channel, false), true);
    assert.equal(shouldNotify(msg({ recipientIds: ['human'], mentions: ['human'] }), channel, false), true);
    assert.equal(shouldNotify(msg({ recipientIds: ['human'] }), channel, true), false);
    assert.equal(shouldNotify(msg({ recipientIds: ['human'], kind: 'system' }), channel, false), false);
    assert.equal(shouldNotify(msg({ recipientIds: ['other-agent'], body: 'Quoted Human' }), channel, false), false);
    assert.equal(shouldNotify(msg({ recipientIds: ['human-other'] }), channel, false), false);
  }
});

test("telegram reaction ignore keys match across attachment message ids", () => {
  const emojis = ["👀", "👍"];
  assert.equal(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1001, 11, [...emojis].reverse()));
  assert.notEqual(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1001, 12, emojis));
  assert.notEqual(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1002, 11, emojis));
});

test("telegram outbound pending drops reactions first, then oldest messages", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  for (let seq = 1; seq <= TELEGRAM_PENDING_CAP + 50; seq++) {
    enqueueTelegramPending(hive.db, seq, "message");
  }
  enqueueTelegramPending(hive.db, TELEGRAM_PENDING_CAP + 50, "reaction");
  const rows = hive.db.prepare("SELECT seq, kind FROM telegram_pending ORDER BY seq ASC, kind ASC").all() as Array<{
    seq: number;
    kind: string;
  }>;
  assert.equal(rows.length, TELEGRAM_PENDING_CAP);
  assert.equal(rows[0]?.seq, 51);
  assert.equal(rows[0]?.kind, "message");
  assert.equal(rows.at(-1)?.seq, TELEGRAM_PENDING_CAP + 50);
  assert.equal(rows.at(-1)?.kind, "message");
  rmSync(dir, { recursive: true, force: true });
});

test("telegram outbound reactions map hive-only emoji onto Telegram's allow-list", () => {
  assert.deepEqual(telegramOutboundReactionPayload(["✅"]), [{ type: "emoji", emoji: "💯" }]);
  assert.deepEqual(telegramOutboundReactionPayload(["🚩"]), [{ type: "emoji", emoji: "⚡" }]);
  assert.deepEqual(telegramOutboundReactionPayload(["❓"]), [{ type: "emoji", emoji: "🤔" }]);
  assert.deepEqual(telegramOutboundReactionPayload(["✅", "👍", "👀"]), [{ type: "emoji", emoji: "👍" }]);
  assert.deepEqual(telegramOutboundReactionPayload(["👀"]), [{ type: "emoji", emoji: "👀" }]);
  assert.equal(hiveEmojiFromTelegram("💯"), "✅");
  assert.equal(hiveEmojiFromTelegram("⚡"), "🚩");
  assert.equal(hiveEmojiFromTelegram("🤔"), "❓");
  assert.equal(isTelegramPermanentOutError(new Error("Bad Request: REACTION_INVALID")), true);
  assert.equal(isTelegramPermanentOutError(new Error("Too Many Requests: retry after 2")), false);
});

test("telegram topic permission errors are not treated as a dead job", () => {
  assert.equal(isTelegramTopicRightsError(new Error("telegram topic not ready: bot needs Manage Topics")), true);
  assert.equal(isTelegramTopicRightsError(new Error("Bad Request: not enough rights to create a topic")), true);
  assert.equal(isTelegramTopicRightsError(new Error("telegram topic not ready")), false);
});

test("telegram outbound gives up after repeated failures so the queue can move", () => {
  let state: { key: string; n: number } | null = null;
  for (let i = 0; i < 4; i += 1) {
    state = nextTelegramFailure(state, 9, "message");
    assert.equal(shouldDropTelegramJob(state.n), false);
  }
  state = nextTelegramFailure(state, 9, "message");
  assert.equal(shouldDropTelegramJob(state.n), true);
  state = nextTelegramFailure(state, 10, "message");
  assert.equal(state.n, 1);
  assert.equal(shouldDropTelegramJob(state.n), false);
});

test("telegram inbound rejects oversized files before download", () => {
  assert.equal(telegramFileTooLarge(undefined), false);
  assert.equal(telegramFileTooLarge(100), false);
  assert.equal(telegramFileTooLarge(512 * 1024 * 1024 + 1), true);
  assert.equal(telegramMessageHasFiles({ photo: [{ file_id: "x" }] }), true);
  assert.equal(telegramMessageHasFiles({}), false);
  assert.equal(telegramGeneralThreadId("general"), 1);
  assert.equal(telegramGeneralThreadId("brains"), null);
});

test("telegram outbound does not treat a failed API result as delivered", () => {
  assert.throws(() => requireTelegramOk({ ok: false, description: "bad" }, "sendMessage"), /bad/);
  assert.equal(requireTelegramOk({ ok: true, result: { message_id: 1 } }, "sendMessage").ok, true);
});

test("telegram file save keeps a prior token and never returns it in the public view", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-ui-"));
  const token = "123456:SECRET-telegram-token-ui";
  writeTelegramFile(
    { botToken: token, allowUserIds: [9], projects: { chapter: { groupChatId: -1001 } } },
    dir,
  );
  writeTelegramFile({ allowUserIds: [9, 8], projects: { chapter: { groupChatId: -1002 } } }, dir);
  const cfg = loadTelegramConfig(dir);
  assert.equal(cfg?.botToken, token);
  assert.equal(cfg?.groups.chapter, -1002);
  const view = publicTelegramView(dir, true);
  assert.equal(view.tokenHint, maskTelegramToken(token));
  assert.equal(view.running, true);
  assert.ok(!JSON.stringify(view).includes(token));
  const after = removeTelegramProjectSlug("chapter", dir);
  assert.equal(after?.projects.chapter, undefined);
  assert.equal(after?.botToken, token);
  const gone = publicTelegramView(dir, false);
  assert.equal(gone.projects.chapter, undefined);
  assert.ok(!JSON.stringify(gone).includes(token));
  assert.equal(removeTelegramProjectSlug("missing", dir)?.botToken, token);
  rmSync(dir, { recursive: true, force: true });
});

test("telegram config maps each group chat to a project and ignores unknown chats", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-cfg-"));
  writeFileSync(
    path.join(dir, "telegram.json"),
    JSON.stringify({
      botToken: "tok",
      allowUserIds: [1],
      groupChatId: -1001,
      projects: { altro: { groupChatId: -1002 } },
    }),
  );
  const cfg = loadTelegramConfig(dir);
  assert.ok(cfg);
  assert.equal(chatIdForProject(cfg!, "chapter"), -1001);
  assert.equal(chatIdForProject(cfg!, "altro"), -1002);
  assert.equal(projectSlugForChat(cfg!, -1002), "altro");
  assert.equal(projectSlugForChat(cfg!, -1999), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("telegram text format stays under Telegram and hive caps", () => {
  assert.equal(formatOutbound(msg({ body: "go" })), "Solace\ngo");
  const long = inboundBody("Sara", "x".repeat(5000));
  assert.ok(long.startsWith("[Sara] "));
  assert.ok(long.length <= 4000);
  assert.equal(inboundBody("Sara", ""), "[Sara]");
  assert.equal(inboundPostBody("Sara", "", true), "");
  assert.equal(inboundPostBody("Sara", "go", true), "[Sara] go");
  assert.equal(inboundPostBody("Sara", "", false), "[Sara]");
});


test("telegram queue overflow dead-letters reactions before messages", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-dead-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  enqueueTelegramPending(hive.db, 1, "message", 2);
  enqueueTelegramPending(hive.db, 1, "reaction", 2);
  enqueueTelegramPending(hive.db, 2, "message", 2);
  const pending = hive.db.prepare("SELECT seq, kind FROM telegram_pending ORDER BY seq, kind").all() as Array<{seq:number;kind:string}>;
  assert.deepEqual(pending.map(row => ({ ...row })), [{ seq: 1, kind: "message" }, { seq: 2, kind: "message" }]);
  const failure = hive.telegramFailures(10)[0];
  assert.equal(failure?.seq, 1);
  assert.equal(failure?.kind, "reaction");
  assert.equal(failure?.reason, "queue_overflow");
  rmSync(dir, { recursive: true, force: true });
});

test("telegram delivery checkpoints survive restart and dead letters are retryable without erasing audit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-progress-"));
  const dbPath = path.join(dir, "hive.db");
  const hive = new Hive(dbPath);
  hive.db.prepare(
    `INSERT INTO telegram_delivery_parts
      (seq, part_key, telegram_chat_id, telegram_message_id, completed_at, bot_key)
     VALUES (?, ?, ?, ?, ?, 'fixture-key')`,
  ).run(9, "attachment:a", -1001, 44, Date.now());
  assert.equal(telegramPartDelivered(hive.db, 9, "attachment:a", -1001, "fixture-key"), true);
  recordTelegramFailure(hive.db, 9, "message", "boom", 5, -1001, "fixture-key");
  const failure = hive.telegramFailures(10)[0]!;
  hive.retryTelegramFailure(failure.id, () => ({ botKey: "fixture-key", chatId: -1001 }));
  assert.equal(hive.telegramFailureCount(), 0);
  assert.ok(hive.db.prepare("SELECT 1 FROM telegram_pending WHERE seq = 9 AND kind = 'message'").get());
  assert.equal(
    (hive.db.prepare("SELECT resolution FROM telegram_failures WHERE id = ?").get(failure.id) as { resolution: string }).resolution,
    "retried",
  );
  hive.db.close();

  const reopened = new Hive(dbPath);
  assert.equal(telegramPartDelivered(reopened.db, 9, "attachment:a", -1001, "fixture-key"), true);
  reopened.db.close();
  rmSync(dir, { recursive: true, force: true });
});


test("telegram replies resolve top-level messages and replies to the same Hivemind root", () => {
  const top = msg({ id: "root", channelId: "c", threadId: null });
  assert.equal(telegramReplyThreadId({ channelId: "c", threadId: null }, top, "c"), "root");

  const reply = msg({ id: "reply", channelId: "c", threadId: "root" });
  assert.equal(telegramReplyThreadId({ channelId: "c", threadId: "root" }, reply, "c"), "root");

  assert.equal(telegramReplyThreadId({ channelId: "other", threadId: null }, top, "c"), null);
  assert.equal(
    telegramReplyThreadId({ channelId: "c", threadId: null }, msg({ channelId: "other" }), "c"),
    null,
  );
});
