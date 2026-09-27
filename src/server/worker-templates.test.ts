import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { Hive } from "./hive.ts";
import { HiveError } from "../shared/types.ts";
import { WORKER_TEMPLATE_LIMITS, type WorkerTemplate, type WorkerTemplateSpec } from "../shared/worker-templates.ts";

// Worker templates (Phase A1, #276): Human-only CRUD over HTTP. In-process only: no server or socket is started.

const spec = (patch: Partial<WorkerTemplateSpec> = {}): WorkerTemplateSpec => ({
  label: "Codex senior", description: "Backend and API work that needs care.", software: "codex2", model: "gpt-6-sol",
  effort: "high", extraFlags: "", environment: { OPENCODE_DISABLE_FFF: "1" }, secretNames: ["OPENCODE_API_KEY"],
  seniority: "senior", focus: "backend", maxConcurrent: 2, enabled: true, ...patch,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-worker-templates-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(url, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  const events: string[] = [];
  hive.bus.on("worker-templates", event => events.push(event.projectId));
  const project = hive.projects.listProjects()[0]!;
  return { hive, call, events, project };
}

test("Human creates, lists, edits and deletes a project's templates, with revisions", async t => {
  const { call, events, project } = fixture(t);
  const created = await call("POST", `/api/ui/projects/${project.slug}/worker-templates`, { slug: "codex-senior", spec: spec() });
  assert.equal(created.status, 201);
  const template = created.json as WorkerTemplate;
  assert.equal(template.revision, 1);
  assert.equal(template.projectId, project.id);
  assert.deepEqual(template.spec, spec());

  const listed = await call("GET", `/api/ui/projects/${project.id}/worker-templates`);
  assert.deepEqual(listed.json.templates, [template]);

  const edited = await call("PUT", `/api/ui/worker-templates/${template.id}`,
    { expectedRevision: 1, slug: "codex-review", spec: spec({ maxConcurrent: 4 }) });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.revision, 2);
  assert.equal(edited.json.slug, "codex-review");
  assert.equal(edited.json.spec.maxConcurrent, 4);

  const stale = await call("PUT", `/api/ui/worker-templates/${template.id}`, { expectedRevision: 1, spec: spec() });
  assert.equal(stale.status, 409);
  assert.equal((await call("DELETE", `/api/ui/worker-templates/${template.id}?revision=1`)).status, 409);
  assert.equal((await call("DELETE", `/api/ui/worker-templates/${template.id}?revision=2`)).status, 200);
  assert.deepEqual((await call("GET", `/api/ui/projects/${project.slug}/worker-templates`)).json.templates, []);
  assert.deepEqual(events, [project.id, project.id, project.id], "one event per committed change");
});

test("invalid templates are refused with the field and reason, never the value", async t => {
  const { call, project } = fixture(t);
  const url = `/api/ui/projects/${project.slug}/worker-templates`;
  const cases: Array<[unknown, RegExp]> = [
    [{ slug: "Bad Slug", spec: spec() }, /slug/],
    [{ slug: "a", spec: spec({ software: "codex; rm -rf ~" }) }, /spec\.software: Software must be one command/],
    [{ slug: "a", spec: spec({ extraFlags: "--x $(whoami)" }) }, /spec\.extraFlags: CLI flags cannot include shell metacharacters/],
    [{ slug: "a", spec: spec({ environment: { PATH: "/tmp" } }) }, /spec\.environment: .*PATH belongs to the shell/],
    [{ slug: "a", spec: spec({ secretNames: ["HIVEMIND_TOKEN"] }) }, /spec\.secretNames: HIVEMIND_TOKEN/],
    [{ slug: "a", spec: spec({ secretNames: ["TOKEN", "token"] }) }, /named twice/],
    [{ slug: "a", spec: spec({ environment: { TOKEN: "x" }, secretNames: ["TOKEN"] }) }, /both a secret and an environment variable/],
    [{ slug: "a", spec: spec({ maxConcurrent: 0 }) }, /spec\.maxConcurrent/],
    [{ slug: "a", spec: { ...spec(), secrets: { OPENCODE_API_KEY: "sk-live-secret" } } }, /spec/],
  ];
  for (const [body, message] of cases) {
    const refused = await call("POST", url, body);
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(refused.json.error, message);
    assert.doesNotMatch(refused.json.error, /rm -rf|whoami|sk-live-secret|\/tmp/, "values are never echoed");
  }
});

test("slugs are unique per project and a project has a bounded number of templates", async t => {
  const { hive, call, project } = fixture(t);
  const url = `/api/ui/projects/${project.slug}/worker-templates`;
  assert.equal((await call("POST", url, { slug: "one", spec: spec() })).status, 201);
  assert.equal((await call("POST", url, { slug: "one", spec: spec() })).status, 409);
  const other = hive.projects.createProject(hive.identity.getAgent("human"), { name: "Beta", slug: "beta" });
  assert.equal((await call("POST", `/api/ui/projects/${other.slug}/worker-templates`, { slug: "one", spec: spec() })).status, 201);
  for (let i = 1; i < WORKER_TEMPLATE_LIMITS.perProject; i++) assert.equal((await call("POST", url, { slug: `t${i}`, spec: spec() })).status, 201);
  assert.equal((await call("POST", url, { slug: "overflow", spec: spec() })).status, 429);
});

test("only Human manages templates, and deleting a project deletes its templates", async t => {
  const { hive, project } = fixture(t);
  const human = hive.identity.getAgent("human");
  const brain = hive.identity.join({ role: "brain" }).agent;
  const isForbidden = (error: unknown) => error instanceof HiveError && error.status === 403;
  assert.throws(() => hive.workerTemplates.create(brain, project.id, { slug: "x", spec: spec() }), isForbidden);
  const other = hive.projects.createProject(human, { name: "Gamma", slug: "gamma" });
  hive.workerTemplates.create(human, other.id, { slug: "x", spec: spec() });
  hive.projects.deleteProject(human, other.slug);
  assert.deepEqual(hive.workerTemplates.list(other.id), []);
});
