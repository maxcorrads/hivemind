import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

test("resuming by name needs no credential, supersedes the old session and redelivers unacknowledged mail", { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-resume-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent("human"), worker = hive.join({ role: "worker", seniority: "mid" });
  assert.throws(() => hive.join({ role: "worker", seniority: "mid", resumeName: "Nobody" }), /No brain or worker named Nobody/);
  assert.throws(() => hive.join({ role: "brain", resumeName: worker.agent.name }), /role cannot change/);
  assert.throws(() => hive.join({ role: "worker", seniority: "senior", resumeName: worker.agent.name }), /seniority cannot change/);
  assert.throws(() => hive.join({ role: "worker", seniority: "mid", token: "stale" }), /no longer valid/);

  const repeated = hive.join({ role: "worker", seniority: "mid", token: worker.token, resumeName: worker.agent.name });
  assert.equal(repeated.token, worker.token, "The running process keeps its session on a repeated join");

  const session = hive.openInboxSession(worker.agent, randomUUID());
  const dm = hive.openDm(human, worker.agent.name);
  hive.postMessage(human, { channel: dm.id, body: "remain unacknowledged across a resume" });
  const offered = await hive.wait(worker.agent, 100, undefined, { sessionId: session });

  const resumed = hive.join({ role: "worker", resumeName: worker.agent.name.toUpperCase(), token: "stale-from-an-old-shell" });
  assert.equal(resumed.created, false);
  assert.equal(resumed.agent.id, worker.agent.id);
  assert.notEqual(resumed.token, worker.token);
  assert.throws(() => hive.agentByToken(worker.token), /Invalid token/, "The previous session key stops working");
  assert.throws(() => hive.acknowledgeInbox(worker.agent, session, offered.delivery!.id), /superseded/);

  const current = hive.agentByToken(resumed.token);
  const currentSession = hive.openInboxSession(current, randomUUID());
  const replay = await hive.wait(current, 100, undefined, { sessionId: currentSession });
  assert.equal(replay.delivery!.id, offered.delivery!.id, "Unacknowledged mail is not lost by resuming");
  hive.acknowledgeInbox(current, currentSession, replay.delivery!.id);

  // A waiting process is released as superseded when another session resumes the same name.
  const pending = hive.wait(current, 5000, undefined, { sessionId: currentSession });
  const superseded = assert.rejects(pending, /superseded/);
  hive.join({ role: "worker", resumeName: worker.agent.name });
  await superseded;
});

test("resume keeps project and worktree constraints; agent credential recovery is gone from the Human API", { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-resume-http-"));
  const hive = new Hive(path.join(dir, "hive.db")), service = startServer({ hive, port: 0, telegram: false });
  t.after(async () => { await service.shutdown(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.getAgent("human"), first = hive.join({ role: "brain" });
  hive.createProject(human, { name: "Other", slug: "other", worktree: path.join(dir, "other") });
  assert.throws(() => hive.join({ role: "brain", token: first.token, cwd: path.join(dir, "other") }), /project cannot change/);
  assert.throws(() => hive.join({ role: "brain", resumeName: first.agent.name, cwd: path.join(dir, "other") }), /project cannot change/);
  assert.throws(() => hive.join({ role: "brain", resumeName: first.agent.name, project: "other" }), /project cannot change/);
  assert.throws(() => hive.join({ role: "worker", seniority: "mid", token: first.token }), /role cannot change/);
  assert.equal(hive.join({ role: "brain", token: first.token, project: "chapter" }).created, false);

  const base = `http://127.0.0.1:${await service.ready}`;
  const joined = await fetch(`${base}/api/agent/join`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "brain", resume: first.agent.name, project: "chapter" }) });
  assert.equal(joined.status, 200, await joined.clone().text());
  const body = await joined.json() as { agent: { id: string }; token: string; created: boolean };
  assert.equal(body.agent.id, first.agent.id);
  assert.equal(body.created, false);
  const me = await fetch(`${base}/api/agent/me`, { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200); await me.body?.cancel();

  const bootstrap = await fetch(`${base}/api/ui/session`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  await bootstrap.body?.cancel();
  const recovery = await fetch(`${base}/api/ui/projects/${first.agent.projectId}/agents/${first.agent.id}/credential`, { headers: { origin: base, cookie } });
  assert.equal(recovery.status, 404, "Brains and workers have no credentials to recover"); await recovery.body?.cancel();
});
