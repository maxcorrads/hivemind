import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { LauncherVerifier, launcherSignature } from "./launcher-channel.ts";
import { startServer } from "./serve.ts";
import { findRow, readValue, setAgentPresence, updateRows } from "./test-fixtures.ts";
import type { WorkerTemplateSpec } from "../shared/worker-templates.ts";

const SECRET = Buffer.alloc(32, 0x61);
const spec = (cap = 2): WorkerTemplateSpec => ({ label: "Worker", description: "Task work", software: "codex2",
  model: "gpt-6-sol", effort: "high", extraFlags: "", environment: { TASK_ENV: "safe" }, secretNames: [],
  seniority: "mid", focus: "tasks", maxConcurrent: cap, enabled: true });

function fixture(t: TestContext, cap = 2) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-launcher-channel-"));
  const file = path.join(dir, "hive.db"), hive = new Hive(file);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.createProject(human, { name: "Project", slug: "project", worktree: dir });
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const template = hive.workerTemplates.create(human, project.id, { slug: "worker", spec: spec(cap) });
  const app = createApp(hive, { instanceSecret: SECRET });
  const request = (approval = true) => {
    const { agent, ticket } = hive.identity.reserve(human, template, "task", approval);
    const id = randomUUID();
    const view = hive.launcherQueue.create({ requestId: id, brain, template, agent, ticket, reason: "Test task", approval });
    return { id, view, agent, ticket };
  };
  let nonceCounter = 0;
  const signed = async (method: string, target: string, body?: unknown, secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), nonce?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const n = nonce ?? (nonceCounter++).toString(16).padStart(64, "0");
    return app.request(target, { method, headers: { "content-type": "application/json",
      "x-hivemind-timestamp": timestamp, "x-hivemind-nonce": n,
      "x-hivemind-signature": launcherSignature(secret, method, target, timestamp, n, Buffer.from(raw)) },
    ...(body === undefined ? {} : { body: raw }) });
  };
  return { dir, file, hive, app, human, project, brain, template, request, signed };
}

test("signed channel authenticates method/path/query/body, rejects replay, skew, wrong secret and no-secret", async t => {
  const f = fixture(t);
  const target = "/api/launcher/next?timeoutMs=0";
  assert.equal((await f.signed("GET", target, undefined, Buffer.alloc(32))).status, 401);
  const stale = String(Math.floor(Date.now() / 1000) - 61);
  assert.equal((await f.signed("GET", target, undefined, SECRET, stale)).status, 401);
  const first = await f.signed("GET", target);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { command: null });
  const nonce = "f".repeat(64), at = String(Math.floor(Date.now() / 1000));
  assert.equal((await f.signed("GET", target, undefined, SECRET, at, nonce)).status, 200);
  assert.equal((await f.signed("GET", target, undefined, SECRET, at, nonce)).status, 401);
  const signature = launcherSignature(SECRET, "GET", target, at, "e".repeat(64), Buffer.alloc(0));
  const tampered = await f.app.request("/api/launcher/next?timeoutMs=1", { headers: {
    "x-hivemind-timestamp": at, "x-hivemind-nonce": "e".repeat(64), "x-hivemind-signature": signature } });
  assert.equal(tampered.status, 401);
  const unavailable = createApp(f.hive);
  assert.equal((await unavailable.request(target)).status, 404);
});

test("future-dated nonce stays rejected for its entire 120 second validity interval", async () => {
  let now = 1_000_000;
  const verifier = new LauncherVerifier(SECRET, () => now);
  const at = String(Math.floor(now / 1000) + 60), nonce = "a".repeat(64), target = "/api/launcher/next?timeoutMs=0";
  const request = () => new Request(`http://127.0.0.1${target}`, { headers: {
    "x-hivemind-timestamp": at, "x-hivemind-nonce": nonce,
    "x-hivemind-signature": launcherSignature(SECRET, "GET", target, at, nonce, Buffer.alloc(0)) } });
  await verifier.verify(request());
  now += 61_000;
  await assert.rejects(verifier.verify(request()), /Invalid launcher proof/);
  now += 58_000;
  await assert.rejects(verifier.verify(request()), /Invalid launcher proof/);
});

