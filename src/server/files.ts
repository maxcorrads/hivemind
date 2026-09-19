import { createHash, randomUUID } from "node:crypto";
import {
  constants, createReadStream, closeSync, fstatSync, linkSync,
  lstatSync, mkdirSync, openSync, readdirSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { streamToTemporaryFile } from "../shared/stream-file.ts";
import { ALLOWED_MIMES, FILE_MAX_BYTES, HiveError } from "../shared/types.ts";
import { hiveHome } from "./paths.ts";

export { imageDimensions, imagePreview } from "./image-preview.ts";

export function filesDir(home = hiveHome()): string {
  return path.join(home, "files");
}

function ensureFilesDir(home: string): string {
  const dir = filesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new HiveError(409, "Blob directory must not be a symlink");
  return dir;
}

export function filePathForHash(sha256: string, home = hiveHome()): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HiveError(400, "Invalid blob hash");
  return path.join(filesDir(home), sha256);
}

export function assertAllowedMime(mime: string) {
  if (!(ALLOWED_MIMES as readonly string[]).includes(mime)) {
    throw new HiveError(400, `File type not allowed: ${mime}`);
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
}

/** PID ownership is conservative: a reused/live PID prevents cleanup, never authorizes deletion. */
export function uploadTempName(): string {
  return `part-p${process.pid}-${randomUUID()}`;
}

export function removeUploadTemp(tmp: string) {
  try { unlinkSync(tmp); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function streamUpload(
  body: ReadableStream<Uint8Array> | null,
  mime: string,
  home = hiveHome(),
  signal?: AbortSignal,
  maxBytes = FILE_MAX_BYTES,
): Promise<{ tmp: string; bytes: number; sha256: string }> {
  if (!body) throw new HiveError(400, "Empty upload");
  assertAllowedMime(mime);
  signal?.throwIfAborted();
  const tmp = path.join(ensureFilesDir(home), uploadTempName());
  const hash = createHash("sha256");
  try {
    const bytes = await streamToTemporaryFile(body, tmp, Math.min(FILE_MAX_BYTES, maxBytes), signal, chunk => { hash.update(chunk); });
    return { tmp, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof Error && error.message === 'Stream exceeds its byte budget') throw new HiveError(413, 'File too large for its upload reservation');
    if (error instanceof Error && error.message === 'Empty stream') throw new HiveError(400, 'Empty upload');
    throw error;
  }
}

/** Synchronous publication MUST run inside the same SQLite writer transaction as metadata insertion. */
export function commitUpload(tmp: string, sha256: string, home = hiveHome()): string {
  const dir = ensureFilesDir(home);
  if (path.dirname(path.resolve(tmp)) !== path.resolve(dir) || !/^part-p\d+-[a-f0-9-]+$/.test(path.basename(tmp))) {
    throw new HiveError(400, "Invalid upload path");
  }
  const source = lstatSync(tmp);
  if (!source.isFile()) throw new HiveError(409, "Upload must be a regular file");
  const dest = filePathForHash(sha256, home);
  try {
    // No overwrite and no exists/rename race between identical publications.
    linkSync(tmp, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = lstatSync(dest);
    if (!existing.isFile() || existing.size !== source.size) throw new HiveError(409, "Invalid existing blob");
  }
  removeUploadTemp(tmp);
  return dest;
}

export function openBlob(sha256: string, home = hiveHome()) {
  const dest = filePathForHash(sha256, home);
  ensureFilesDir(home);
  let fd: number;
  try { fd = openSync(dest, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HiveError(404, "File not found");
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HiveError(409, "Blob must be a regular file");
    return { stream: createReadStream(dest, { fd, autoClose: true }), bytes: stat.size };
  } catch (error) { closeSync(fd); throw error; }
}

function ownerIsDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Caller holds the shared SQLite writer lock BEFORE taking usedHashes and through this sweep. */
export function removeOrphanBlobs(
  usedHashes: Set<string>, home = hiveHome(), opts: { now?: number; staleTempMs?: number } = {},
): number {
  const dir = ensureFilesDir(home);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const blob = /^[a-f0-9]{64}$/.test(name);
    const temp = /^part-p(\d+)-[a-f0-9-]+$/.exec(name);
    // Old temp names have no trustworthy owner: preserve until a stopped-home cleanup.
    if (!blob && !temp) continue;
    if (blob && usedHashes.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = lstatSync(full);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (temp && (
        (opts.now ?? Date.now()) - stat.mtimeMs < (opts.staleTempMs ?? 86_400_000) ||
        !ownerIsDead(Number(temp[1]))
      )) continue;
      // Never follows symlinks; ENOENT can be another cleanup, not a failed sweep.
      unlinkSync(full);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
