// Opt-in live viewer for topology-study runs (`run --watch` or HIVEMIND_STUDY_WATCH=1). While a trial runs, a tmux
// session shows one window per trial: one pane per seat (scripts/seat-log-viewer.mjs following that seat's logs) plus
// a pane tailing the trial server log. Seats stay non-interactive `opencode run --format json` processes, so usage
// parsing is unchanged. Everything here is best effort: every failure is swallowed and nothing reaches the journal,
// the evidence or the trial outcome.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCH_SESSION = 'hivemind-study';
const viewer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seat-log-viewer.mjs');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function watchEnabled({ watch = false, env = process.env } = {}) {
  return watch === true || ['1', 'true'].includes(String(env.HIVEMIND_STUDY_WATCH ?? '').toLowerCase());
}

function defaultTmux(env) {
  if (env.HIVEMIND_STUDY_TMUX) return env.HIVEMIND_STUDY_TMUX;
  return existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
}

/** Tmux window name for a trial: `<condition>-<trialId prefix>`. */
export const windowName = spec => `${spec.condition}-${String(spec.trialId).slice(0, 8)}`;

/**
 * @param {object} options
 * @param {boolean} options.enabled
 * @param {object} [options.env]
 * @param {string[]} [options.tmux]       tmux command (tests: a fake)
 * @param {string[]|null} [options.openTerminal]  command that opens a terminal attached to the session; null disables
 */
export function createWatcher({ enabled, env = process.env, tmux, openTerminal } = {}) {
  if (!enabled) return { enabled: false, trialStarted() {}, trialEnded() {} };
  const tmuxCommand = tmux ?? [defaultTmux(env)];
  const ci = ['1', 'true'].includes(String(env.CI ?? '').toLowerCase());
  const terminal = openTerminal !== undefined ? openTerminal
    : process.platform === 'darwin' && !ci
      ? ['osascript', '-e', `tell application "Terminal" to do script "${tmuxCommand[0]} attach -t ${WATCH_SESSION}"`] : null;
  let terminalOpened = false;
  const run = (command, args) => {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: result.status === 0, stdout: result.stdout ?? '' };
  };
  const t = (...args) => run(tmuxCommand, args);

  function trialStarted(spec) {
    try {
      if (!t('has-session', '-t', WATCH_SESSION).ok) t('new-session', '-d', '-s', WATCH_SESSION, '-n', 'study');
      const name = windowName(spec), target = `${WATCH_SESSION}:${name}`;
      const node = quote(process.execPath);
      const seatPane = seat => `${node} ${quote(viewer)} --dir ${quote(spec.attemptDir)} --seat ${quote(seat)}`;
      const seats = ['brain', ...Array.from({ length: spec.freeWorkers }, (_, i) => `worker-${i + 1}`)];
      const titled = (created, title) => { if (created.ok && created.stdout.trim()) t('select-pane', '-t', created.stdout.trim(), '-T', title); };
      const first = t('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${WATCH_SESSION}:`, '-n', name, seatPane('brain'));
      if (!first.ok) return;
      titled(first, 'brain');
      for (const seat of seats.slice(1)) {
        titled(t('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', target, seatPane(seat)), seat);
        t('select-layout', '-t', target, 'tiled');
      }
      titled(t('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', target, `tail -n +1 -F ${quote(path.join(spec.attemptDir, 'server.log'))}`), 'server');
      t('select-layout', '-t', target, 'tiled');
      t('set-option', '-w', '-t', target, 'pane-border-status', 'top');
      t('select-window', '-t', target);
      if (!terminalOpened && terminal) {
        terminalOpened = true;
        const clients = t('list-clients', '-t', WATCH_SESSION);
        if (clients.ok && clients.stdout.trim() === '') run(terminal, []);
      }
    } catch { /* the viewer never affects a trial */ }
  }

  function trialEnded(spec) {
    try { t('kill-window', '-t', `${WATCH_SESSION}:${windowName(spec)}`); } catch { /* best effort */ }
  }

  return { enabled: true, trialStarted, trialEnded };
}
