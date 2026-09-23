import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Channel, Message } from "../src/shared/types.ts";
import { loadClosedDms, saveClosedDms } from "./closed-dms.ts";
import { isForYouMail, loadMailLog, mergeMailLog, saveMailLog } from "./mail-log.ts";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  },
});
beforeEach(() => store.clear());

test("closed DMs round-trip unique ids and tolerate corrupt storage", () => {
  assert.deepEqual(loadClosedDms(), []);
  saveClosedDms(["a", "b", "a"]);
  assert.equal(store.get("hivemind-closed-dms"), '["a","b"]');
  assert.deepEqual(loadClosedDms(), ["a", "b"]);
  store.set("hivemind-closed-dms", JSON.stringify(["x", "", 3, null]));
  assert.deepEqual(loadClosedDms(), ["x"]);
  store.set("hivemind-closed-dms", '{"a":1}');
  assert.deepEqual(loadClosedDms(), []);
  store.set("hivemind-closed-dms", "{broken");
  assert.deepEqual(loadClosedDms(), []);
});

const msg = (fields: Partial<Message>) => ({
  id: "m", seq: 1, channelId: "general", authorId: "brain", authorRole: "brain", mentions: [], body: "", ...fields,
}) as Message;
const channels = [
  { id: "general", type: "public", memberIds: ["human", "brain"] },
  { id: "dm-human", type: "dm", memberIds: ["human", "brain"] },
  { id: "dm-workers", type: "dm", memberIds: ["brain", "worker"] },
] as unknown as Channel[];

test("mail log persists at most 400 valid messages and tolerates corrupt storage", () => {
  assert.deepEqual(loadMailLog(), []);
  const many = Array.from({ length: 405 }, (_, i) => msg({ id: `m${i}`, seq: i }));
  saveMailLog(many);
  assert.equal(loadMailLog().length, 400);
  store.set("hivemind-for-you-log", JSON.stringify([msg({ id: "ok" }), { id: 1, seq: 1 }, { id: "x" }, null]));
  assert.deepEqual(loadMailLog().map(m => m.id), ["ok"]);
  store.set("hivemind-for-you-log", '"not an array"');
  assert.deepEqual(loadMailLog(), []);
  store.set("hivemind-for-you-log", "{broken");
  assert.deepEqual(loadMailLog(), []);
});

test("For you mail is Human mentions or brain DMs to Human, never Human's own posts", () => {
  assert.equal(isForYouMail(msg({ authorId: "human", authorRole: "human", mentions: ["human"] }), channels), false);
  assert.equal(isForYouMail(msg({ authorId: "x", authorRole: "human" }), channels), false);
  assert.equal(isForYouMail(msg({ authorRole: "worker", mentions: ["human"] }), channels), true);
  assert.equal(isForYouMail(msg({ authorRole: "worker", channelId: "dm-human" }), channels), false);
  assert.equal(isForYouMail(msg({ mentions: undefined, channelId: "dm-human" }), channels), true);
  assert.equal(isForYouMail(msg({ channelId: "dm-workers" }), channels), false);
  assert.equal(isForYouMail(msg({ channelId: "general" }), channels), false);
  assert.equal(isForYouMail(msg({ channelId: "missing" }), channels), false);
});

test("merging keeps the previous log unless new For you mail arrives, newest first", () => {
  const prev = [msg({ id: "a", seq: 1, mentions: ["human"] })];
  assert.equal(mergeMailLog(prev, [msg({ id: "noise", seq: 5 })], channels), prev);
  assert.equal(mergeMailLog(prev, [prev[0]!], channels), prev);
  const merged = mergeMailLog(prev, [msg({ id: "b", seq: 3, channelId: "dm-human" }), msg({ id: "c", seq: 2, mentions: ["human"] })], channels);
  assert.deepEqual(merged.map(m => m.id), ["b", "c", "a"]);
});
