import assert from "node:assert/strict";
import { test } from "node:test";
import { WAIT_NEXT, type WaitResult } from "../shared/types.ts";
import { WAIT_NEXT_REPEAT } from "./tool-text.ts";
import { createWaitView } from "./wait-view.ts";

const you = { name: "Forge", role: "worker", seniority: "senior", focus: "frontend", online: true, project: "acme" } as const;
const mail = (seq: number, extra: Partial<WaitResult> = {}): WaitResult => ({
  idle: false, next: WAIT_NEXT, you: { ...you }, control: [], mentions: [], messages: [],
  mail: [{ messageId: `m${seq}`, rootId: `m${seq}`, seq, channelId: "c", ch: "#general", from: "Atlas", authorRole: "brain",
    kind: "chat", body: "hi", attachmentCount: 0 }],
  delivery: { id: `d${seq}`, sessionId: "s", messageSeqs: [seq], attempt: 1, offeredAt: 1, leaseExpiresAt: 2, redelivered: false },
  ...extra,
});

test("the first wake carries you and the full next; later wakes a short reminder and no you", () => {
  const view = createWaitView();
  const first = view(mail(1));
  assert.equal(first.next, WAIT_NEXT);
  assert.deepEqual(first.you, you);
  const second = view(mail(2));
  assert.equal(second.next, WAIT_NEXT_REPEAT);
  assert.equal("you" in second, false);
  assert.deepEqual(second.mail, mail(2).mail);
  assert.deepEqual(second.delivery, mail(2).delivery);
});

test("you comes back whenever it changes", () => {
  const view = createWaitView();
  view(mail(1));
  const changed = view(mail(2, { you: { ...you, focus: "review" } }));
  assert.equal((changed.you as typeof you).focus, "review");
  assert.equal("you" in view(mail(3, { you: { ...you, focus: "review" } })), false);
});

test("a new view (a new session) starts over", () => {
  const view = createWaitView();
  view(mail(1));
  const fresh = createWaitView()(mail(2));
  assert.equal(fresh.next, WAIT_NEXT);
  assert.deepEqual(fresh.you, you);
});

test("empty legacy arrays are dropped; non-empty ones stay", () => {
  const view = createWaitView();
  const empty = view(mail(1));
  for (const key of ["control", "mentions", "messages"]) assert.equal(key in empty, false);
  const control = [{ messageId: "x", rootId: "x", channelId: "c", seq: 9, from: "Atlas", action: "clear_context" as const, body: "clear" }];
  assert.deepEqual(view(mail(2, { control })).control, control);
});

test("the reminder keeps the loop: acknowledge, reply, wait again", () => {
  assert.match(WAIT_NEXT_REPEAT, /ack_delivery/);
  assert.match(WAIT_NEXT_REPEAT, /wait again/);
  assert.ok(WAIT_NEXT_REPEAT.length < WAIT_NEXT.length);
});
