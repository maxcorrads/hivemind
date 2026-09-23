// Private opencode data per seat, shared by the #136 study host and the fixed-workflow pilot executor (#29).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Isolated opencode data per seat. OpenCode keeps its SQLite database, logs, snapshots and state under
 * $XDG_DATA_HOME/opencode and $XDG_STATE_HOME/opencode; one shared multi-GB database (also used by the Human's own
 * sessions) is contended by every seat. Each seat instead gets a private temp dir OUTSIDE the retained attempt with a
 * SYMLINK to the real auth.json (credentials are never copied). XDG_CONFIG_HOME and XDG_CACHE_HOME stay untouched, so
 * providers, config and the model cache still resolve. The dir is removed when the seat stops; dirs left by a runner
 * that died are removed by sweepStaleSeatDataDirs when the next host starts.
 */
export const SEAT_DATA_PREFIX = 'hivemind-study-seat-';
export function createSeatDataDir({ env, tmpRoot = os.tmpdir() }) {
  const dir = mkdtempSync(path.join(tmpRoot, `${SEAT_DATA_PREFIX}${process.pid}-`));
  const data = path.join(dir, 'data'), state = path.join(dir, 'state');
  mkdirSync(path.join(data, 'opencode'), { recursive: true, mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const realData = String(env.XDG_DATA_HOME ?? '').trim() || path.join(String(env.HOME ?? '').trim() || os.homedir(), '.local', 'share');
  const auth = path.join(realData, 'opencode', 'auth.json');
  const authLinked = existsSync(auth);
  if (authLinked) symlinkSync(auth, path.join(data, 'opencode', 'auth.json'));
  return { dir, env: { XDG_DATA_HOME: data, XDG_STATE_HOME: state }, authLinked };
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
export function sweepStaleSeatDataDirs(tmpRoot = os.tmpdir()) {
  const removed = [];
  let entries = [];
  try { entries = readdirSync(tmpRoot); } catch { return removed; }
  for (const name of entries) {
    const pid = Number(/^hivemind-study-seat-(\d+)-/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
    rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
