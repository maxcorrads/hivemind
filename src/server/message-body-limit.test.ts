import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "./hive.ts";
import { createApp } from "./app.ts";
import { BOT_JSON_BYTES } from "./ingress.ts";
import { waitWireBytes } from "./wait-format.ts";
import { markInboxRead } from "./test-fixtures.ts";
import { API_JSON_BYTES, humanSendInputSchema, messageBodySchema, sendInputSchema } from "../shared/api-contract.ts";
import { botMessageSchema } from "../shared/bot-message.ts";
import { BODY_MAX, WAIT_MAX_BYTES, type Message, type WaitResult } from "../shared/types.ts";

// Owner decision: real requests/specs exceed 4,000 characters; everyone gets 20,000.
const ASCII = "a".repeat(BODY_MAX);
const CJK = "界".repeat(BODY_MAX); // 3 UTF-8 bytes per UTF-16 unit: the UTF-8 worst case
const OVER = "a".repeat(BODY_MAX + 1);
/** What an ensure_ascii JSON client sends: every non-ASCII unit as a 6-byte escape (the JSON worst case). */
const asciiEscapedJson = (value: Record<string, unknown>) =>
  JSON.stringify(value).replace(/[^ -~]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-body-limit-"));
  const hive = new Hive(path.join(dir, "hive.db"), { routineBatchMs: 0 });
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const dm = hive.channels.openDm(brain.agent, worker.agent.name);
  return { hive, app: createApp(hive), human, brain, worker, dm };
}

test("the body limit is 20,000 units for every schema and dependent JSON caps fit its worst case", () => {
  assert.equal(BODY_MAX, 20_000);
  for (const schema of [messageBodySchema, sendInputSchema.shape.body, humanSendInputSchema.shape.body]) {
    for (const body of [ASCII, CJK, "😀".repeat(BODY_MAX / 2)]) assert.equal(schema.safeParse(body).success, true);
    assert.equal(schema.safeParse(OVER).success, false);
  }
  assert.equal(botMessageSchema.safeParse({ eventId: "e", body: CJK }).success, true);
  assert.equal(botMessageSchema.safeParse({ eventId: "e", body: OVER }).success, false);
  // Each unit escapes to at most 6 JSON bytes; both ingress caps keep >= 16 KiB for other fields.
  assert.ok(API_JSON_BYTES >= BODY_MAX * 6 + 16 * 1024);
  assert.ok(BOT_JSON_BYTES >= BODY_MAX * 6 + 16 * 1024);
});

test("UI and agent HTTP accept a 20,000-unit body, even fully \\u-escaped, and reject 20,001 identically", async t => {
  const f = fixture(t);
  const post = (route: string, raw: string, token?: string) => f.app.request(route, { method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw });
  const routes = [
    { route: "/api/ui/channels/general/messages", token: undefined },
    { route: `/api/agent/channels/${f.dm.id}/messages`, token: f.brain.token },
  ];
  for (const { route, token } of routes) {
    for (const body of [ASCII, CJK]) {
      const raw = asciiEscapedJson({ body });
      if (body === CJK) assert.ok(Buffer.byteLength(raw) > BODY_MAX * 6, "every unit is escaped");
      const response = await post(route, raw, token);
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
      const json = await response.json() as { id?: string; message?: Message };
      assert.equal(f.hive.messageQueries.getMessageById(json.message?.id ?? json.id!).body, body);
    }
    const rejected = await post(route, JSON.stringify({ body: OVER }), token);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "Invalid request field: body" });
  }
  // Direct service callers (Telegram inbound, internal writers) keep the explicit length error.
  assert.throws(() => f.hive.messages.postMessage(f.human, { channel: "general", body: OVER }),
    /Message too long \(20001 > 20000\)/);
});

test("bot HTTP ingress accepts a worst-case escaped 20,000-unit body and rejects 20,001", async t => {
  const f = fixture(t);
  const channel = f.hive.channels.createChannel(f.human, { name: "observations", type: "private", project: "chapter" });
  const bot = f.hive.bots.createBot(f.human, channel.projectId, { name: "LongBot" });
  f.hive.channels.invite(f.human, channel.id, [bot.bot.name]);
  const post = (raw: string) => f.app.request(`/api/bot/channels/${channel.id}/messages`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bot.token}` }, body: raw });
  const accepted = await post(asciiEscapedJson({ eventId: "long", body: CJK }));
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal(f.hive.messageQueries.getMessageById(((await accepted.json()) as { message: Message }).message.id).body, CJK);
  const rejected = await post(JSON.stringify({ eventId: "too-long", body: OVER }));
  assert.equal(rejected.status, 400);
  assert.equal(typeof ((await rejected.json()) as { error: unknown }).error, "string");
});

test("wait delivers a full 20,000-unit body in both formats within the unchanged byte budget", async t => {
  const f = fixture(t);
  markInboxRead(f.hive, f.worker.agent.id);
  const sessionId = f.hive.delivery.openInboxSession(f.worker.agent, crypto.randomUUID());
  for (const body of [ASCII, CJK]) {
    const sent = f.hive.messages.postMessage(f.brain.agent, { channel: f.dm.id, body, eventType: "action_required" });
    for (const compact of [true, false]) {
      const result: WaitResult = await f.hive.delivery.wait(f.worker.agent, 1, undefined, { sessionId, compact });
      const item = compact ? result.mail![0]! : [...result.messages, ...result.mentions][0]!;
      assert.equal(item.body, body);
      assert.equal(item.recovery, undefined);
      assert.ok(waitWireBytes(result) <= WAIT_MAX_BYTES);
      if (!compact) f.hive.delivery.acknowledgeInbox(f.worker.agent, sessionId, result.delivery!.id);
      else assert.deepEqual(result.delivery!.messageSeqs, [sent.seq]);
    }
  }
});

test("long progress bodies are still digested to an excerpt; the full originals stay available", async t => {
  const f = fixture(t);
  markInboxRead(f.hive, f.brain.agent.id);
  const sessionId = f.hive.delivery.openInboxSession(f.brain.agent, crypto.randomUUID());
  const root = f.hive.messages.postMessage(f.worker.agent, { channel: f.dm.id, body: "Starting the study", eventType: "progress" });
  const bodies = ["first ", "second "].map(prefix => (prefix + "progress detail ".repeat(BODY_MAX)).slice(0, BODY_MAX - 1) + ".");
  const sent = bodies.map(body => f.hive.messages.postMessage(f.worker.agent,
    { channel: f.dm.id, threadId: root.id, body, eventType: "progress" }));
  const result = await f.hive.delivery.wait(f.brain.agent, 1, undefined, { sessionId, compact: true });
  assert.equal(result.mail!.length, 1);
  const digest = result.mail![0]!;
  assert.equal(digest.count, 3);
  assert.equal(digest.body, undefined);
  assert.ok(digest.excerpt!.length <= 80);
  assert.ok(waitWireBytes(result) < 8 * 1024, "a digest wake does not carry the long bodies");
  const expanded = f.hive.messageQueries.expandDigest(f.brain.agent, digest.expand);
  assert.deepEqual(expanded.messages.map(m => m.body), [root.body, ...bodies]);
  const history = f.hive.messageQueries.listMessages(f.brain.agent, f.dm.id, { threadId: root.id });
  assert.deepEqual(history.messages.filter(m => sent.some(s => s.id === m.id)).map(m => m.body), bodies);
  const hits = f.hive.messageQueries.searchMessages(f.brain.agent, { q: "second" });
  assert.ok(hits.hits.some(hit => hit.seq === sent[1]!.seq));
});
