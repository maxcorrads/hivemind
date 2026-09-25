import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";
import { snapshotTables } from "./test-fixtures.ts";

test("shutdown returns HTTP 503 to all open waits without replacing sessions or acknowledging mail", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-restart-wait-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const server = startServer({ hive, port: 0, telegram: false });
  t.after(async () => { await server.shutdown(); hive.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = await server.ready;
  const workers = Array.from({ length: 3 }, () => hive.identity.join({ role: "worker", seniority: "mid" }));
  const sessions = workers.map(worker => hive.delivery.openInboxSession(worker.agent, randomUUID()));
  let admit!: () => void; const admitted = new Promise<void>(resolve => { admit = resolve; }); let count = 0;
  const wait = hive.delivery.wait.bind(hive.delivery);
  t.mock.method(hive.delivery, "wait", (...args: Parameters<typeof wait>) => {
    const pending = wait(...args);
    if (++count === workers.length) admit();
    return pending;
  });
  const pending = workers.map((worker, i) => fetch(`http://127.0.0.1:${port}/api/agent/wait`, {
    method: "POST", headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sessions[i], timeoutMs: 30_000 }), signal: t.signal,
  }).then(async response => ({ status: response.status, body: await response.json() })));
  await admitted;
  const before = snapshotTables(hive, ["inbox_sessions", "inbox_deliveries", "task_records", "task_events"]);
  const tokens = workers.map(worker => hive.identity.sessionFingerprint(worker.agent.id));
  await server.shutdown();
  assert.deepEqual(await Promise.all(pending), workers.map(() => ({ status: 503, body: { error: "Server is shutting down" } })));
  assert.deepEqual(snapshotTables(hive, Object.keys(before)), before);
  assert.deepEqual(workers.map(worker => hive.identity.sessionFingerprint(worker.agent.id)), tokens);
  assert.deepEqual(workers.map(worker => hive.inbox.currentSession(worker.agent.id)), sessions);
});

test("a genuine replacement still supersedes its wait even when shutdown follows", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-restart-replaced-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const server = startServer({ hive, port: 0, telegram: false }); await server.ready;
  t.after(async () => { await server.shutdown(); hive.close(); rmSync(dir, { recursive: true, force: true }); });
  const worker = hive.identity.join({ role: "worker", seniority: "mid" });
  const sessionId = hive.delivery.openInboxSession(worker.agent, randomUUID());
  const pending = hive.delivery.wait(worker.agent, 30_000, undefined, { sessionId });
  const rejected = assert.rejects(pending, { status: 409, message: "superseded" });
  hive.identity.join({ role: "worker", resumeName: worker.agent.name });
  await server.shutdown(); await rejected;
  assert.throws(() => hive.identity.agentByToken(worker.token), { status: 401 });
});
