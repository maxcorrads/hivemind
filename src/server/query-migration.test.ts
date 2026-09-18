import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hive } from "./hive.ts";

for (const legacy of [false, true]) {
  test(`query indexes support ${legacy ? "literal pre-project upgrade" : "fresh install"} and restart`, (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-query-migration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hive.db");
    if (legacy) {
      const db = new DatabaseSync(file);
      try {
        db.exec(`
          CREATE TABLE agents (
            id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
            seniority TEXT, focus TEXT, token_hash TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, inbox_cursor INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE channels (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, topic TEXT,
            created_by TEXT NOT NULL, created_at INTEGER NOT NULL
          );
        `);
      } finally { db.close(); }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const hive = new Hive(file);
      try {
        for (const index of ["idx_agents_project_role", "idx_agents_role", "idx_channels_project_type_name", "idx_channel_members_agent_channel"]) {
          assert.ok(hive.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
        }
        assert.equal(hive.getAgent("human").role, "human");
      } finally { hive.db.close(); }
    }
  });
}

test("real wait admits and counts overflow through restart without duplicate or skipped mail", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-query-wait-"));
  const file = path.join(dir, "hive.db");
  let hive = new Hive(file);
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const brain = hive.join({ role: "brain" }).agent;
  const worker = hive.join({ role: "worker", seniority: "mid" }).agent;
  const channel = hive.openDm(brain, worker.name);
  const expected = Array.from({ length: 25 }, (_, i) => hive.postMessage(brain, { channel: channel.id, body: `work ${i}` }).id);
  const first = await hive.wait(worker, 100);
  assert.equal(first.idle, false);
  assert.ok((first.more ?? 0) > 0);
  const received = first.messages.map((m) => m.id);
  hive.db.close(); hive = new Hive(file);
  for (let page = 0; page < 5 && received.length < expected.length; page++) {
    const batch = await hive.wait(hive.getAgent(worker.id), 100);
    assert.equal(batch.idle, false);
    received.push(...batch.messages.map((m) => m.id));
  }
  assert.deepEqual(received, expected);
  assert.equal(hive.queuedCounts()[worker.id], 0);
});