test("long poll wakes for a new approval with no launch command", async t => {
  const f = fixture(t);
  const pending = f.signed("GET", "/api/launcher/next?timeoutMs=5000");
  for (let n = 0; n < 30 && f.hive.bus.listenerCount("launch-requests") === 0; n++)
    await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.hive.bus.listenerCount("launch-requests"), 1);
  f.request();
  const result = await pending;
  assert.deepEqual(await result.json(), { command: null });
  assert.equal(f.hive.bus.listenerCount("launch-requests"), 0);
});

test("approval queues once, encrypted claim survives restart, result scrubs payload and public views hide ticket", async t => {
  const f = fixture(t), { id, ticket } = f.request();
  const nativePending = await f.signed("GET", "/api/launcher/approvals");
  assert.equal(nativePending.status, 200);
  const pendingList = await nativePending.json() as { requests: Array<{ id: string; reason: string }> };
  assert.equal(pendingList.requests.length, 1);
  assert.equal(pendingList.requests[0]!.id, id);
  assert.equal(pendingList.requests[0]!.reason, "Test task");
  assert.equal(JSON.stringify(pendingList).includes(ticket), false);
  const pending = await f.signed("GET", "/api/launcher/next?timeoutMs=0");
  assert.deepEqual(await pending.json(), { command: null });
  const list = await f.app.request("/api/ui/launch-requests");
  assert.equal(list.status, 200);
  assert.equal((await list.text()).includes(ticket), false);
  const row = findRow(f.hive, "launcher_commands", { request_id: id })!;
  assert.equal(String(row.payload).includes(ticket), false);
  assert.match(String(row.payload), /^v1:/);
  const key = path.join(f.dir, "launcher-queue.key");
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.file).includes(ticket), false);
  const approved = await f.signed("POST", `/api/launcher/requests/${id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal((await approved.json() as { request: { state: string } }).request.state, "approved");
  assert.deepEqual(await (await f.signed("GET", "/api/launcher/approvals")).json(), { requests: [] });
  const response = await f.signed("GET", "/api/launcher/next?timeoutMs=0");
  assert.equal(response.status, 200);
  const command = (await response.json() as { command: { id: string; kind: string; session: string; command: string; cwd: string } }).command;
  assert.equal(command.kind, "launch");
  assert.ok(command.command.includes(ticket));
  assert.equal(command.cwd, realpathSync(f.dir));
  assert.match(command.session, /^hm-project-/);
  const other = new Hive(f.file);
  t.after(async () => { await other.adaptiveTopology.stop(); other.db.close(); });
  assert.deepEqual(other.launcherQueue.next("http://127.0.0.1:7520"), command);
  const result = await f.signed("POST", `/api/launcher/${command.id}/result`, { status: "launched", session: command.session });
  assert.equal(result.status, 200);
  assert.equal((await f.signed("POST", `/api/launcher/${command.id}/result`, { status: "launched", session: command.session })).status, 200);
  assert.equal(readValue(f.hive, "launcher_commands", "payload", { id: command.id }), "");
  assert.equal((await f.signed("GET", "/api/launcher/next?timeoutMs=0")).status, 200);
  assert.equal(f.hive.launcherQueue.get(id).state, "launched");
});

test("missing, corrupt and non-private escrow keys fail closed while a command is pending", async t => {
  const f = fixture(t), { id } = f.request(false);
  const key = path.join(f.dir, "launcher-queue.key"), original = readFileSync(key);
  rmSync(key);
  assert.throws(() => new Hive(f.file), /key is missing/);
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  assert.throws(() => new Hive(f.file), /authentication failed/);
  writeFileSync(key, original, { mode: 0o600 });
  chmodSync(key, 0o644);
  assert.throws(() => new Hive(f.file), /private 0600/);
  chmodSync(key, 0o600);
  assert.equal(f.hive.launcherQueue.get(id).state, "approved");
});

test("Human approval cards retain older pending requests beyond the settled history page", async t => {
  const f = fixture(t), pending = f.request();
  for (let i = 0; i < 201; i++) {
    const settled = f.request();
    f.hive.launcherQueue.reject(f.human, settled.id);
  }
  const response = await f.app.request("/api/ui/launch-requests");
  assert.equal(response.status, 200);
  const body = await response.json() as { requests: Array<{ id: string }> };
  assert.deepEqual(body.requests.map(request => request.id), [pending.id]);
});

test("two pending approvals share one template cap; changing template and rejecting release reservations", async t => {
  const f = fixture(t, 1), first = f.request(), second = f.request();
  assert.equal(first.view.capBlocked, false);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${first.id}/approve`, {})).status, 200);
  assert.equal(f.hive.launcherQueue.get(second.id).capBlocked, true);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${second.id}/approve`, {})).status, 409);
  const alternate = f.hive.workerTemplates.create(f.human, f.project.id, { slug: "alternate", spec: spec(1) });
  assert.equal((await f.signed("POST", `/api/launcher/requests/${second.id}/approve`, { templateId: alternate.id })).status, 200);
  assert.equal(f.hive.identity.getAgent(second.agent.id).templateId, alternate.id);
  const third = f.hive.identity.reserve(f.human, alternate, "third", true);
  const thirdId = randomUUID();
  f.hive.launcherQueue.create({ requestId: thirdId, brain: f.brain, template: alternate, agent: third.agent, ticket: third.ticket, approval: true });
  assert.equal((await f.signed("POST", `/api/launcher/requests/${thirdId}/reject`, {})).status, 200);
  assert.equal(f.hive.identity.getAgent(third.agent.id).removedAt !== undefined, true);
  assert.equal(readValue(f.hive, "launcher_commands", "payload", { request_id: thirdId }), "");
});

test("an expired reservation cannot be approved or discounted from the template cap", async t => {
  const f = fixture(t, 1), stale = f.request();
  updateRows(f.hive, "agents", { pending_until: 0 }, { id: stale.agent.id });
  const expired = await f.signed("POST", `/api/launcher/requests/${stale.id}/approve`, {});
  assert.equal(expired.status, 409);
  assert.equal(f.hive.launcherQueue.get(stale.id).state, "expired");
  assert.equal(f.hive.identity.getAgent(stale.agent.id).removedAt !== undefined, true);
  const running = f.request(false);
  const waiting = f.request();
  assert.equal(f.hive.launcherQueue.get(waiting.id).capBlocked, true);
  assert.equal((await f.signed("POST", `/api/launcher/requests/${waiting.id}/approve`, {})).status, 409);
  assert.equal(f.hive.launcherQueue.get(running.id).state, "approved");
});

test("reservation sweep removes stale approvals from the signed notification feed", async t => {
  const f = fixture(t), pending = f.request();
  updateRows(f.hive, "agents", { pending_until: 0 }, { id: pending.agent.id });
  f.hive.identity.expireReservations();
  f.hive.launcherQueue.sweepExpired();
  assert.equal(f.hive.launcherQueue.get(pending.id).state, "expired");
  assert.deepEqual(await (await f.signed("GET", "/api/launcher/approvals")).json(), { requests: [] });
});

test("historical request retains template snapshot after delete; project deletion purges its queue before identities", async t => {
  const f = fixture(t), retired = f.request();
  assert.equal((await f.signed("POST", `/api/launcher/requests/${retired.id}/reject`, {})).status, 200);
  f.hive.workerTemplates.delete(f.human, f.template.id, f.template.revision);
  const historical = f.hive.launcherQueue.get(retired.id);
  assert.equal(historical.templateId, f.template.id);
  assert.equal(historical.templateLabel, f.template.spec.label);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  f.hive.projects.deleteProject(f.human, f.project.slug);
  assert.equal(findRow(f.hive, "launch_requests", { id: retired.id }), undefined);
  assert.equal(findRow(f.hive, "launcher_commands", { request_id: retired.id }), undefined);
});

test("real HTTP launcher channel bypasses Human cookie, and client disconnect releases long-poll waiter", async t => {
  const f = fixture(t);
  process.env.HIVEMIND_INSTANCE_SECRET = SECRET.toString("hex");
  const server = startServer({ port: 0, hive: f.hive, telegram: false });
  try {
    const port = await server.ready, base = `http://127.0.0.1:${port}`;
    const target = "/api/launcher/next?timeoutMs=30000";
    const at = String(Math.floor(Date.now() / 1000)), nonce = "d".repeat(64);
    const controller = new AbortController();
    const pending = fetch(base + target, { signal: controller.signal, headers: {
      "x-hivemind-timestamp": at, "x-hivemind-nonce": nonce,
      "x-hivemind-signature": launcherSignature(SECRET, "GET", target, at, nonce, Buffer.alloc(0)) } });
    for (let n = 0; n < 30 && f.hive.bus.listenerCount("launcher-queue") === 0; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.hive.bus.listenerCount("launcher-queue"), 1);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    for (let n = 0; n < 30 && f.hive.bus.listenerCount("launcher-queue") !== 0; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.hive.bus.listenerCount("launcher-queue"), 0);
    assert.equal(f.hive.bus.listenerCount("launch-requests"), 1, "only serve's realtime forwarder remains");
    const valid = "/api/launcher/next?timeoutMs=0", secondNonce = "c".repeat(64);
    const response = await fetch(base + valid, { headers: { "x-hivemind-timestamp": at,
      "x-hivemind-nonce": secondNonce,
      "x-hivemind-signature": launcherSignature(SECRET, "GET", valid, at, secondNonce, Buffer.alloc(0)) } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { command: null });
  } finally { await server.shutdown(); }
  const noSecret = startServer({ port: 0, hive: f.hive, telegram: false });
  try {
    const port = await noSecret.ready;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/launcher/next?timeoutMs=0`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/launcher/approvals`)).status, 404);
  } finally { await noSecret.shutdown(); }
});

