import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lastConversations } from "./cli-conversations.ts";

const NOW = Date.UTC(2026, 9, 14, 0, 0);
const HOUR = 3_600_000;

function write(file: string, text: string, at: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, at / 1000, at / 1000);
}

test("each agent gets its newest conversation in its own CLI home, by the first name its transcript gives", async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "hm-cli-conversations-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = "/Users/me/acme";
  // Claude in a second home: the launch prompt names Atlas; a later line names another agent.
  write(path.join(home, ".claude2/projects/-Users-me-acme/c1a2b3c4-0000-4000-8000-000000000001.jsonl"),
    `{"type":"user","cwd":"${repo}","sessionId":"c1a2b3c4-0000-4000-8000-000000000001","message":"join with resume=Atlas"}\n` +
    `{"type":"user","message":"ask Bea, You are the Hivemind worker Bea"}\n`, NOW - 2 * HOUR);
  // An older Claude conversation of Atlas loses to the newer one.
  write(path.join(home, ".claude/projects/-Users-me-acme/c1a2b3c4-0000-4000-8000-000000000002.jsonl"),
    `{"type":"user","cwd":"${repo}","message":"resume=Atlas"}\n`, NOW - 5 * HOUR);
  // Atlas in another project's folder is a different agent.
  write(path.join(home, ".claude/projects/-Users-me-other/c1a2b3c4-0000-4000-8000-000000000003.jsonl"),
    `{"type":"user","cwd":"/Users/me/other","message":"resume=Atlas"}\n`, NOW - HOUR);
  // Codex: a reserved worker; the second account home shares the sessions folder, so it counts once.
  const rollout = path.join(home, ".codex/sessions/2026/10/13/rollout-2026-10-13T22-00-00-01a13757-5872-7e90-8bde-22d6bdb43926.jsonl");
  write(rollout, `{"type":"session_meta","payload":{"id":"01a13757-5872-7e90-8bde-22d6bdb43926","cwd":"${repo}"}}\n` +
    `{"type":"message","content":"You are the Hivemind worker Bea, reserved for one task."}\n`, NOW - 3 * HOUR);
  mkdirSync(path.join(home, ".codex2"));
  symlinkSync(path.join(home, ".codex/sessions"), path.join(home, ".codex2/sessions"));
  // An agent started by hand gets its name from join's answer.
  write(path.join(home, ".codex-tw/sessions/2026/10/13/rollout-x-01a134f5-af77-7400-8dbf-bff4550d64dd.jsonl"),
    `{"type":"session_meta","payload":{"id":"01a134f5-af77-7400-8dbf-bff4550d64dd","cwd":"${repo}"}}\n` +
    String.raw`{"output":"{\"you\":{\"name\":\"Quorum\",\"role\":\"brain\"}}"}` + "\n", NOW - 4 * HOUR);
  // Cursor keeps the chat in SQLite: the name sits somewhere in the store.
  write(path.join(home, ".cursor/chats/ws1/b14326cc-7c9d-455d-8960-ada07cb85589/store.db"),
    "SQLite format 3\0" + "x".repeat(5000) + "You are the Hivemind worker Cy, reserved", NOW - 6 * HOUR);
  // Too old to count.
  write(path.join(home, ".claude/projects/-Users-me-acme/c1a2b3c4-0000-4000-8000-000000000004.jsonl"),
    `{"type":"user","cwd":"${repo}","message":"resume=Dee"}\n`, NOW - 30 * 24 * HOUR);

  const agents = ["Atlas", "Bea", "Quorum", "Cy", "Dee"].map(name => ({ id: name.toLowerCase(), name, worktree: repo }));
  const found = await lastConversations(home, agents, NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(found).map(([id, c]) => [id, [c.cli, c.software, c.id]])), {
    atlas: ["claude", "claude2", "c1a2b3c4-0000-4000-8000-000000000001"],
    bea: ["codex", "codex", "01a13757-5872-7e90-8bde-22d6bdb43926"],
    quorum: ["codex", "codex-tw", "01a134f5-af77-7400-8dbf-bff4550d64dd"],
    cy: ["cursor", "agent", "b14326cc-7c9d-455d-8960-ada07cb85589"],
  });
  assert.equal(found.atlas!.cwd, repo);
  assert.equal(found.atlas!.at, NOW - 2 * HOUR);
});
