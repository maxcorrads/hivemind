import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { launcherSignature } from "./launcher-channel.ts";
import { listRows, snapshotTables } from "./test-fixtures.ts";
import type { WorkerTemplateSpec } from "../shared/worker-templates.ts";
import { toLaunchAccount } from "../shared/accounts.ts";

// Redaction (phase 5, #325): fake secrets planted in fake homes and payloads never reach an HTTP answer, a log line or a
// stored row. The usage parsers, the Server.app probe and the broker's shadow launches run in Swift
// (macos/Tests/HivemindKitTests/AccountRedactionTests.swift); here the server gets the usage post, the Human routes and the
// launches around them. Fake values only.

const SECRET = Buffer.alloc(32, 0x61);
const ANTHROPIC_KEY = "sk-ant-FAKE-REDACTION-0001";
const ACCESS_TOKEN = "FAKE-ACCESS-TOKEN-REDACTION-0002";
const REFRESH_TOKEN = "FAKE-REFRESH-TOKEN-REDACTION-0003";
const CREDENTIALS = "FAKE-CREDENTIALS-BODY-REDACTION-0004";
const EMAIL = "fake.person@example.com";
const MCP_VALUE = "FAKE-MCP-SECRET-VALUE-REDACTION-0005";
const ACCOUNT_UUID = "00000000-0000-4000-8000-0000000000aa";
/** Every planted value: none may appear in an answer, a log line or a stored row. */
const PLANTED = [ANTHROPIC_KEY, ACCESS_TOKEN, REFRESH_TOKEN, CREDENTIALS, EMAIL, MCP_VALUE, ACCOUNT_UUID];

/** Fake homes with the files a login leaves behind: auth.json, .credentials.json and a .claude.json with mcpServers. */
function plantHomes(dir: string) {
  const home = path.join(dir, "home"), codexShadow = path.join(home, ".codex-personal"), claudeShadow = path.join(home, ".claude-work");
  const plant = (file: string, body: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  };
  plant(path.join(codexShadow, "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } });
  plant(path.join(claudeShadow, ".credentials.json"), { claudeAiOauth: { accessToken: ANTHROPIC_KEY, refreshToken: CREDENTIALS } });
  plant(path.join(claudeShadow, ".claude.json"), { oauthAccount: { accountUuid: ACCOUNT_UUID, emailAddress: EMAIL },
    mcpServers: { fake: { command: "fake-mcp", env: { API_TOKEN: MCP_VALUE } } } });
  return { codexShadow, claudeShadow };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-account-redaction-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  // Every line the server logs while the test runs.
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(format(...args)); });
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(format(...args)); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(format(...args)); });
  const human = hive.identity.getAgent("human");
  const project = hive.projects.createProject(human, { name: "Project", slug: "project", worktree: dir });
  const brain = hive.identity.join({ role: "brain", project: project.slug }).agent;
  const app = createApp(hive, { instanceSecret: SECRET });
  let nonceCounter = 0;
  const signed = (method: string, target: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = (nonceCounter++).toString(16).padStart(64, "0");
    return app.request(target, { method, headers: { "content-type": "application/json", "x-hivemind-timestamp": timestamp,
      "x-hivemind-nonce": nonce, "x-hivemind-signature": launcherSignature(SECRET, method, target, timestamp, nonce, Buffer.from(raw)) },
    ...(body === undefined ? {} : { body: raw }) });
  };
  const ui = (method: string, target: string, body?: unknown) => app.request(target, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { dir, hive, human, project, brain, logs, signed, ui };
}

const templateSpec = (software: string, accountId: string): WorkerTemplateSpec => ({ label: "Worker", description: "Task work",
  software, model: "gpt-6-sol", effort: "high", extraFlags: "", environment: { TASK_ENV: "safe" }, secretNames: [],
  seniority: "mid", focus: "tasks", maxConcurrent: 2, enabled: true, accountId });

