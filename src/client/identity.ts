import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { hiveHome } from "../server/paths.ts";
import type { Identity } from "../shared/types.ts";

const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const storedSchema = z.object({
  version: z.literal(2), origin: z.string(), project: projectSchema,
  id: z.string().uuid(), name: nameSchema, role: z.enum(["brain", "worker"]),
  seniority: z.enum(["junior", "mid", "senior"]).nullable(), focus: z.string().max(4000).nullable(),
  token: z.string().min(1).max(512),
}).strict();
export function identityOrigin(raw = process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420"): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("Expected a server origin without credentials, path or query");
  return url.origin;
}
export function identitiesDir(): string {
  const origin = createHash("sha256").update(identityOrigin()).digest("hex");
  return path.join(hiveHome(), "identities-v2", origin);
}
function privateDirectory(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || (info.mode & 0o077)) throw new Error("Identity directory must be private (0700) and not a symlink");
}
export function identityPath(name: string, project: string): string {
  return path.join(identitiesDir(), projectSchema.parse(project), `${nameSchema.parse(name).toLowerCase()}.json`);
}
export function saveIdentity(identity: Identity & { project: string | null }) {
  const validated = storedSchema.safeParse({ ...identity, version: 2, origin: identityOrigin() });
  if (!validated.success) throw new Error("Cannot persist invalid identity metadata");
  const data = validated.data;
  privateDirectory(path.join(hiveHome(), "identities-v2"));
  privateDirectory(identitiesDir());
  const file = identityPath(data.name, data.project);
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.next`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* rename consumed the temp */ }
  }
  // No global last-join pointer: a different terminal must not pick this token.
}
export function loadIdentityFile(file: string): Identity & { project: string; origin: string; version: 2 } {
  const info = lstatSync(file);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 8192) throw new Error("Invalid or non-private identity file (expected 0600)");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Invalid identity JSON"); }
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid identity file; legacy credentials require explicit migration");
  if (parsed.data.origin !== identityOrigin()) throw new Error("Identity belongs to another server");
  return parsed.data;
}
export function loadIdentityByName(name: string, project?: string | null): Identity | null {
  nameSchema.parse(name);
  if (project) {
    const file = identityPath(name, project);
    if (!existsSync(file)) return null;
    const saved = loadIdentityFile(file);
    if (saved.name.toLowerCase() !== name.toLowerCase() || saved.project !== project) throw new Error("Identity scope mismatch");
    return saved;
  }
  if (!existsSync(identitiesDir())) return null;
  const folders = readdirSync(identitiesDir(), { withFileTypes: true });
  if (folders.length > 256) throw new Error("Specify the project to resume an identity");
  const matches: Identity[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || !projectSchema.safeParse(folder.name).success) continue;
    const file = identityPath(name, folder.name);
    if (existsSync(file)) {
      const saved = loadIdentityFile(file);
      if (saved.name.toLowerCase() !== name.toLowerCase() || saved.project !== folder.name) throw new Error("Identity scope mismatch");
      matches.push(saved);
    }
  }
  if (matches.length > 1) throw new Error("Ambiguous identity name; specify project");
  return matches[0] ?? null;
}
export function currentToken(cliToken?: string): string | undefined {
  // An explicit shell token belongs to that shell. Never fall back to another
  // terminal's last join, even if its server/project happens to match.
  return cliToken || process.env.HIVEMIND_TOKEN || undefined;
}
