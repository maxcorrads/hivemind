import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { WAIT_MAIL_CAP, WAIT_MESSAGE_CAP, WAIT_PAYLOAD_MAX_BYTES } from "../shared/types.ts";

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("worker and brain wait batches are independently bounded by count and serialized bytes", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-wait-bounds-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const workerDm = hive.openDm(human, worker.name);
  for (let i = 0; i < 40; i += 1) {
    hive.postMessage(human, { channel: workerDm.id, body: `worker mail ${i}` });
  }

  const workerBatch = await hive.wait(worker, 60_000, undefined, {
    compact: true,
    sessionId: "worker-bounds",
  });
  assert.ok(workerBatch.deliveryId);
  assert.equal(workerBatch.mail?.length, WAIT_MAIL_CAP);
  assert.equal(workerBatch.more, 40 - WAIT_MAIL_CAP);
  assert.ok(serializedBytes(workerBatch) <= WAIT_PAYLOAD_MAX_BYTES);
  hive.ackDelivery(worker, workerBatch.deliveryId!, "worker-bounds");

  const brain = hive.join({ role: "brain", focus: "payload" }).agent;
  const reporter = hive.join({ role: "worker", seniority: "senior", focus: "reporter" }).agent;
  const brainDm = hive.openDm(brain, reporter.name);
  const body = "x".repeat(3_900);
  const expectedSeqs: number[] = [];
  for (let i = 0; i < 180; i += 1) {
    expectedSeqs.push(hive.postMessage(reporter, { channel: brainDm.id, body: `${i}:${body}` }).seq);
  }

  const seen: number[] = [];
  let batchNumber = 0;
  for (;;) {
    batchNumber += 1;
    const batch = await hive.wait(brain, 60_000, undefined, {
      compact: true,
      sessionId: "brain-bounds",
    });
    assert.ok(batch.deliveryId);
    assert.ok((batch.mail?.length ?? 0) <= WAIT_MESSAGE_CAP);
    assert.ok(serializedBytes(batch) <= WAIT_PAYLOAD_MAX_BYTES, `batch ${batchNumber} exceeded byte cap`);
    const batchSeqs = (batch.mail ?? []).map((item) => item.seq);
    seen.push(...batchSeqs);
    const remaining = batch.more ?? 0;
    if (batchNumber === 1) {
      assert.equal(remaining, expectedSeqs.length - batchSeqs.length);
      assert.ok(remaining > 99, "more must remain exact rather than saturating at the historical 99 cap");
    }
    hive.ackDelivery(brain, batch.deliveryId!, "brain-bounds");
    if (remaining === 0) break;
    assert.ok(batchNumber < 30, "bounded batches must make progress through a flooded conversation");
  }
  assert.deepEqual(seen, expectedSeqs);
  assert.equal(new Set(seen).size, expectedSeqs.length);
});

test("brain conversation cap is independent from message and byte caps", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-wait-conversations-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const brain = hive.join({ role: "brain", focus: "fan-in" }).agent;
  const workers = Array.from({ length: 12 }, (_, index) =>
    hive.join({ role: "worker", seniority: "junior", focus: `worker-${index}` }).agent,
  );
  const expected: number[] = [];
  for (const worker of workers) {
    const dm = hive.openDm(brain, worker.name);
    expected.push(hive.postMessage(worker, { channel: dm.id, body: `from ${worker.name}` }).seq);
  }

  const first = await hive.wait(brain, 60_000, undefined, {
    compact: true,
    sessionId: "conversation-cap",
  });
  assert.ok(first.deliveryId);
  assert.equal(new Set((first.mail ?? []).map((item) => item.ch)).size, WAIT_MAIL_CAP);
  assert.equal(first.more, expected.length - WAIT_MAIL_CAP);
  assert.ok(serializedBytes(first) <= WAIT_PAYLOAD_MAX_BYTES);
  hive.ackDelivery(brain, first.deliveryId!, "conversation-cap");

  const second = await hive.wait(brain, 60_000, undefined, {
    compact: true,
    sessionId: "conversation-cap",
  });
  assert.ok(second.deliveryId);
  assert.equal(second.more, 0);
  assert.equal((second.mail ?? []).length, expected.length - WAIT_MAIL_CAP);
  hive.ackDelivery(brain, second.deliveryId!, "conversation-cap");
});

test("a flooded conversation cannot starve later mail and attachment metadata never contains file bytes", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-wait-starvation-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => {
    hive.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const brain = hive.join({ role: "brain", focus: "starvation" }).agent;
  const flooder = hive.join({ role: "worker", seniority: "mid" }).agent;
  const later = hive.join({ role: "worker", seniority: "mid" }).agent;
  const floodDm = hive.openDm(brain, flooder.name);
  const laterDm = hive.openDm(brain, later.name);

  for (let i = 0; i < 100; i += 1) {
    hive.postMessage(flooder, { channel: floodDm.id, body: `flood ${i}` });
  }
  const sentinel = "SYNTHETIC_FILE_BODY_SHOULD_NEVER_ENTER_WAIT_" + "z".repeat(256);
  const attachment = await hive.createFileFromBytes(later, {
    name: "fixture.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode(sentinel),
  });
  const laterMessage = hive.postMessage(later, {
    channel: laterDm.id,
    body: "later conversation",
    attachmentIds: [attachment.id],
  });

  let foundLater = false;
  for (let batchNumber = 1; batchNumber <= 10; batchNumber += 1) {
    const batch = await hive.wait(brain, 60_000, undefined, {
      compact: true,
      sessionId: "starvation",
    });
    assert.ok(batch.deliveryId);
    const serialized = JSON.stringify(batch);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= WAIT_PAYLOAD_MAX_BYTES);
    assert.equal(serialized.includes(sentinel), false);
    const item = (batch.mail ?? []).find((mail) => mail.seq === laterMessage.seq);
    if (item) {
      foundLater = true;
      assert.equal(item.attachments?.[0]?.id, attachment.id);
      assert.equal("body" in (item.attachments?.[0] ?? {}), false);
    }
    const more = batch.more ?? 0;
    hive.ackDelivery(brain, batch.deliveryId!, "starvation");
    if (foundLater || more === 0) break;
  }
  assert.equal(foundLater, true, "later conversation must eventually become deliverable");
});
