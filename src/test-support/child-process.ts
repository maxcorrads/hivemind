import type { ChildProcess } from "node:child_process";

// Environment and shutdown helpers for child processes started by tests (#201).
//
// Under `node --test --experimental-test-coverage` every test process runs with
// NODE_V8_COVERAGE pointing at the runner's shared coverage directory, and the
// runner parses every JSON file in it after the run. A child that inherits the
// variable writes its own multi-megabyte JSON there when it exits; if it is
// killed or orphaned while writing, the runner finds an empty or truncated file
// and aborts the whole coverage report even though every test passed.
//
// Deleting the key is not enough: child_process always copies
// process.env.NODE_V8_COVERAGE into a child whose `env` option lacks the key,
// even for a whitelisted environment. The key must be present and empty.

/** Environment for a process spawned by a test: `env` (default process.env) without V8 coverage. */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { coverageDir?: string } = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  // An explicit opt-in must use its own directory, never the runner's.
  if (options.coverageDir && options.coverageDir === process.env.NODE_V8_COVERAGE) {
    throw new Error("A child's coverage directory must not be the test runner's coverage directory");
  }
  result.NODE_V8_COVERAGE = options.coverageDir ?? "";
  return result;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Stop a child gracefully: send `signal`, give it `graceMs` to exit (and flush
 * whatever it writes at exit), and only then SIGKILL it. Resolves once it exited.
 */
export async function stopChild(
  child: ChildProcess,
  options: { signal?: NodeJS.Signals; graceMs?: number } = {},
): Promise<void> {
  if (exited(child)) return;
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(options.signal ?? "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), options.graceMs ?? 5_000);
  });
  try {
    if (!await Promise.race([done.then(() => true), grace]) && !exited(child)) {
      child.kill("SIGKILL");
      await done;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a detached process group the same way: `signal` to the group, wait up to
 * `graceMs` for `closed` (the leader's close), then SIGKILL whatever is left.
 */
export async function stopProcessGroup(
  pid: number,
  closed: Promise<unknown>,
  options: { signal?: NodeJS.Signals; graceMs?: number } = {},
): Promise<void> {
  const send = (signal: NodeJS.Signals | 0) => {
    try { process.kill(-pid, signal); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  if (!send(options.signal ?? "SIGTERM")) return;
  const deadline = performance.now() + (options.graceMs ?? 5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.graceMs ?? 5_000); });
  try {
    await Promise.race([closed, grace]);
  } finally {
    clearTimeout(timer);
  }
  // The leader can close before other members finish exiting: keep waiting for
  // the group to empty within the same grace period, then kill any survivor.
  while (send(0) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  send("SIGKILL");
}
