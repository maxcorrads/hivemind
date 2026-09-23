import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { failWrites, hasRow, listRows, readValue } from "./test-fixtures.ts";
import type { Message } from "../shared/types.ts";

const attachmentMessage = (hive: Hive, id: string) => readValue(hive, "attachments", "message_id", { id });

function dbState(hive: Hive) {
  return {
    messages: listRows(hive, "messages", {
      columns: ["id", "seq", "channel_id", "thread_id", "author_id", "body", "kind", "control", "mentions", "created_at"],
      orderBy: "seq",
    }),
    threads: listRows(hive, "threads", { columns: ["id", "channel_id", "status"], orderBy: "id" }),
    attachments: listRows(hive, "attachments", {
      columns: ["id", "message_id", "created_by", "name", "mime", "bytes", "sha256"],
      orderBy: "id",
    }),
    memberships: listRows(hive, "channel_members", { columns: ["channel_id", "agent_id"], orderBy: ["channel_id", "agent_id"] }),
  };
}

test("failed attachment sends are atomic and emit no recipient-visible side effects", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-atomic-send-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const dm = hive.openDm(human, worker.name);
  const root = hive.postMessage(human, { channel: dm.id, body: "thread root" });

  const reusable = await hive.createFileFromBytes(human, {
    name: "reusable.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("reusable"),
  });
  const foreign = await hive.createFileFromBytes(worker, {
    name: "foreign.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("foreign"),
  });
  const bound = await hive.createFileFromBytes(human, {
    name: "bound.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("bound"),
  });
  hive.postMessage(human, { channel: dm.id, body: "bind once", attachmentIds: [bound.id] });

  const messageEvents: Message[] = [];
  const queuedEvents: unknown[] = [];
  hive.bus.on("message", (message: Message) => messageEvents.push(message));
  hive.bus.on("queued", (event) => queuedEvents.push(event));

  const rejected = [
    { name: "missing attachment first", ids: ["00000000-0000-4000-8000-000000000001", reusable.id], pattern: /Attachment not found/ },
    { name: "missing attachment after valid", ids: [reusable.id, "00000000-0000-4000-8000-000000000001"], pattern: /Attachment not found/ },
    { name: "foreign-owned attachment", ids: [foreign.id], pattern: /not yours/ },
    { name: "already-bound attachment", ids: [bound.id], pattern: /already sent/ },
    { name: "duplicate attachment id", ids: [reusable.id, reusable.id], pattern: /Duplicate attachment/ },
  ] as const;

  for (const fixture of rejected) {
    messageEvents.length = 0;
    queuedEvents.length = 0;
    const before = dbState(hive);

    assert.throws(
      () =>
        hive.postMessage(human, {
          channel: dm.id,
          threadId: root.id,
          body: fixture.name,
          attachmentIds: [...fixture.ids],
        }),
      fixture.pattern,
    );

    assert.deepEqual(dbState(hive), before, fixture.name);
    assert.equal(messageEvents.length, 0, `${fixture.name}: no message event`);
    assert.equal(queuedEvents.length, 0, `${fixture.name}: no recipient wake/queued event`);
    assert.equal(attachmentMessage(hive, reusable.id), null, `${fixture.name}: valid attachment stays reusable`);
    assert.equal(hasRow(hive, "threads", { id: root.id }), false, `${fixture.name}: no ghost thread`);
  }

  messageEvents.length = 0;
  queuedEvents.length = 0;
  let committedWasVisibleInsideEvent = false;
  const verifyCommit = (message: Message) => {
    if (message.body !== "committed send") return;
    committedWasVisibleInsideEvent = hasRow(hive, "messages", { id: message.id }) && attachmentMessage(hive, reusable.id) === message.id;
  };
  hive.bus.on("message", verifyCommit);

  const sent = hive.postMessage(human, {
    channel: dm.id,
    threadId: root.id,
    body: "committed send",
    attachmentIds: [reusable.id],
  });

  hive.bus.off("message", verifyCommit);
  assert.equal(messageEvents.filter((message) => message.id === sent.id).length, 1);
  assert.equal(committedWasVisibleInsideEvent, true, "message event fires only after committed DB state is visible");
  assert.equal(queuedEvents.length, 1, "successful DM wakes the sole recipient exactly once");
  assert.equal(attachmentMessage(hive, reusable.id), sent.id);
  assert.ok(hasRow(hive, "threads", { id: root.id }));
});


test("mid-transaction attachment failure rolls back message, thread, and earlier binding", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-atomic-fault-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const dm = hive.openDm(human, worker.name);
  const root = hive.postMessage(human, { channel: dm.id, body: "thread root" });
  const first = await hive.createFileFromBytes(human, {
    name: "first.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("first"),
  });
  const second = await hive.createFileFromBytes(human, {
    name: "second.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("second"),
  });

  // Both attachments pass normal validation. The trigger fails only when the
  // second binding update executes, after the message insert and first binding.
  // This exercises SQLite rollback rather than an early validation return.
  failWrites(hive, "attachments", {
    on: "update",
    when: `OLD.id = '${second.id}' AND NEW.message_id IS NOT NULL`,
    message: "fixture bind failure",
    persistent: true,
  });

  const messageEvents: Message[] = [];
  const queuedEvents: unknown[] = [];
  hive.bus.on("message", (message: Message) => messageEvents.push(message));
  hive.bus.on("queued", (event) => queuedEvents.push(event));
  const before = dbState(hive);

  assert.throws(
    () =>
      hive.postMessage(human, {
        channel: dm.id,
        threadId: root.id,
        body: "must roll back",
        attachmentIds: [first.id, second.id],
      }),
    /fixture bind failure/,
  );

  assert.deepEqual(dbState(hive), before);
  assert.equal(messageEvents.length, 0);
  assert.equal(queuedEvents.length, 0);
  assert.equal(attachmentMessage(hive, first.id), null);
  assert.equal(attachmentMessage(hive, second.id), null);
  assert.equal(hasRow(hive, "threads", { id: root.id }), false);
});
