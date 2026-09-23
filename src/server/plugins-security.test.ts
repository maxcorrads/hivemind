import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hive } from "./hive.ts";
import { readValue } from "./test-fixtures.ts";
import { createApp } from "./app.ts";
import { configurePlugin, launchContext, projectPlugins, registerPlugin, saveProjectPlugin } from "./plugins.ts";
import { preparePrivateDatabase } from "./private-database.ts";
import { PLUGIN_REQUEST_BYTES } from "./ingress.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-plugin-security-"));
  const home = path.join(dir, "hive"), pkg = path.join(dir, "package");
  mkdirSync(pkg);
  const tool = path.join(pkg, "tool");
  const manifest = path.join(pkg, "hivemind-plugin.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, id: "safe-tool", name: "Safe Tool", command: "tool", instructions: "TOOLS.md", settings: "settings.json" }));
  writeFileSync(path.join(pkg, "TOOLS.md"), "Use {{command}} only for Human-assigned work.");
  writeFileSync(path.join(pkg, "settings.json"), JSON.stringify({ version: 1, fields: [{ key: "label", label: "Label", type: "string" }] }));
  const install = (source: string) => writeFileSync(tool, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  install('console.log(JSON.stringify({configured:false}));process.exit(1);');
  const hive = new Hive(path.join(home, "hive.db"));
  t.after(() => { hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  registerPlugin(home, manifest);
  const project = hive.listProjects()[0]!;
  return { dir, home, pkg, tool, manifest, install, hive, project };
}
const goodConfigure = `const fs=require('node:fs'),path=require('node:path');let body='';process.stdin.on('data',d=>body+=d);process.stdin.on('end',()=>{const request=JSON.parse(body);fs.writeFileSync(path.join(process.argv[4],'config.json'),JSON.stringify(request.config));console.log(JSON.stringify({configured:true}));});`;
const change = { enabled: true, values: { label: "ordinary" }, expectedRevision: 0 };

test("configure receipts never return provider secrets, and subsequent configuration can recover", async t => {
  const f = fixture(t), app = createApp(f.hive);
  const secret = "fixture-provider-credential-not-for-ui";
  f.install(`console.log(JSON.stringify({configured:false,error:${JSON.stringify(secret)}}));process.exit(2);`);
  const response = await app.request(`/api/ui/projects/${f.project.slug}/plugins/safe-tool`, { method: "PUT", body: JSON.stringify(change) });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.match(text, /Plugin rejected configuration/);
  assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
  assert.equal(projectPlugins(f.home, f.project)[0]!.configured, false);
  f.install(goodConfigure);
  const saved = await saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", change);
  assert.equal(saved.revision, 1);
  assert.deepEqual(readdirSync(f.home).filter(name => name.endsWith(".next") || name.endsWith(".lock")), []);
});

test("configuration gets an explicit profile/cwd but no inherited service credentials or Node injection", async t => {
  const f = fixture(t);
  const keys = ["HIVEMIND_TOKEN", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS"];
  const before = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, n) => { if (before[n] === undefined) delete process.env[key]; else process.env[key] = before[n]; }));
  process.env.HIVEMIND_TOKEN = "fixture-hive-secret";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-cloud-secret";
  process.env.NODE_OPTIONS = "--definitely-not-a-real-node-option";
  f.install(`const keys=${JSON.stringify(keys)};if(keys.some(k=>k in process.env)||process.cwd()!==process.argv[4])process.exit(4);${goodConfigure}`);
  const saved = await saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", change);
  assert.equal(saved.configured, true);
  const persisted = readFileSync(path.join(saved.home, "config.json"), "utf8");
  assert.equal(persisted.includes("fixture-hive-secret"), false);
  assert.equal(persisted.includes("fixture-cloud-secret"), false);
  assert.equal(statSync(saved.home).mode & 0o777, 0o700);
});

test("configure deadline kills the child and releases its timer without real sleeps", async t => {
  const f = fixture(t);
  f.install('setInterval(()=>{},1000);');
  const profile = path.join(f.home, "timeout-profile"); mkdirSync(profile);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outcome = assert.rejects(configurePlugin(f.tool, profile, {}), /Plugin rejected configuration/);
  t.mock.timers.tick(15000);
  await outcome;
  assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
});

test("configure cannot strand a process on unserializable input or a missing executable", async t => {
  const f = fixture(t), cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(configurePlugin(f.tool, f.home, cycle));
  await assert.rejects(configurePlugin(path.join(f.pkg, "missing"), f.home, {}), /Could not run/);
});

test("HTTP plugin budgets and unknown identities never execute installed code", async t => {
  const f = fixture(t), app = createApp(f.hive);
  const marker = path.join(f.home, "executed");
  f.install(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exit(1);`);
  const endpoint = `/api/ui/projects/${f.project.slug}/plugins/safe-tool`;
  for (const [url, body, status] of [
    [endpoint, "x".repeat(PLUGIN_REQUEST_BYTES + 1), 413],
    [endpoint, '{"secret":"fixture-private",', 400],
    [`/api/ui/projects/${f.project.slug}/plugins/unknown`, JSON.stringify(change), 400],
    ["/api/ui/projects/unknown/plugins/safe-tool", JSON.stringify(change), 404],
  ] as const) {
    const response = await app.request(url, { method: "PUT", body });
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes("fixture-private"), false);
    assert.equal(existsSync(marker), false);
  }
});

test("malformed retained JSON cannot leak source fragments into launch instructions or settings", async t => {
  const f = fixture(t);
  f.install(goodConfigure);
  const saved = await saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", change);
  writeFileSync(path.join(saved.home, "config.json"), '{"secret":"fixture-source-secret",');
  const context = launchContext(f.home, "http://localhost", f.project);
  assert.ok(context.pluginError);
  assert.equal(JSON.stringify(context).includes("fixture-source-secret"), false);
  assert.equal(JSON.stringify(projectPlugins(f.home, f.project)).includes("fixture-source-secret"), false);
  writeFileSync(path.join(saved.home, "config.json"), JSON.stringify({ hiveUrl: "http://localhost", "fixture-unknown-secret-key": "private" }));
  assert.equal(JSON.stringify(projectPlugins(f.home, f.project)).includes("fixture-unknown-secret-key"), false);
});

test("SQLite credentials and existing sidecars are private; symlink targets are untouched", t => {
  const f = fixture(t), file = path.join(f.home, "private-test.db");
  for (const suffix of ["", "-wal", "-shm"]) { writeFileSync(file + suffix, "fixture"); chmodSync(file + suffix, 0o644); }
  preparePrivateDatabase(file);
  for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(file + suffix).mode & 0o777, 0o600);
  preparePrivateDatabase(":memory:");
  const target = path.join(f.dir, "do-not-touch"); writeFileSync(target, "unchanged", { mode: 0o644 });
  const alias = path.join(f.home, "linked.db"); symlinkSync(target, alias);
  assert.throws(() => preparePrivateDatabase(alias));
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("new bot uploads create private files and never retain plaintext credentials", async t => {
  const f = fixture(t), human = f.hive.getAgent("human");
  const bot = f.hive.createBot(human, f.project.id, { name: "UploadSource" });
  const file = await f.hive.createFile(bot.bot, { name: "source.txt", mime: "text/plain", body: new Blob(["ordinary source"]).stream() });
  const sha256 = readValue(f.hive, "attachments", "sha256", { id: file.id });
  assert.equal(statSync(path.join(f.home, "files", String(sha256))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(file).includes(bot.token), false);
  assert.equal(readdirSync(path.join(f.home, "files")).some(name => name.startsWith("part-")), false);
});


test("plugin admission bounds queued saves, preserves revision fencing, and recovers after rejection", async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const configure = async (_executable: string, profile: string, raw: unknown) => {
    calls++;
    entered();
    await gate;
    writeFileSync(path.join(profile, "config.json"), JSON.stringify((raw as { config: unknown }).config));
  };
  const pending = Array.from({ length: 8 }, () => saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", change, configure));
  const results = Promise.allSettled(pending);
  try {
    await started;
    assert.equal(existsSync(path.join(f.home, "plugins.lock")), true);
    await assert.rejects(saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", change, configure),
      (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 429);
  } finally { release(); await results; }
  const settled = await results;
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter(item => item.status === "rejected").length, 7);
  assert.equal(calls, 1, "Stale queued revisions must not run a command");
  assert.equal(existsSync(path.join(f.home, "plugins.lock")), false);
  const next = await saveProjectPlugin(f.home, f.project, "http://localhost", "safe-tool", { ...change, expectedRevision: 1 }, configure);
  assert.equal(next.revision, 2);
});
