import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEnv, stopChild, stopProcessGroup } from "./child-process.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function coverageDir(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-child-coverage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const writers = (dir: string) => readdirSync(dir).map((name) => Number(/^coverage-(\d+)-/.exec(name)?.[1])).sort();

// Plays the part of a test process running under the coverage runner: it has
// NODE_V8_COVERAGE set to `dir` and starts two children of its own.
const intermediary = String.raw`
const { spawnSync } = require("node:child_process");
const pid = (env) =>
  // child-env: exempt (this is the fixture that shows an unguarded child)
  Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { env, encoding: "utf8" }).stdout);
console.log(JSON.stringify({ self: process.pid, whitelisted: pid({ PATH: process.env.PATH }), guarded: pid(JSON.parse(process.argv[1])) }));
`;

test("childEnv keeps a child out of the runner's V8 coverage directory; a whitelist alone does not", (t) => {
  const dir = coverageDir(t);
  const result = spawnSync(process.execPath, ["-e", intermediary, JSON.stringify(childEnv({ PATH: process.env.PATH }))], {
    encoding: "utf8", env: childEnv({ PATH: process.env.PATH }, { coverageDir: dir }),
  });
  assert.equal(result.status, 0, result.stderr);
  const pids = JSON.parse(result.stdout) as { self: number; whitelisted: number; guarded: number };
  // child_process copies NODE_V8_COVERAGE into an env option that lacks the key.
  assert.deepEqual(writers(dir), [pids.self, pids.whitelisted].sort());
  assert.ok(!writers(dir).includes(pids.guarded));
});

test("the run-tests preload keeps descendants of a test process out of the coverage directory", (t) => {
  const dir = coverageDir(t);
  const preload = pathToFileURL(path.join(root, "scripts/isolate-test-coverage.mjs")).href;
  const script = String.raw`
    const { spawnSync } = require("node:child_process");
    // child-env: exempt (inherits process.env after the preload removed the coverage directory)
    const child = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout);
    console.log(JSON.stringify({ self: process.pid, child }));
  `;
  const result = spawnSync(process.execPath, ["--import", preload, "-e", script], {
    encoding: "utf8", env: childEnv({ PATH: process.env.PATH, NODE_TEST_CONTEXT: "child-v8" }, { coverageDir: dir }),
  });
  assert.equal(result.status, 0, result.stderr);
  const pids = JSON.parse(result.stdout) as { self: number; child: number };
  // The test process itself still reports coverage; its descendants do not.
  assert.deepEqual(writers(dir), [pids.self]);
});

test("childEnv refuses to opt a child into the runner's own coverage directory", (t) => {
  const saved = process.env.NODE_V8_COVERAGE;
  t.after(() => {
    if (saved === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = saved;
  });
  process.env.NODE_V8_COVERAGE = path.join(os.tmpdir(), "runner-coverage");
  assert.throws(() => childEnv(process.env, { coverageDir: process.env.NODE_V8_COVERAGE }), /runner's coverage directory/);
  assert.equal(childEnv({ A: "1", B: undefined }).NODE_V8_COVERAGE, "");
  assert.deepEqual(Object.keys(childEnv({ A: "1", B: undefined })).sort(), ["A", "NODE_V8_COVERAGE"]);
});

const ready = async (child: ReturnType<typeof spawn>) => {
  await once(child.stdout!, "data");
};

test("stopChild lets a child exit on SIGTERM and only SIGKILLs one that ignores it", async () => {
  const graceful = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => setTimeout(() => { console.log("flushed"); process.exit(0); }, 100));
    console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
  await ready(graceful);
  let output = "";
  graceful.stdout.on("data", (chunk: Buffer) => { output += String(chunk); });
  await stopChild(graceful, { graceMs: 5_000 });
  assert.equal(graceful.exitCode, 0);
  assert.match(output, /flushed/);

  const stubborn = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`],
  { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
  await ready(stubborn);
  const started = performance.now();
  await stopChild(stubborn, { graceMs: 200 });
  assert.equal(stubborn.signalCode, "SIGKILL");
  assert.ok(performance.now() - started >= 150);
  await stopChild(stubborn); // already exited: no-op
});

test("stopProcessGroup waits for the whole group before SIGKILLing survivors", {
  skip: process.platform === "win32" && "POSIX process groups",
}, async () => {
  // The leader exits on SIGTERM; its member ignores SIGTERM and must be killed.
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    // child-env: exempt (inherits the leader's env, which comes from childEnv())
    const member = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("member"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "inherit", "ignore"] });
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: childEnv() });
  await ready(leader);
  const closed = once(leader, "close");
  const pid = leader.pid!;
  await stopProcessGroup(pid, closed, { graceMs: 300 });
  await closed;
  const until = performance.now() + 5_000;
  const alive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      // EPERM is not proof that the group disappeared. Wait for ESRCH before testing
      // the already-gone no-op; never mask an actual signalling denial.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw error;
    }
  };
  while (alive() && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "a group member survived");
  await stopProcessGroup(pid, Promise.resolve()); // already gone: no-op
});
