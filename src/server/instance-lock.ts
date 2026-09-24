import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The lock file, in HIVEMIND_HOME, that admits one `serve` per hive. */
export const INSTANCE_LOCK_FILE = "server.lock";

type Owner = { pid: number; token: string; startedAt: number };
export type InstanceLock = { readonly file: string; release(): void };

/** Locks this process holds, by lock file path, with the token it wrote. */
const held = new Map<string, string>();
let exitHookInstalled = false;

export class InstanceLockError extends Error {}

/**
 * Takes the single-instance lock of a hive home, or throws InstanceLockError when a
 * live server already holds it. Two servers on one home would both poll Telegram
 * (409 Conflict), pump the same outbox twice and keep separate waiters.
 *
 * The lock is a file created atomically with its content (write a private temp file,
 * then hard-link it into place, which fails if the lock exists). A lock whose pid is
 * no longer running is stale (the previous server crashed) and is reclaimed. Within
 * this process the token decides, so a second in-process server is refused too.
 */
export function acquireInstanceLock(home: string): InstanceLock {
  const dir = path.resolve(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, INSTANCE_LOCK_FILE);
  const owner: Owner = { pid: process.pid, token: randomUUID(), startedAt: Date.now() };
  const temp = `${file}.${owner.token}.tmp`;
  writeFileSync(temp, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(temp, file);
        return hold(file, owner.token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = readOwner(file);
      if (current && alive(current, file)) {
        throw new InstanceLockError(
          `Another Hivemind server (pid ${current.pid}) is already running for HIVEMIND_HOME ${dir}. ` +
          `Stop it first, or set HIVEMIND_HOME to a different directory. If no server is running, delete ${file}.`,
        );
      }
      removeIfUnchanged(file, current);
    }
    throw new InstanceLockError(`Could not take the Hivemind server lock ${file}; another server may be starting. Try again.`);
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

function hold(file: string, token: string): InstanceLock {
  held.set(file, token);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // A clean exit (including process.exit after a fatal error) never leaves a stale lock.
    process.once("exit", () => { for (const [lock, owned] of held) releaseFile(lock, owned); });
  }
  return { file, release: () => releaseFile(file, token) };
}

function releaseFile(file: string, token: string) {
  if (held.get(file) !== token) return;
  held.delete(file);
  if (readOwner(file)?.token === token) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

function readOwner(file: string): Owner | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Owner>;
    return Number.isSafeInteger(value.pid) && typeof value.token === "string" ? value as Owner : null;
  } catch {
    return null; // Missing or corrupt: the file is always complete when linked, so it cannot be mid-write.
  }
}

function alive(owner: Owner, file: string): boolean {
  if (owner.pid === process.pid) return held.get(file) === owner.token;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes a stale lock unless another starter replaced it since it was read. */
function removeIfUnchanged(file: string, stale: Owner | null) {
  const current = readOwner(file);
  if ((current?.token ?? null) !== (stale?.token ?? null)) return;
  try { unlinkSync(file); } catch { /* another starter removed it first */ }
}
