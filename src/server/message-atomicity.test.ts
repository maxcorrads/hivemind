import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import type { Message } from "../shared/types.ts";

function dbState(hive: Hive) {
  return {
    messages: hive.db.prepare(
      "SELECT id, seq, channel_id, thread_id, author_id, body, kind, control, mentions, created_at FROM messages ORDER BY seq",
    ).all(),
    threads: hive.db.prepare("SELECT id, channel_id, status FROM threads ORDER BY id").all(),
    attachments: hive.db.prepare(
      "SELECT id, message_id, created_by, name, mime, bytes, sha256 FROM attachments ORDER BY id",
    ).all(),
    memberships: hive.db.prepare(
      "SELECT channel_id, agent_id FROM channel_members ORDER BY channel_id, agent_id",
    ).all(),
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
    { name: "missing attachment first", ids: ["missing-fixture", reusable.id], pattern: /Attachment not found/ },
    { name: "missing attachment after valid", ids: [reusable.id, "missing-fixture"], pattern: /Attachment not found/ },
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
    const reusableRow = hive.db.prepare("SELECT message_id FROM attachments WHERE id = ?").get(reusable.id) as {
      message_id: string | null;
    };
    assert.equal(reusableRow.message_id, null, `${fixture.name}: valid attachment stays reusable`);
    const ghostThread = hive.db.prepare("SELECT 1 AS present FROM threads WHERE id = ?").get(root.id);
    assert.equal(ghostThread, undefined, `${fixture.name}: no ghost thread`);
  }

  messageEvents.length = 0;
  queuedEvents.length = 0;
  let committedWasVisibleInsideEvent = false;
  const verifyCommit = (message: Message) => {
    if (message.body !== "committed send") return;
    const messageRow = hive.db.prepare("SELECT id FROM messages WHERE id = ?").get(message.id);
    const binding = hive.db.prepare("SELECT message_id FROM attachments WHERE id = ?").get(reusable.id) as {
      message_id: string | null;
    };
    committedWasVisibleInsideEvent = Boolean(messageRow) && binding.message_id === message.id;
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
  const binding = hive.db.prepare("SELECT message_id FROM attachments WHERE id = ?").get(reusable.id) as {
    message_id: string | null;
  };
  assert.equal(binding.message_id, sent.id);
  const thread = hive.db.prepare("SELECT id FROM threads WHERE id = ?").get(root.id) as { id: string } | undefined;
  assert.equal(thread?.id, root.id);
});
