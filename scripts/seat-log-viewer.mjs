// Read-only live viewer for one topology-study seat (#29 `--watch`). It follows the seat's opencode `--format json`
// stdout and its stderr inside an attempt directory, including retry logs (`<seat>.retry-N.*.log`), and renders the
// events as readable lines. It never writes anything and has no effect on the trial: it only tails retained logs.
//
//   node scripts/seat-log-viewer.mjs --dir <attemptDir> --seat <brain|worker-N>
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_ARGS = 160, MAX_TEXT = 600, MAX_OUTPUT = 200;
const COLORS = { dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 };

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const paint = (color, text, enabled) => (enabled ? `\u001b[${COLORS[color]}m${text}\u001b[0m` : text);
const lineCount = text => (typeof text === 'string' && text ? text.split('\n').length : 0);

function summarizeArgs(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(clip(v, 60)) : clip(JSON.stringify(v), 60)}`);
  return clip(parts.join(' '), MAX_ARGS);
}

function renderTool(part, color) {
  const tool = String(part.tool ?? 'tool'), state = part.state ?? {}, input = state.input ?? {};
  const failed = state.status === 'error';
  let line;
  if (tool === 'bash') line = `$ ${clip(input.command, MAX_ARGS)}${state.metadata?.exit !== undefined ? `  (exit ${state.metadata.exit})` : ''}`;
  else if (tool === 'write') line = `write ${input.filePath ?? '?'} (${lineCount(input.content)} lines)`;
  else if (tool === 'edit') line = `edit ${input.filePath ?? '?'} (-${lineCount(input.oldString)} +${lineCount(input.newString)} lines)`;
  else if (tool === 'read') line = `read ${input.filePath ?? '?'}`;
  else if (tool.startsWith('hivemind_')) line = `hive ${tool.slice('hivemind_'.length)} ${summarizeArgs(input)}`.trimEnd();
  else line = `tool ${tool} ${summarizeArgs(input)}`.trimEnd();
  if (failed) return paint('red', `${line}\n    ! ${clip(state.error ?? 'failed', MAX_OUTPUT)}`, color);
  return paint(tool.startsWith('hivemind_') ? 'magenta' : 'cyan', line, color);
}

/** Renders one parsed opencode JSON event, or returns null for events that carry nothing worth showing. */
export function renderEvent(event, { color = false } = {}) {
  if (!event || typeof event !== 'object') return null;
  const part = event.part ?? {};
  switch (event.type) {
    case 'step_start': return null;
    case 'text': return part.text ? `say  ${clip(part.text, MAX_TEXT)}` : null;
    case 'reasoning': return part.text ? paint('dim', `think ${clip(part.text, MAX_TEXT)}`, color) : null;
    case 'tool_use': return renderTool(part, color);
    case 'step_finish': {
      const t = part.tokens ?? {};
      if (!Number.isFinite(t.total)) return null;
      const extra = [t.input !== undefined ? `in ${t.input}` : null, t.output !== undefined ? `out ${t.output}` : null,
        t.cache?.read ? `cache ${t.cache.read}` : null].filter(Boolean).join(', ');
      return paint('dim', `tokens ${t.total} cumulative${extra ? ` (${extra})` : ''}`, color);
    }
    case 'error': {
      const e = event.error ?? part.error ?? {};
      return paint('red', `ERROR ${clip(e.data?.message ?? e.message ?? e.name ?? JSON.stringify(e), MAX_OUTPUT)}`, color);
    }
    default: return paint('dim', `(${clip(event.type, 40)})`, color);
  }
}

/** Renders one raw log line from stdout (JSON events) or stderr (plain text). */
export function renderLine(line, { stream = 'stdout', color = false } = {}) {
  if (!line.trim()) return null;
  if (stream === 'stderr') return paint('yellow', `stderr| ${clip(line, MAX_OUTPUT)}`, color);
  if (!line.trimStart().startsWith('{')) return clip(line, MAX_OUTPUT);
  try { return renderEvent(JSON.parse(line), { color }); } catch { return clip(line, MAX_OUTPUT); }
}

/** Log files of one seat in launch order: the first start, then `<seat>.retry-1`, `<seat>.retry-2`, ... */
export function seatLogNames(seat, retry) {
  const base = retry === 0 ? seat : `${seat}.retry-${retry}`;
  return { stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log` };
}

class Follower {
  constructor(file, stream) { this.file = file; this.stream = stream; this.offset = 0; this.pending = ''; }
  poll(emit) {
    if (!existsSync(this.file)) return false;
    const size = statSync(this.file).size;
    if (size <= this.offset) return true;
    const fd = openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size - this.offset, 1 << 20));
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const lines = (this.pending + buffer.subarray(0, read).toString('utf8')).split('\n');
      this.pending = lines.pop() ?? '';
      for (const line of lines) emit(line, this.stream);
    } finally { closeSync(fd); }
    return true;
  }
}

async function main(argv) {
  const dir = argv[argv.indexOf('--dir') + 1], seat = argv[argv.indexOf('--seat') + 1];
  if (!argv.includes('--dir') || !argv.includes('--seat') || !dir || !seat) throw new Error('Usage: seat-log-viewer.mjs --dir <attemptDir> --seat <name>');
  const color = process.stdout.isTTY === true;
  const emit = (line, stream) => { const out = renderLine(line, { stream, color }); if (out) console.log(out); };
  console.log(paint('green', `== ${seat} (${path.basename(path.dirname(dir))}/${path.basename(dir)}) ==`, color));
  const followers = [];
  for (let retry = 0; ; ) {
    const names = seatLogNames(seat, retry);
    if (followers.length === retry * 2 && existsSync(path.join(dir, names.stdout))) {
      if (retry > 0) console.log(paint('yellow', `-- ${seat} restarted (retry ${retry}) --`, color));
      followers.push(new Follower(path.join(dir, names.stdout), 'stdout'), new Follower(path.join(dir, names.stderr), 'stderr'));
      retry++;
    }
    for (const follower of followers) follower.poll(emit);
    await delay(300);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
