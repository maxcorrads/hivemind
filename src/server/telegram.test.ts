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

test("telegram reaction ignore keys match across attachment message ids", () => {
  const emojis = ["👀", "👍"];
  assert.equal(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1001, 11, [...emojis].reverse()));
  assert.notEqual(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1001, 12, emojis));
  assert.notEqual(reactionIgnoreKey(-1001, 11, emojis), reactionIgnoreKey(-1002, 11, emojis));
});

test("telegram outbound pending drops oldest when the hive bursts", () => {
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
  assert.equal(rows[0]?.seq, 52);
  assert.equal(rows[0]?.kind, "message");
  assert.equal(rows.at(-1)?.seq, TELEGRAM_PENDING_CAP + 50);
  assert.equal(rows.at(-1)?.kind, "reaction");
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


test("telegram config rejects duplicate project chat ids without replacing the previous file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tg-unique-"));
  writeTelegramFile(
    { botToken: "tok", allowUserIds: [1], projects: { chapter: { groupChatId: -1001 } } },
    dir,
  );
  assert.throws(
    () =>
      writeTelegramFile(
        {
          botToken: "tok",
          allowUserIds: [1],
          projects: {
            chapter: { groupChatId: -1002 },
            altro: { groupChatId: -1002 },
          },
        },
        dir,
      ),
    /already assigned/,
  );
  assert.equal(loadTelegramConfig(dir)?.groups.chapter, -1001);
  rmSync(dir, { recursive: true, force: true });
});
