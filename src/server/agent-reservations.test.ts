import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { nameSlug } from "./services/identity.ts";
import { parseJoinArgs } from "../shared/join-args.ts";
import { HiveError, RESERVATION_MS, type Agent } from "../shared/types.ts";
import type { WorkerTemplateSpec } from "../shared/worker-templates.ts";

// Reserved, task-bound workers (Phase A1, #276). In-process only: no server or socket is started.

const spec = (patch: Partial<WorkerTemplateSpec> = {}): WorkerTemplateSpec => ({
  label: "Codex senior", description: "Backend work.", software: "codex2", model: "", effort: "", extraFlags: "", environment: {},
  secretNames: [], seniority: "senior", focus: "backend", maxConcurrent: 2, enabled: true, ...patch,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-reservations-"));
  const hive = new Hive(path.join(dir, "hive.db"), { routineBatchMs: 0 });
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.listProjects()[0]!;
  const template = hive.workerTemplates.create(human, project.id, { slug: "codex-senior", spec: spec() });
  const events: Agent[] = [];
  hive.bus.on("agent", agent => events.push(agent));
  return { hive, human, project, template, events };
}

const status = (code: number, message?: RegExp) => (error: unknown) =>
  error instanceof HiveError && error.status === code && (!message || message.test(error.message));

test("a reserved worker waits, then its launch joins it once with the ticket", t => {
  const { hive, human, template, events } = fixture(t);
  const { agent, ticket } = hive.identity.reserve(human, template, "Settings page!");
  assert.match(agent.name, /^[A-Z][A-Za-z]+-settings-page$/);
  assert.match(ticket, /^hmc_[0-9a-f]{48}$/);
  assert.equal(agent.role, "worker");
  assert.equal(agent.seniority, "senior");
  assert.equal(agent.focus, "backend");
  assert.equal(agent.online, false);
  assert.equal(agent.templateId, template.id);
  assert.ok(agent.pending && agent.pending.until > Date.now() && agent.pending.until <= Date.now() + RESERVATION_MS);
  assert.equal(events.at(-1)?.id, agent.id, "the roster hears of it at once");
  assert.ok(hive.identity.listAgents().some(item => item.id === agent.id), "listed, as starting");

  assert.throws(() => hive.identity.join({ role: "worker", resumeName: agent.name }), status(409, /has not joined yet/),
    "never by name: only the launch that holds the ticket");
  assert.throws(() => hive.identity.join({ role: "brain", claim: ticket }), status(400));

  const joined = hive.identity.join({ role: "worker", claim: ticket, terminalSession: `hm-acme-${agent.name.toLowerCase()}` });
  assert.equal(joined.agent.id, agent.id);
  assert.equal(joined.created, true, "a first join: its standing orders come with it");
  assert.equal(joined.agent.pending, undefined);
  assert.equal(joined.agent.online, true);
  assert.equal(hive.identity.agentByToken(joined.token).id, agent.id);
  assert.throws(() => hive.identity.join({ role: "worker", claim: ticket }), status(401), "the ticket works once");
  const resumed = hive.identity.join({ role: "worker", resumeName: agent.name });
  assert.equal(resumed.agent.id, agent.id, "once joined, it resumes by name like any worker");
  assert.equal(human.id, "human");
});

test("mail sent while it starts reaches it after it joins", async t => {
  const { hive, human, template } = fixture(t);
  const { agent, ticket } = hive.identity.reserve(human, template, "api");
  const dm = hive.channels.openDm(human, agent.name);
  hive.messages.postMessage(human, { channel: dm.id, body: "Start with the API contract" });
  const general = hive.channels.listChannels(human).find(channel => channel.name === "general")!;
  assert.ok(general.memberIds.includes(agent.id), "already a member of the public channels");

  const joined = hive.identity.join({ role: "worker", claim: ticket });
  const me = hive.identity.agentByToken(joined.token);
  const mail = await hive.delivery.wait(me, 10, undefined, { sessionId: hive.delivery.openInboxSession(me, randomUUID()), compact: true });
  assert.ok(mail.mail?.some(item => item.body === "Start with the API contract"));
});

test("a reservation that is never claimed is withdrawn after 30 minutes", t => {
  const { hive, human, template } = fixture(t);
  const { agent, ticket } = hive.identity.reserve(human, template);
  hive.identity.expireReservations(Date.now() + RESERVATION_MS - 1_000);
  assert.equal(hive.identity.getAgent(agent.id).removedAt, undefined, "not yet");
  hive.identity.expireReservations(Date.now() + RESERVATION_MS + 1_000);
  assert.ok(hive.identity.getAgent(agent.id).removedAt !== undefined);
  assert.throws(() => hive.identity.join({ role: "worker", claim: ticket }), status(401));
  const notes = hive.messageQueries.listMessages(human, "general").messages.map(message => message.body);
  assert.ok(notes.some(body => body === `${agent.name} was withdrawn: its launch did not join within 30 minutes.`));
});

test("a late claim is refused and withdraws the worker", t => {
  const { hive, human, template } = fixture(t);
  const { agent, ticket } = hive.identity.reserve(human, template);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + RESERVATION_MS + 1_000 });
  assert.throws(() => hive.identity.join({ role: "worker", claim: ticket }), status(410, /waited too long/));
  assert.ok(hive.identity.getAgent(agent.id).removedAt !== undefined);
});

test("reserving respects the template: enabled, and at most maxConcurrent at once", t => {
  const { hive, human, project, template } = fixture(t);
  hive.identity.reserve(human, template);
  const second = hive.identity.reserve(human, template);
  assert.throws(() => hive.identity.reserve(human, template), status(409, /already has 2 of at most 2/));
  hive.identity.removeAgent(human, second.agent.name);
  hive.identity.reserve(human, template);
  const disabled = hive.workerTemplates.create(human, project.id, { slug: "off", spec: spec({ enabled: false }) });
  assert.throws(() => hive.identity.reserve(human, disabled), status(409, /disabled/));
  const brain = hive.identity.join({ role: "brain" }).agent;
  assert.throws(() => hive.identity.reserve(brain, template), status(403));
});

test("names get a numeric suffix when the reserved one is taken", t => {
  const { hive, human, project } = fixture(t);
  const wide = hive.workerTemplates.create(human, project.id, { slug: "wide", spec: spec({ maxConcurrent: 8 }) });
  const names = Array.from({ length: 3 }, () => hive.identity.reserve(human, wide, "same").agent.name);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 3);
  assert.equal(nameSlug("  Crème brûlée — v2 / API!! "), "creme-brulee-v2-api");
  assert.equal(nameSlug("a".repeat(40)), "a".repeat(24));
  assert.equal(nameSlug("!!!"), "");
});

test("Human reserves over HTTP; the ticket is not cached and the CLI passes it", async t => {
  const { hive, template } = fixture(t);
  const app = createApp(hive);
  const response = await app.request(`/api/ui/worker-templates/${template.id}/reserve`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Login flow" }) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { agent, ticket } = await response.json() as { agent: Agent; ticket: string };
  assert.match(agent.name, /-login-flow$/);
  const join = await app.request("/api/agent/join", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "worker", claim: ticket }) });
  assert.equal(join.status, 200);
  assert.equal((await join.json() as { agent: Agent }).agent.id, agent.id);

  assert.deepEqual(parseJoinArgs(["join", "--claim", ticket]), { role: "worker", seniority: null, focus: null, resume: null, token: null,
    project: null, claim: ticket });
});
