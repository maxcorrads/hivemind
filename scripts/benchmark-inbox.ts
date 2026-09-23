// Reproducible, isolated load probe. No model, provider, existing hive or identity.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getRequestListener } from "@hono/node-server";
import { Hive } from "../src/server/hive.ts";
import { createApp } from "../src/server/app.ts";
import { waitWireBytes } from "../src/server/wait-format.ts";
import { WAIT_MAX_BYTES, WAIT_SCAN_MAX, type WaitResult } from "../src/shared/types.ts";

const agentCount = Number(process.argv[2] ?? 4);
const messagesPerAgent = Number(process.argv[3] ?? 1200);
assert.ok(Number.isInteger(agentCount) && agentCount >= 1 && agentCount <= 32);
assert.ok(Number.isInteger(messagesPerAgent) && messagesPerAgent >= 1 && messagesPerAgent <= 100_000);
const dir = mkdtempSync(path.join(os.tmpdir(), "hive-inbox-benchmark-"));
const hive = new Hive(path.join(dir, "hive.db"));
const server = createServer(getRequestListener(createApp(hive).fetch));
const delay = monitorEventLoopDelay({ resolution: 10 });
try {
  const sender = hive.join({ role: "worker", seniority: "mid" });
  const readers = Array.from({ length: agentCount }, () => {
    const joined = hive.join({ role: "brain" });
    return { ...joined, channel: hive.openDm(joined.agent, sender.agent.name).id,
      sessionId: hive.openInboxSession(joined.agent, crypto.randomUUID()), expected: [] as number[] };
  });
  hive.db.exec("UPDATE agents SET inbox_cursor = (SELECT MAX(seq) FROM messages)");
  const insert = hive.db.prepare(`INSERT INTO messages(id, channel_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const body = "x".repeat(4000);
  hive.storage.transaction(() => {
    // Interleave agents: each wait must cross other agents' unread messages too.
    for (let i = 0; i < messagesPerAgent; i++) for (const reader of readers)
      reader.expected.push(Number(insert.run(crypto.randomUUID(), reader.channel, sender.agent.id, body, Date.now()).lastInsertRowid));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/agent`;
  let responses = 0, maxHttpBytes = 0, maxWireBytes = 0, maxScannedRows = 0, maxHydratedMessages = 0;
  const latencies: number[] = [];
  delay.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  const start = performance.now();
  await Promise.all(readers.map(async reader => {
    const received: number[] = [];
    const headers = { authorization: `Bearer ${reader.token}`, "content-type": "application/json" };
    while (received.length < reader.expected.length) {
      const before = performance.now();
      const response = await fetch(`${base}/wait`, { method: "POST", headers,
        body: JSON.stringify({ sessionId: reader.sessionId, compact: true, timeoutMs: 1 }) });
      assert.equal(response.status, 200);
      const raw = await response.text();
      latencies.push(performance.now() - before); responses++;
      const result = JSON.parse(raw) as WaitResult;
      maxHttpBytes = Math.max(maxHttpBytes, Buffer.byteLength(raw));
      maxWireBytes = Math.max(maxWireBytes, waitWireBytes(result));
      maxScannedRows = Math.max(maxScannedRows, result.page!.scannedRows);
      maxHydratedMessages = Math.max(maxHydratedMessages, result.page!.hydratedMessages);
      assert.ok(waitWireBytes(result) <= WAIT_MAX_BYTES);
      assert.ok(result.page!.scannedRows <= WAIT_SCAN_MAX);
      if (result.delivery) {
        received.push(...result.delivery.messageSeqs);
        const ack = await fetch(`${base}/inbox/ack`, { method: "POST", headers,
          body: JSON.stringify({ sessionId: reader.sessionId, deliveryId: result.delivery.id }) });
        assert.equal(ack.status, 200); await ack.text();
      } else assert.ok(result.page!.continuation, "Unexpected empty inbox before all fixtures arrived");
    }
    assert.deepEqual(received, reader.expected);
  }));
  const elapsedMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 20));
  delay.disable();
  latencies.sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  console.log(JSON.stringify({
    runtime: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    agents: agentCount, messagesPerAgent, bodyCharacters: body.length, responses,
    elapsedMs: round(elapsedMs), maxHttpBytes, maxWireBytes, maxScannedRows, maxHydratedMessages,
    waitLatencyMs: { p50: round(latencies[Math.floor(latencies.length * .5)]), p95: round(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)]), p99: round(latencies[Math.floor(latencies.length * .99)]) },
    eventLoopDelayMs: { mean: round(delay.mean / 1e6), p99: round(delay.percentile(99) / 1e6), max: round(delay.max / 1e6) },
    verification: "All fixture sequences received once and in order. Absolute measurements; no speedup claim.",
  }, null, 2));
} finally {
  delay.disable(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  hive.db.close(); rmSync(dir, { recursive: true, force: true });
}
