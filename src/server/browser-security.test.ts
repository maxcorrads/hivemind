import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer as createViteServer } from "vite";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";
import { registerPlugin, projectPlugins } from "./plugins.ts";

// Uses the runner's installed Chrome/ChromeDriver through the standard WebDriver
// protocol: no downloaded browsers, npm dependencies, or browser-security flags.
async function browser(t: TestContext, executable: string) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "hive-browser-profile-"));
  const child = spawn(executable, ["--port=0"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let driver = "";
  let session = "";
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  async function command(method: string, target: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(`${driver}${target}`, {
        method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      const result = await response.json() as { value: any };
      assert.ok(response.ok, `WebDriver ${target}: ${result.value?.error ?? response.status}`);
      return result.value;
    } finally {
      clearTimeout(deadline);
    }
  }
  t.after(async () => {
    try {
      if (session) await command("DELETE", `/session/${session}`);
    } finally {
      kill("SIGTERM");
      const deadline = setTimeout(() => kill("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(deadline); rmSync(profile, { recursive: true, force: true }); }
    }
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => { cleanup(); reject(new Error("ChromeDriver startup deadline")); }, 15_000);
    const cleanup = () => {
      clearTimeout(deadline);
      child.stdout.off("data", data);
      child.stderr.off("data", data);
      child.off("error", error);
      child.off("exit", exit);
    };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const exit = () => error(new Error("ChromeDriver exited during startup"));
    const data = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-8192);
      const match = /ChromeDriver was started successfully on port (\d+)/.exec(output);
      if (match) { cleanup(); resolve(match[1]); }
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("error", error);
    child.once("exit", exit);
  });
  // Drain process pipes without retaining potentially sensitive browser output.
  child.stdout.resume();
  child.stderr.resume();
  driver = `http://127.0.0.1:${port}`;
  const created = await command("POST", "/session", {
    capabilities: { alwaysMatch: {
      browserName: "chrome",
      "goog:chromeOptions": { args: ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`] },
    } },
  });
  session = created.sessionId;
  assert.equal(typeof session, "string");
  t.diagnostic(`Browser acceptance: Chrome ${created.capabilities.browserVersion}`);
  const request = (method: string, target: string, body?: unknown) => command(method, `/session/${session}${target}`, body);
  await request("POST", "/timeouts", { script: 25_000, pageLoad: 25_000 });
  return {
    request,
    async evaluate(script: string): Promise<any> {
      const result = await request("POST", "/execute/async", {
        script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(value => done({ ok: true, value }), error => done({ ok: false, error: String(error) }));`, args: [],
      });
      assert.equal(result.ok, true, result.error);
      return result.value;
    },
    async tab(url: string) {
      const { handle } = await request("POST", "/window/new", { type: "tab" });
      await request("POST", "/window", { handle });
      await request("POST", "/url", { url });
      return handle as string;
    },
    select: (handle: string) => request("POST", "/window", { handle }),
  };
}

async function instance(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hive-browser-server-"));
  const pkg = path.join(home, "browser-plugin"); mkdirSync(pkg);
  const manifest = path.join(pkg, "hivemind-plugin.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, id: "browser-fixture", name: "Browser Fixture",
    command: "tool", instructions: "TOOLS.md", settings: "settings.json" }));
  writeFileSync(path.join(pkg, "TOOLS.md"), "Use {{command}} only for this project.");
  writeFileSync(path.join(pkg, "settings.json"), JSON.stringify({ version: 1,
    fields: [{ key: "host", label: "Host", type: "string", required: true }] }));
  writeFileSync(path.join(pkg, "tool"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] !== 'configure' || process.argv[3] !== '--home') process.exit(3);
const home = process.argv[4]; let text = '';
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
  const count = path.join(home, 'executions');
  fs.writeFileSync(count, String((fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) + 1));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(JSON.parse(text).config));
  console.log(JSON.stringify({ configured: true }));
});
`, { mode: 0o700 });
  registerPlugin(home, manifest);
  const db = path.join(home, "hive.db");
  let hive = new Hive(db);
  let server = startServer({ port: 0, hive, telegram: false });
  t.after(async () => { await server.shutdown(); hive.db.close(); rmSync(home, { recursive: true, force: true }); });
  const port = await server.ready;
  const base = `http://127.0.0.1:${port}`;
  // Read the actual Vite config, overriding only ephemeral ports/targets and
  // adding a test document which imports the real production web/api.ts.
  const vite = await createViteServer({
    logLevel: "silent",
    server: { port: 0, strictPort: false, proxy: { "^/api(?:[/?]|$)": { target: base }, "/ws": { target: base.replace("http", "ws") } } },
    plugins: [{ name: "human-security-test-document", configureServer(dev) {
      dev.middlewares.use((req, res, next) => {
        if (req.url !== "/__human_security_test__") return next();
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>Human security browser acceptance</title>");
      });
    } }],
  });
  t.after(() => vite.close());
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  return {
    base, port, page: `http://127.0.0.1:${address.port}/__human_security_test__`,
    get hive() { return hive; },
    profile() { return projectPlugins(home, hive.listProjects()[0]!)[0]!; },
    executions() {
      const file = path.join(projectPlugins(home, hive.listProjects()[0]!)[0]!.home, "executions");
      return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
    },
    async restart() {
      await server.shutdown();
      hive.db.close();
      hive = new Hive(db);
      server = startServer({ port, hive, telegram: false });
      assert.equal(await server.ready, port);
    },
  };
}