test("planted secrets reach no answer, log line or stored row: usage post, Human routes, shadow launches", async t => {
  const f = fixture(t);
  const { codexShadow, claudeShadow } = plantHomes(f.dir);
  const answers: string[] = [];
  const answer = async (response: Response) => {
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  };

  const work = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex work", homePath: "", shadowPath: "" });
  const personal = f.hive.accounts.create(f.human, { driver: "codex", label: "Codex personal", homePath: "", shadowPath: codexShadow });
  const claude = f.hive.accounts.create(f.human, { driver: "claude", label: "Claude work", homePath: "", shadowPath: claudeShadow });

  // Payloads a broken probe could send: a planted value under an unknown key, inside a window, or in an oversized error.
  const snapshot = (accountId: string, patch: Record<string, unknown> = {}) => ({ accountId, capturedAt: Date.now(), source: "codex",
    plan: "subscription", windows: [{ key: "codex.primary", label: "5 h", usedPercent: 42, resetsAt: Date.now() + 3_600_000 }],
    error: null, limitErrorAt: null, ...patch });
  const broken = [
    { snapshots: [snapshot(claude.id, { source: "claude", email: EMAIL })] },
    { snapshots: [snapshot(work.id, { windows: [{ key: "codex.primary", label: "5 h", usedPercent: 1, resetsAt: null, token: ACCESS_TOKEN }] })] },
    { snapshots: [snapshot(work.id, { error: `Usage read failed ${ANTHROPIC_KEY} ${"x".repeat(200)}` })] },
  ];
  for (const body of broken) {
    const refused = await answer(await f.signed("POST", "/api/launcher/usage", body));
    assert.equal(refused.status, 400);
  }

  // The fixed answers Server.app's probe sends: good windows, a fixed error that keeps them, and a limit error.
  const posted = await answer(await f.signed("POST", "/api/launcher/usage", { snapshots: [
    snapshot(work.id),
    snapshot(personal.id, { windows: [], error: "Usage read failed" }),
    snapshot(claude.id, { source: "claude", windows: [{ key: "five_hour", label: "Session (5 h)", usedPercent: 23, resetsAt: Date.now() + 3_600_000 }],
      limitErrorAt: Date.now() - 60_000 }),
  ] }));
  assert.equal(posted.status, 200);

  const catalog = await answer(await f.signed("GET", "/api/launcher/accounts"));
  assert.equal(catalog.status, 200);
  const humanList = await answer(await f.ui("GET", "/api/ui/accounts"));
  assert.equal(humanList.status, 200);
  assert.equal(humanList.body.usage.length, 3, "the usage the Accounts sheet renders is stored");
  const resolved = await answer(await f.ui("POST", "/api/ui/accounts/resolve", { driver: "codex", record: true }));
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.selection.kind, "account");

  // A launch pinned to each shadow: the broker's command carries the account's own variables and nothing else.
  for (const [software, account, slug] of [["codex", personal, "codex-personal"], ["claude", claude, "claude-work"]] as const) {
    const template = f.hive.workerTemplates.create(f.human, f.project.id, { slug, spec: templateSpec(software, account.id) });
    const { agent, ticket } = f.hive.identity.reserve(f.human, template, "task", false);
    f.hive.launcherQueue.create({ requestId: randomUUID(), brain: f.brain, template, agent, ticket, approval: false });
    const next = await answer(await f.signed("GET", "/api/launcher/next?timeoutMs=0"));
    assert.equal(next.status, 200);
    assert.equal(next.body.command.kind, "launch");
    assert.deepEqual(next.body.command.account, toLaunchAccount(account));
    const settled = await answer(await f.signed("POST", `/api/launcher/${next.body.command.id}/result`,
      { status: "launched", session: next.body.command.session }));
    assert.equal(settled.status, 200);
  }

  // Three surfaces: every answer, every log line, and every row of every table (the journal included).
  const tables = listRows(f.hive, "sqlite_master", { where: { type: "table" }, columns: "name" }).map(row => String(row.name));
  const journal = JSON.stringify(snapshotTables(f.hive, tables));
  assert.ok(journal.includes("Codex personal"), "the scan reads the stored catalog");
  assert.ok(answers.join("\n").includes("Codex work"), "the scan reads the answers");
  const surfaces = { answers: answers.join("\n"), logs: f.logs.join("\n"), journal };
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const value of PLANTED) assert.ok(!text.includes(value), `a planted value reached the ${surface}`);
  }
});