test("project deletion waits for a dispatched launch and its compensating kill", async t => {
  const f = fixture(t), launched = f.request(false);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(launch.kind, "launch");
  f.hive.launcherQueue.kill(launched.id);
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  if (launch.kind !== "launch") throw new Error("Expected launch");
  const next = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(next.kind, "kill", "a cancelled dispatch is never redelivered as a fresh launch");
  f.hive.launcherQueue.result(launch.id, { status: "launched", session: launch.session });
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(kill.kind, "kill");
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  f.hive.launcherQueue.result(kill.id, { status: "killed" });
  assert.equal(f.hive.identity.getAgent(launched.agent.id).removedAt !== undefined, true);
  f.hive.projects.deleteProject(f.human, f.project.slug);
});

test("failed kill keeps project and command history until session closure is resolved", async t => {
  const f = fixture(t), launched = f.request(false);
  setAgentPresence(f.hive, f.brain.id, { online: false });
  const launch = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  if (launch.kind !== "launch") throw new Error("Expected launch");
  f.hive.launcherQueue.result(launch.id, { status: "launched", session: launch.session });
  f.hive.launcherQueue.kill(launched.id);
  const kill = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  f.hive.launcherQueue.result(kill.id, { status: "failed" });
  assert.match(f.hive.launcherQueue.get(launched.id).error ?? "", /Session close failed/);
  assert.throws(() => f.hive.projects.deleteProject(f.human, f.project.slug), /Settle launch and session commands/);
  assert.ok(findRow(f.hive, "launcher_commands", { id: kill.id }));
  f.hive.launcherQueue.kill(launched.id);
  const retry = f.hive.launcherQueue.next("http://127.0.0.1:7520")!;
  assert.equal(retry.kind, "kill");
  assert.notEqual(retry.id, kill.id);
  f.hive.launcherQueue.kill(launched.id);
  assert.equal(f.hive.launcherQueue.next("http://127.0.0.1:7520")!.id, retry.id);
  f.hive.launcherQueue.result(retry.id, { status: "killed" });
  assert.equal(f.hive.launcherQueue.get(launched.id).error, null);
  f.hive.projects.deleteProject(f.human, f.project.slug);
});