const initializeTab = `
  window.client = await import('/api.ts');
  window.liveCount = 0;
  window.liveWaiters = [];
  window.untilLive = count => new Promise(resolve => {
    if (window.liveCount >= count) resolve();
    else window.liveWaiters.push({ count, resolve });
  });
  window.stop = window.client.connectWs(() => {}, live => {
    if (!live) return;
    window.liveCount++;
    window.liveWaiters = window.liveWaiters.filter(waiter => {
      if (window.liveCount < waiter.count) return true;
      waiter.resolve(); return false;
    });
  });
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => window.client.api.snapshot()));
  await window.untilLive(1);
  return { human: snapshots.every(snapshot => snapshot.you.name === 'Human'), visibleCookies: document.cookie };
`;

test("Chrome: real cookies isolate tabs/instances, reject cross-origin attacks, and recover after restart", { timeout: 90_000 }, async (t) => {
  const executable = process.env.CHROMEWEBDRIVER ? path.join(process.env.CHROMEWEBDRIVER, "chromedriver") : "";
  if (!executable || !existsSync(executable)) {
    assert.notEqual(process.env.GITHUB_ACTIONS, "true", "CI must provide its installed ChromeDriver; browser acceptance must not silently skip");
    t.skip("Set CHROMEWEBDRIVER to the directory containing a matching installed ChromeDriver to run browser acceptance locally");
    return;
  }
  // Register browser teardown first: close its tabs before fixtures drain.
  const chrome = await browser(t, executable);
  const a = await instance(t);
  const b = await instance(t);
  const tabA = await chrome.tab(a.page);
  assert.deepEqual(await chrome.evaluate(initializeTab), { human: true, visibleCookies: "" });
  const tabB = await chrome.tab(b.page);
  assert.deepEqual(await chrome.evaluate(initializeTab), { human: true, visibleCookies: "" });
  const tabA2 = await chrome.tab(a.page);
  assert.deepEqual(await chrome.evaluate(initializeTab), { human: true, visibleCookies: "" });
  const cookies = await chrome.request("GET", "/cookie") as Array<{ name: string; value: string; httpOnly: boolean; sameSite: string }>;
  const names = [`hivemind_human_${a.port}`, `hivemind_human_${b.port}`].sort();
  assert.deepEqual(cookies.map(cookie => cookie.name).sort(), names);
  assert.ok(cookies.every(cookie => cookie.httpOnly && cookie.sameSite === "Strict"));

  await chrome.select(tabB);
  const native = a.hive.join({ role: "worker", seniority: "mid" });
  const identities = () => a.hive.db.prepare("SELECT id, token_hash FROM agents ORDER BY id").all();
  const victim = a.hive.createBot(a.hive.getAgent("human"), "chapter", { name: "BrowserVictim" });
  const before = identities();
  const victimPath = `/api/ui/projects/chapter/bots/${victim.bot.id}/credential`;
  for (const action of ["rotate", "revoke"]) {
    await chrome.evaluate(`
      await fetch(${JSON.stringify(`${a.base}${victimPath}`)}, {
        method: 'POST', mode: 'no-cors', credentials: 'include',
        headers: { 'content-type': 'text/plain' },
        body: ${JSON.stringify(JSON.stringify({ action, expectedRevision: 1 }))}
      }).catch(() => {});
      return true;
    `);
    assert.equal(JSON.stringify(identities()) === JSON.stringify(before), true);
    assert.equal(a.hive.botCredential(a.hive.getAgent("human"), "chapter", victim.bot.id).credential.revision, 1);
  }
  await chrome.evaluate(`
    await fetch(${JSON.stringify(`${a.base}/api/ui/projects/chapter/plugins/browser-fixture`)}, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, values: { host: 'hostile' }, expectedRevision: 0 })
    }).catch(() => {});
    return true;
  `);
  assert.equal(a.executions(), 0); assert.equal(a.profile().revision, 0);
  for (const body of [{ role: "brain" }, { resume: native.agent.name, project: "chapter" }]) {
    await chrome.evaluate(`
      await fetch(${JSON.stringify(`${a.base}/api/agent/join`)}, {
        method: 'POST', mode: 'no-cors', credentials: 'include',
        headers: { 'content-type': 'text/plain' }, body: ${JSON.stringify(JSON.stringify(body))}
      }).catch(() => {});
      return true;
    `);
    assert.deepEqual(identities(), before);
  }
  assert.equal(await chrome.evaluate(`
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(${JSON.stringify(`${a.base.replace("http", "ws")}/ws`)});
      const deadline = setTimeout(() => { ws.close(); reject(new Error('Hostile WebSocket did not settle')); }, 5000);
      const done = blocked => { clearTimeout(deadline); ws.onopen = ws.onerror = null; ws.close(); resolve(blocked); };
      ws.onopen = () => done(false);
      ws.onerror = () => done(true);
    });
  `), true);

  // No injected Cookie/Origin headers: the browser supplies all real metadata.
  await chrome.select(tabA);
  assert.deepEqual(await chrome.evaluate(`
    const file = new File(['browser upload'], 'browser.txt', { type: 'text/plain' });
    const uploaded = await window.client.api.upload(file);
    const response = await fetch(window.client.api.fileUrl(uploaded.id));
    return { status: response.status, body: await response.text() };
  `), { status: 200, body: "browser upload" });
  assert.deepEqual(await chrome.evaluate(`
    window.browserBot = await window.client.api.createBot('chapter', 'BrowserFeed');
    const configured = await window.client.api.saveProjectPlugin('chapter', 'browser-fixture', {
      enabled: true, values: { host: 'browser-before-restart' }, expectedRevision: 0
    });
    const rotated = await window.client.api.changeBotCredential('chapter', window.browserBot.bot.id, 'rotate', 1);
    const state = await window.client.api.botCredential('chapter', window.browserBot.bot.id);
    return { revision: state.credential.revision, tokenHidden: !('token' in state),
      changed: rotated.token !== window.browserBot.token, configured: configured.plugin.revision };
  `), { revision: 2, tokenHidden: true, changed: true, configured: 1 });
  assert.equal(a.executions(), 1); assert.equal(b.executions(), 0);
  await a.restart();
  assert.equal(await chrome.evaluate(`
    await Promise.all([
      window.client.api.createProject('After restart', 'after-restart'),
      window.client.api.changeBotCredential('chapter', window.browserBot.bot.id, 'revoke', 2),
      window.client.api.saveProjectPlugin('chapter', 'browser-fixture', {
        enabled: true, values: { host: 'browser-after-restart' }, expectedRevision: 1
      })
    ]);
    await window.untilLive(2);
    return (await window.client.api.snapshot()).you.name;
  `), "Human");
  assert.equal(a.hive.listProjects().filter(project => project.slug === "after-restart").length, 1);
  const browserBot = a.hive.listAgents(a.hive.getAgent("human")).find(agent => agent.name === "BrowserFeed")!;
  assert.deepEqual(a.hive.botCredential(a.hive.getAgent("human"), "chapter", browserBot.id).credential, { revision: 3, revoked: true });
  assert.equal(a.executions(), 2); assert.equal(a.profile().revision, 2);
  assert.equal(a.profile().values.host, "browser-after-restart");
  assert.equal(b.executions(), 0); assert.equal(b.profile().revision, 0);
  await chrome.select(tabA2);
  assert.equal(await chrome.evaluate(`await window.untilLive(2); return (await window.client.api.snapshot()).you.name;`), "Human");
  await chrome.select(tabB);
  assert.equal(await chrome.evaluate(`return (await window.client.api.snapshot()).you.name;`), "Human");
  assert.equal(await chrome.evaluate("return window.liveCount;"), 1);
  const after = await chrome.request("GET", "/cookie") as typeof cookies;
  assert.deepEqual(after.map(cookie => cookie.name).sort(), names);
  assert.ok(after.find(cookie => cookie.name === names.find(name => name.endsWith(`_${a.port}`)))?.value !==
    cookies.find(cookie => cookie.name.endsWith(`_${a.port}`))?.value);
  assert.ok(after.find(cookie => cookie.name.endsWith(`_${b.port}`))?.value ===
    cookies.find(cookie => cookie.name.endsWith(`_${b.port}`))?.value);
});
