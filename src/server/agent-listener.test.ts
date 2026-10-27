import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";
import { INSTANCE_SECRET_ENV } from "./instance-proof.ts";
import { launcherSignature } from "./launcher-channel.ts";
import { agentRequest } from "../client/http.ts";
import type { WorkerTemplateSpec } from "../shared/worker-templates.ts";

// The agent-only listener (docs/remote-hosts.md#agent-listener). Every server here binds
// ephemeral loopback ports; the default 7422 is never used.

const SECRET = Buffer.alloc(32, 0x62);
const spec: WorkerTemplateSpec = { label: "Worker", description: "Task work", software: "codex2", model: "", effort: "",
  extraFlags: "", environment: {}, secretNames: [], seniority: "mid", focus: "tasks", maxConcurrent: 2, enabled: true };

/** A hive in a temp dir, closed after `stop` (the server's shutdown) when the test ends. */
function hiveDir(t: TestContext, stop: () => Promise<unknown> = async () => {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-agent-listener-"));
  const hive = new Hive(path.join(dir, "hive", "hive.db"));
  hive.projects.createProject(hive.identity.getAgent("human"), { name: "Project", slug: "project", worktree: dir });
  let stopping = stop;
  t.after(async () => {
    try { await stopping(); } finally { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  return { hive, onStop: (next: () => Promise<unknown>) => { stopping = next; } };
}

async function serve(t: TestContext, agentPort: number | null | undefined, secret = false) {
  const { hive, onStop } = hiveDir(t);
  if (secret) process.env[INSTANCE_SECRET_ENV] = SECRET.toString("hex");
  const started = startServer({ port: 0, hive, telegram: false, ...(agentPort === undefined ? {} : { agentPort }) });
  onStop(() => started.shutdown());
  const port = await started.ready, agent = await started.agentReady;
  return { hive, started, port, agent, human: `http://127.0.0.1:${port}`, agentOrigin: `http://127.0.0.1:${agent}` };
}

/** Raw HTTP, so a target keeps its dot segments and a Host header can be anything. */
function raw(port: number, method: string, target: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: target, headers: { connection: "close", ...headers } }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function signed(method: string, target: string, nonce: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { "x-hivemind-timestamp": timestamp, "x-hivemind-nonce": nonce,
    "x-hivemind-signature": launcherSignature(SECRET, method, target, timestamp, nonce, Buffer.alloc(0)) };
}

function webSocketStatus(origin: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws", { origin, headers });
    ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
    ws.once("open", () => { ws.close(); reject(new Error("WebSocket opened")); });
    ws.once("error", () => {});
  });
}

const tcpServers = () => process.getActiveResourcesInfo().filter(name => name === "TCPServerWrap").length;

test("without an agent port nothing else listens, and the Human listener answers as before", async t => {
  for (const agentPort of [undefined, null]) {
    const before = tcpServers();
    const { started, port, agent, human } = await serve(t, agentPort);
    assert.equal(agent, null);
    assert.equal(started.agentServer, null);
    assert.equal(started.agentPort, null);
    assert.equal(tcpServers() - before, 1, "only the Human listener is bound");
    // The same answers the Human listener has always given.
    const session = await raw(port, "POST", "/api/ui/session", { origin: human, "content-type": "application/json" }, "{}");
    assert.equal(session.status, 200);
    assert.match(String(session.headers["set-cookie"]), new RegExp(`^hivemind_human_${port}=`));
    assert.equal((await raw(port, "GET", "/api/ui/state")).status, 401);
    assert.equal((await raw(port, "GET", "/api/health")).status, 200);
    const joined = await fetch(human + "/api/agent/join", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "brain", project: "project" }) });
    assert.equal(joined.status, 200);
    await started.shutdown();
    assert.equal(started.server.listening, false);
  }
});

test("the agent listener serves the agent API, its join and claim, through the client's origin check", async t => {
  const { hive, started, port, agent, agentOrigin } = await serve(t, 0);
  assert.ok(agent && agent !== port);
  assert.equal(started.agentServer?.listening, true);
  assert.equal((await raw(agent, "GET", "/api/health")).body, JSON.stringify({ ok: true, name: "hivemind" }));

  // The same client code the MCP runs, pointed at the listener as on a remote host.
  const saved = process.env.HIVEMIND_URL;
  process.env.HIVEMIND_URL = agentOrigin;
  t.after(() => { if (saved === undefined) delete process.env.HIVEMIND_URL; else process.env.HIVEMIND_URL = saved; });
  const joined = await agentRequest<{ agent: { id: string; name: string }; token: string }>("POST", "/api/agent/join", { role: "brain", project: "project" }, null);
  const me = await agentRequest<{ you: { name: string; role: string } }>("GET", "/api/agent/me", undefined, joined.token);
  assert.deepEqual([me.you.name, me.you.role], [joined.agent.name, "brain"]);
  const channels = await agentRequest<{ channels: unknown[] }>("GET", "/api/agent/channels", undefined, joined.token);
  assert.ok(channels.channels.length > 0);
  assert.equal(hive.identity.agentByToken(joined.token).online, true, "one hive behind both listeners");

  // A launched worker's claim ticket joins it here, once.
  const human = hive.identity.getAgent("human"), project = hive.projects.listProjects()[0]!;
  const template = hive.workerTemplates.create(human, project.id, { slug: "worker", spec });
  const { agent: reserved, ticket } = hive.identity.reserve(human, template, "Remote task");
  const claimed = await agentRequest<{ agent: { id: string } }>("POST", "/api/agent/join", { role: "worker", claim: ticket }, null);
  assert.equal(claimed.agent.id, reserved.id);
  await assert.rejects(agentRequest("POST", "/api/agent/join", { role: "worker", claim: ticket }, null), { status: 401 });

  // Authentication and the ingress gate stay those of the agent API.
  assert.equal((await raw(agent, "GET", "/api/agent/me")).status, 401);
  assert.equal((await raw(agent, "GET", "/api/agent/me", { authorization: "Bearer hm_not-a-token" })).status, 401);
  assert.equal((await raw(agent, "GET", "/api/agent/me", { host: "hive.example", authorization: `Bearer ${joined.token}` })).status, 403);
  assert.equal((await raw(agent, "GET", "/api/agent/me", { origin: "http://hive.example", authorization: `Bearer ${joined.token}` })).status, 403);
  assert.equal((await raw(agent, "GET", "/api/agent/no-such-route", { authorization: `Bearer ${joined.token}` })).status, 404);
  // And the Human listener keeps serving agents too.
  assert.equal((await raw(port, "GET", "/api/agent/me", { authorization: `Bearer ${joined.token}` })).status, 200);
});

