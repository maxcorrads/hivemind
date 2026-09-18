import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: { dev: string };
};
const dependencyRoot = path.join(root, "node_modules/concurrently");
const dependency = JSON.parse(readFileSync(path.join(dependencyRoot, "package.json"), "utf8")) as {
  bin: { concurrently: string };
};
const cli = path.join(dependencyRoot, dependency.bin.concurrently);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 8_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-concurrently-"));
  const processes: Array<{ pid: number; closed: Promise<Exit> }> = [];
  t.after(async () => {
    try {
      await Promise.all(processes.map(async ({ pid, closed }) => {
        // Only this test's detached process group. A failing assertion must not
        // leave watchers or grandchildren alive. Success is checked before this.
        try { process.kill(-pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await deadline(closed, "subprocess cleanup");
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    dir,
    start(args: string[], cwd = dir) {
      const child = spawn(process.execPath, args, {
        cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env, FORCE_COLOR: "0", NO_COLOR: "1",
          HIVEMIND_HOME: path.join(dir, "home"), HIVEMIND_PORT: "0", HIVEMIND_TOKEN: "",
        },
      });
      const updates = new EventEmitter();
      let output = "";
      let failure: Error | undefined;
      let exited = false;
      const consume = (chunk: Buffer) => {
        output = (output + stripVTControlCharacters(String(chunk))).slice(-32_000);
        updates.emit("update");
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", (error) => { failure = error; updates.emit("update"); });
      const closed = new Promise<Exit>((resolve) => {
        child.once("close", (code, signal) => {
          exited = true;
          updates.emit("update");
          resolve({ code, signal });
        });
      });
      assert.ok(child.pid, "subprocess did not acquire a PID");
      const pid = child.pid;
      processes.push({ pid, closed });
      const wait = (pattern: RegExp): Promise<RegExpExecArray> => new Promise((resolve, reject) => {
        const cleanup = () => {
          updates.off("update", inspect);
          t.signal.removeEventListener("abort", abort);
        };
        const abort = () => { cleanup(); reject(new Error(`aborted waiting for ${pattern}: ${output}`)); };
        const inspect = () => {
          const match = pattern.exec(output);
          if (match) { cleanup(); resolve(match); }
          else if (failure || exited) {
            cleanup(); reject(failure ?? new Error(`exited before ${pattern}: ${output}`));
          }
        };
        updates.on("update", inspect);
        t.signal.addEventListener("abort", abort, { once: true });
        if (t.signal.aborted) abort();
        else inspect();
      });
      return { pid, closed, wait, output: () => output };
    },
  };
}

async function assertPortReleased(port: number) {
  const probe = createServer();
  try {
    const listening = once(probe, "listening");
    probe.listen(port, "127.0.0.1");
    await listening;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

function assertGroupStopped(pid: number) {
  // Ignore already-dead zombies while the OS reaps them. Never kill or inspect
  // command lines outside the process group created by this test.
  const members = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" })
    .trim().split("\n").map((line) => line.trim().split(/\s+/))
    .filter((fields) => Number(fields[1]) === pid && !fields[2]?.startsWith("Z"));
  assert.deepEqual(members, [], "a live process survived in the dev process group");
}

const workerSource = String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const label = process.argv[2];
if (label === "leader") {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild"], { stdio: "inherit" });
}
let stopping = false;
const server = createServer((req, res) => {
  if (req.url === "/fail") {
    res.once("finish", () => process.exit(7));
    res.end("failure");
  } else res.end("ready");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close(() => {
      process.stdout.write("STOP " + label + " " + signal + "\n", () => process.exit(0));
    });
  });
}
server.listen(0, "127.0.0.1", () => {
  console.log("READY " + label + " " + server.address().port);
});
`;

for (const mode of ["failure", "SIGINT", "SIGTERM"] as const) {
  test(`concurrently CLI ${mode} terminates siblings and grandchildren`, {
    timeout: 30_000, skip: process.platform === "win32" && "POSIX signal/process-group contract",
  }, async (t) => {
    const work = fixture(t);
    const worker = path.join(work.dir, "worker.mjs");
    writeFileSync(worker, workerSource);
    const command = `${shellQuote(process.execPath)} ${shellQuote(worker)}`;
    // These are the flags used by the production dev script, not the JS API.
    assert.ok(manifest.scripts.dev.startsWith("concurrently -k -n hive,ui -c yellow,cyan "));
    const child = work.start([cli, "-k", "-n", "hive,ui", "-c", "yellow,cyan", `${command} leader`, `${command} failer`]);
    const ready = await Promise.all(["leader", "grandchild", "failer"].map(
      (label) => child.wait(new RegExp(`READY ${label} (\\d+)`)),
    ));
    const ports = ready.map((match) => Number(match[1]));
    if (mode === "failure") {
      const response = await fetch(`http://127.0.0.1:${ports[2]}/fail`, { signal: t.signal });
      assert.equal(await response.text(), "failure");
    } else {
      // Signal only the CLI: concurrently must forward it to its own children.
      process.kill(child.pid, mode);
    }
    const exit = await deadline(child.closed, `concurrently ${mode}: ${child.output()}`);
    if (mode === "failure") assert.notEqual(exit.code, 0, "failure became a successful command");
    const expectedSignal = mode === "failure" ? "SIGTERM" : mode;
    assert.match(child.output(), new RegExp(`STOP leader ${expectedSignal}`));
    assert.match(child.output(), new RegExp(`STOP grandchild ${expectedSignal}`));
    for (const port of ports) await assertPortReleased(port);
    assertGroupStopped(child.pid);
  });
}

test("npm run dev starts the actual server and Vite and leaves no processes after Ctrl-C", {
  timeout: 45_000, skip: process.platform === "win32" && "POSIX terminal signal contract",
}, async (t) => {
  const work = fixture(t);
  for (const name of ["src", "node_modules"]) {
    symlinkSync(path.join(root, name), path.join(work.dir, name), "dir");
  }
  writeFileSync(path.join(work.dir, "package.json"), JSON.stringify({
    name: "hivemind-dev-smoke", private: true, type: "module", scripts: { dev: manifest.scripts.dev },
  }));
  // Use the unmodified production dev command and Vite configuration. Override
  // only fixture paths and bind ephemeral ports; never claim a user's 7421 port.
  writeFileSync(path.join(work.dir, "vite.config.ts"), [
    `import config from ${JSON.stringify(path.join(root, "vite.config.ts"))};`,
    "export default { ...config,",
    `root: ${JSON.stringify(path.join(root, "web"))},`,
    `cacheDir: ${JSON.stringify(path.join(work.dir, "vite-cache"))},`,
    "server: { ...config.server, port: 0, strictPort: false } };",
  ].join("\n"));
  const npm = process.env.npm_execpath ?? realpathSync(path.join(path.dirname(process.execPath), "npm"));
  const child = work.start([npm, "run", "dev"]);
  const backend = await child.wait(/hivemind on (http:\/\/127\.0\.0\.1:(\d+))/);
  const ui = await child.wait(/Local:\s+(http:\/\/127\.0\.0\.1:(\d+))/);
  const health = await fetch(`${backend[1]}/api/health`, { signal: t.signal });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, name: "hivemind" });
  const page = await fetch(ui[1], { signal: t.signal });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/@vite\/client/);
  // Ctrl-C is delivered to the foreground process group, not only to npm.
  process.kill(-child.pid, "SIGINT");
  await deadline(child.closed, `npm run dev shutdown: ${child.output()}`);
  await assertPortReleased(Number(backend[2]));
  await assertPortReleased(Number(ui[2]));
  assertGroupStopped(child.pid);
});
