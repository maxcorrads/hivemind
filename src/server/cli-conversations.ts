import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CliConversation } from "../shared/cli-conversations.ts";

/**
 * The last conversation each agent had in its CLI, read from the CLIs' own local transcripts, so Resume same employees
 * can continue it (docs/terminal-broker.md#resuming-conversations). Only the session ID, its folder, its CLI home and
 * the agent name of its launch prompt are read; nothing else of a transcript leaves this module.
 */
type Found = CliConversation & { name: string };

/** Transcripts older than this are not considered. */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** The launch prompt comes first: the name is read from the head of a JSONL transcript. */
const HEAD_BYTES = 1024 * 1024;
/** Cursor keeps a chat in SQLite, where the prompt can sit anywhere: it is read in chunks up to this much. */
const CURSOR_MAX_BYTES = 128 * 1024 * 1024;
const CHUNK = 1024 * 1024;

const NAME = "([A-Za-z][A-Za-z0-9_-]{0,63})";
/**
 * The agent's own name, wherever it first appears: its launch prompt's `resume=<name>` (Resume same employees) or a
 * reserved worker's "You are the Hivemind worker <name>", or else join's answer (`"you":{"name":…}`, JSON-escaped in a
 * transcript) for an agent started by hand. Later names are other agents this one talked about.
 */
const IDENTITY = new RegExp(`resume=${NAME}|You are the Hivemind worker ${NAME}|\\\\*"you\\\\*"\\s*:\\s*\\{\\s*\\\\*"name\\\\*"\\s*:\\s*\\\\*"${NAME}`);

function identity(text: string): string | null {
  const match = IDENTITY.exec(text);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

async function head(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function entries(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch { return []; }
}

async function recent(file: string, since: number): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() && info.mtimeMs >= since ? info.mtimeMs : null;
  } catch { return null; }
}

/** `~/.claude*`, `~/.codex*`: each CLI home, in name order, with the command named after it. */
async function homes(home: string, prefix: string): Promise<{ dir: string; software: string }[]> {
  return (await entries(home)).filter((name) => name.startsWith(prefix) && /^\.[\w-]+$/.test(name)).sort()
    .map((name) => ({ dir: path.join(home, name), software: name.slice(1) }));
}

async function claude(home: string, since: number): Promise<Found[]> {
  const found: Found[] = [];
  for (const { dir, software } of await homes(home, ".claude")) {
    const projects = path.join(dir, "projects");
    for (const project of await entries(projects)) {
      for (const file of (await entries(path.join(projects, project))).filter((name) => name.endsWith(".jsonl"))) {
        const full = path.join(projects, project, file);
        const at = await recent(full, since);
        if (at === null) continue;
        const text = await head(full, HEAD_BYTES).catch(() => "");
        const name = identity(text);
        if (!name) continue;
        const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? null;
        found.push({ cli: "claude", software, id: file.slice(0, -".jsonl".length), cwd, at, name });
      }
    }
  }
  return found;
}

async function rollouts(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const name of await entries(dir)) {
    const full = path.join(dir, name);
    if (name.startsWith("rollout-") && name.endsWith(".jsonl")) out.push(full);
    else if (!name.includes(".")) out.push(...await rollouts(full, depth + 1));
  }
  return out;
}

async function codex(home: string, since: number): Promise<Found[]> {
  const found: Found[] = [];
  // Account homes may share one sessions folder: each transcript counts once, under the first home that has it.
  const seen = new Set<string>();
  for (const { dir, software } of await homes(home, ".codex")) {
    for (const file of await rollouts(path.join(dir, "sessions"))) {
      const real = await realpath(file).catch(() => file);
      if (seen.has(real)) continue;
      seen.add(real);
      const at = await recent(file, since);
      if (at === null) continue;
      const text = await head(file, HEAD_BYTES).catch(() => "");
      const name = identity(text);
      if (!name) continue;
      let id: string | null = null, cwd: string | null = null;
      try {
        const meta = JSON.parse(text.slice(0, text.indexOf("\n") > 0 ? text.indexOf("\n") : undefined)) as
          { payload?: { id?: unknown; cwd?: unknown } };
        id = typeof meta.payload?.id === "string" ? meta.payload.id : null;
        cwd = typeof meta.payload?.cwd === "string" ? meta.payload.cwd : null;
      } catch { /* not a session_meta line */ }
      id ??= /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? null;
      if (id) found.push({ cli: "codex", software, id, cwd, at, name });
    }
  }
  return found;
}

/** The first agent name in a Cursor chat's store, read a chunk at a time. */
async function cursorName(file: string): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    let tail = "";
    for (let position = 0; position < CURSOR_MAX_BYTES; position += CHUNK) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (!bytesRead) return null;
      const text = tail + buffer.subarray(0, bytesRead).toString("latin1");
      const name = identity(text);
      if (name) return name;
      tail = text.slice(-200);
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function cursor(home: string, since: number): Promise<Found[]> {
  const found: Found[] = [];
  const chats = path.join(home, ".cursor", "chats");
  for (const workspace of await entries(chats)) {
    for (const chat of await entries(path.join(chats, workspace))) {
      const store = path.join(chats, workspace, chat, "store.db");
      const at = await recent(store, since);
      if (at === null || !/^[A-Za-z0-9-]{8,80}$/.test(chat)) continue;
      const name = await cursorName(store).catch(() => null);
      if (name) found.push({ cli: "cursor", software: "agent", id: chat, cwd: null, at, name });
    }
  }
  return found;
}

/**
 * For each agent (by name, case-insensitive, and when its transcript says, in its project's folder), its newest
 * conversation across Claude (`~/.claude*`), Codex (`~/.codex*`) and Cursor (`~/.cursor/chats`).
 */
export async function lastConversations(
  home: string,
  agents: readonly { id: string; name: string; worktree: string | null }[],
  now = Date.now(),
): Promise<Record<string, CliConversation>> {
  const since = now - MAX_AGE_MS;
  const all = (await Promise.all([claude(home, since), codex(home, since), cursor(home, since)])).flat();
  const out: Record<string, CliConversation> = {};
  for (const agent of agents) {
    const inProject = (cwd: string | null) => !cwd || !agent.worktree || cwd === agent.worktree || cwd.startsWith(`${agent.worktree}/`);
    const best = all.filter((found) => found.name.toLowerCase() === agent.name.toLowerCase() && inProject(found.cwd))
      .sort((a, b) => b.at - a.at)[0];
    if (best) out[agent.id] = { cli: best.cli, software: best.software, id: best.id, cwd: best.cwd, at: Math.round(best.at) };
  }
  return out;
}