test("every Human, launcher, bot, UI and WebSocket route answers 404 on the agent listener", async t => {
  const { hive, port, agent, human, agentOrigin } = await serve(t, 0, true);
  const session = await raw(port, "POST", "/api/ui/session", { origin: human, "content-type": "application/json" }, "{}");
  const cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  const secret = cookie.split("=")[1]!;
  const brain = hive.identity.join({ role: "brain", project: "project" });
  const nonce = "c".repeat(64);
  let counter = 0;
  const launcher = (method: string, target: string) => signed(method, target, (counter++).toString(16).padStart(64, "0"));
  // [method, target, headers]: each one a route the Human listener serves (not 404 there), or a path trick.
  const humanRoutes: Array<[string, string, Record<string, string>]> = [
    ["GET", "/api/ui/snapshot", { cookie, "x-hivemind-human": secret }],
    ["GET", "/api/ui/accounts", { cookie, "x-hivemind-human": secret }],
    ["GET", "/api/ui/launch-requests", { cookie, "x-hivemind-human": secret }],
    ["GET", "/api/ui/read-state", { cookie, "x-hivemind-human": secret }],
    ["GET", "/api/health/instance?nonce=" + nonce, {}],
    ["GET", "/api/launcher/approvals", launcher("GET", "/api/launcher/approvals")],
    ["GET", "/api/launcher/accounts", launcher("GET", "/api/launcher/accounts")],
    ["GET", "/api/bot/channels/general/messages", { authorization: `Bearer ${brain.token}` }],
  ];
  for (const [method, target, headers] of humanRoutes) {
    const there = await raw(port, method, target, headers);
    assert.notEqual(there.status, 404, `${target} is served on the Human listener`);
    // Re-sign: a launcher nonce works once.
    const again = target.startsWith("/api/launcher/") ? launcher(method, target) : headers;
    const here = await raw(agent!, method, target, again);
    assert.equal(here.status, 404, target);
    assert.deepEqual(JSON.parse(here.body), { error: "Not found" }, target);
  }
  // The session bootstrap is never handled here: no cookie, no Human secret.
  const bootstrap = await raw(agent!, "POST", "/api/ui/session", { origin: agentOrigin, "content-type": "application/json" }, "{}");
  assert.equal(bootstrap.status, 404);
  assert.equal(bootstrap.headers["set-cookie"], undefined);
  assert.equal((await raw(agent!, "OPTIONS", "/api/ui/state", { origin: agentOrigin, "access-control-request-method": "POST" })).status, 404);
  for (const target of ["/", "/index.html", "/assets/index.js", "/favicon.svg", "/api", "/api/", "/api/ui", "/api/agentx",
    "/api/agents", "//api/agent/me", "/api/agent/../ui/state", "/api/agent/%2e%2e/ui/state", "/api/agent/%2E%2E/ui/state",
    "/api/agent/..%2fui/state", "/api/agent%2f..%2fui/state", "/api/health/../ui/state", "/api/healthz", "/ws", "/ws?x=1"]) {
    const here = await raw(agent!, "GET", target, { cookie, "x-hivemind-human": secret });
    assert.equal(here.status, 404, target);
    assert.equal(here.headers["content-type"], "application/json", target);
  }
  // No WebSocket server: an upgrade with a valid Human session is a plain 404.
  assert.equal(await webSocketStatus(agentOrigin, { cookie }), 404);
  assert.equal(await webSocketStatus(human), 403, "the Human listener's socket still needs a session");
});

test("an agent port already in use fails the start, and shutdown closes both listeners", async t => {
  const blocker = createNetServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const taken = (blocker.address() as { port: number }).port;
  const { hive, onStop } = hiveDir(t);
  const failed = startServer({ port: 0, hive, telegram: false, agentPort: taken });
  onStop(() => failed.shutdown());
  await assert.rejects(failed.ready, { code: "EADDRINUSE" });
  await assert.rejects(failed.agentReady, { code: "EADDRINUSE" });
  await failed.shutdown();
  assert.equal(failed.server.listening, false);

  const { started } = await serve(t, 0);
  await started.shutdown();
  assert.equal(started.server.listening, false);
  assert.equal(started.agentServer?.listening, false);
});
