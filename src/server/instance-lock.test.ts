import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { childEnv } from "../test-support/child-process.ts";
import { Hive } from "./hive.ts";
import { INSTANCE_LOCK_FILE, InstanceLockError, acquireInstanceLock } from "./instance-lock.ts";
import { startServer } from "./serve.ts";

function home(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-instance-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLock(dir: string, pid: number) {
  writeFileSync(path.join(dir, INSTANCE_LOCK_FILE), JSON.stringify({ pid, token: "previous-run", startedAt: 1 }));
}

/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", env: childEnv() });
  return Number(child.stdout);
}

test("a second server on the same HIVEMIND_HOME fails fast; the home is free again after shutdown", async t => {
  const dir = home(t);
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => hive.close());
  const first = startServer({ port: 0, hive, telegram: false });
  await first.ready;
  const lock = JSON.parse(readFileSync(path.join(dir, INSTANCE_LOCK_FILE), "utf8")) as { pid: number };
  assert.equal(lock.pid, process.pid);

  assert.throws(() => startServer({ port: 0, hive, telegram: false }), (error: unknown) =>
    error instanceof InstanceLockError && error.message.includes(`pid ${process.pid}`) && error.message.includes(dir));
  const previous = process.env.HIVEMIND_HOME;
  process.env.HIVEMIND_HOME = dir;
  try {
    assert.throws(() => startServer({ port: 0, telegram: false }), InstanceLockError, "an owned Hive on the same home is refused too");
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_HOME;
    else process.env.HIVEMIND_HOME = previous;
  }

  await first.shutdown();
  assert.equal(existsSync(path.join(dir, INSTANCE_LOCK_FILE)), false);
  const second = startServer({ port: 0, hive, telegram: false });
  await second.ready;
  await second.shutdown();
});

test("servers on different homes run side by side", async t => {
  const hives = [home(t), home(t)].map(dir => new Hive(path.join(dir, "hive.db")));
  t.after(() => { for (const hive of hives) hive.close(); });
  const servers = hives.map(hive => startServer({ port: 0, hive, telegram: false }));
  await Promise.all(servers.map(server => server.ready));
  await Promise.all(servers.map(server => server.shutdown()));
});

test("a lock left by a crashed server is reclaimed", async t => {
  const dir = home(t);
  writeLock(dir, deadPid());
  const hive = new Hive(path.join(dir, "hive.db"));
  t.after(() => hive.close());
  const started = startServer({ port: 0, hive, telegram: false });
  await started.ready;
  const lock = JSON.parse(readFileSync(path.join(dir, INSTANCE_LOCK_FILE), "utf8")) as { pid: number; token: string };
  assert.equal(lock.pid, process.pid);
  assert.notEqual(lock.token, "previous-run");
  await started.shutdown();
});

test("a lock held by another live process is respected until that process exits", async t => {
  const dir = home(t);
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: childEnv() });
  const exited = new Promise(resolve => holder.once("exit", resolve));
  t.after(() => { holder.kill(); });
  writeLock(dir, holder.pid!);
  assert.throws(() => acquireInstanceLock(dir), (error: unknown) =>
    error instanceof InstanceLockError && error.message.includes(`pid ${holder.pid}`));
  holder.kill();
  await exited;
  const lock = acquireInstanceLock(dir);
  lock.release();
  assert.equal(existsSync(path.join(dir, INSTANCE_LOCK_FILE)), false);
});

test("a corrupt lock file is treated as stale; release never removes another owner's lock", t => {
  const dir = home(t);
  writeFileSync(path.join(dir, INSTANCE_LOCK_FILE), "{not json");
  const lock = acquireInstanceLock(dir);
  writeLock(dir, process.pid); // replaced behind our back
  lock.release();
  assert.equal(existsSync(path.join(dir, INSTANCE_LOCK_FILE)), true);
});
