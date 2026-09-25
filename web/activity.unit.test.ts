import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityItem, ActivityReason } from "../src/shared/read-state.ts";
import type { Message } from "../src/shared/types.ts";
import { filterReasons, mergeActivity, receiveActivity } from "./activity.ts";

const item = (id: string, seq: number, fields: { reason?: ActivityReason; read?: boolean; project?: string } = {}): ActivityItem => ({
  message: { id, seq, channelId: "general", threadId: null } as Message,
  project: fields.project ?? "acme", reason: fields.reason ?? "mention", read: fields.read ?? false,
});
const ids = (items: ActivityItem[]) => items.map(entry => entry.message.id);

test("a realtime entry is added newest first only where the view shows it", () => {
  const loaded = [item("b", 5), item("a", 2)];
  const activity = { project: "acme", unreadOnly: false, reasons: [] };
  assert.deepEqual(ids(receiveActivity(loaded, activity, item("c", 9))), ["c", "b", "a"]);
  assert.deepEqual(ids(receiveActivity(loaded, activity, item("mid", 3))), ["b", "mid", "a"]);
  assert.equal(receiveActivity(loaded, activity, item("b", 5)), loaded, "a duplicate is ignored");
  assert.equal(receiveActivity(loaded, activity, item("x", 9, { project: "other" })), loaded);
  assert.equal(receiveActivity(loaded, { ...activity, unreadOnly: true }, item("x", 9, { read: true })), loaded,
    "Unread never shows a read entry (the Human's own decision answer)");
  assert.deepEqual(ids(receiveActivity(loaded, activity, item("own", 9, { read: true, reason: "decision" }))), ["own", "b", "a"]);
  const review = { ...activity, reasons: filterReasons("review") };
  assert.equal(receiveActivity(loaded, review, item("x", 9, { reason: "direct" })), loaded);
  assert.deepEqual(ids(receiveActivity(loaded, review, item("t", 9, { reason: "task" }))), ["t", "b", "a"]);
});

test("merging the newest page keeps older loaded pages and takes fresher read state", () => {
  const loaded = [item("c", 7), item("b", 5), item("a", 2)];
  const merged = mergeActivity(loaded, [item("d", 9), item("c", 7, { read: true })]);
  assert.deepEqual(ids(merged), ["d", "c", "b", "a"]);
  assert.equal(merged.find(entry => entry.message.id === "c")?.read, true);
  assert.deepEqual(filterReasons("all"), []);
  assert.deepEqual(filterReasons("direct"), ["direct"]);
});
