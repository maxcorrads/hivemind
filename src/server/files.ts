import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ALLOWED_MIMES, FILE_MAX_BYTES, HiveError, IMAGE_PREVIEW_MAX_BYTES } from "../shared/types.ts";
import { hiveHome } from "./paths.ts";

export function filesDir(home = hiveHome()): string {
  return path.join(home, "files");
}

export function filePathForHash(sha256: string, home = hiveHome()): string {
  return path.join(filesDir(home), sha256);
}

const activePublications = new Set<string>();

export function releasePublishedBlob(sha256: string) {
  activePublications.delete(sha256);
}

export function assertAllowedMime(mime: string) {
  if (!(ALLOWED_MIMES as readonly string[]).includes(mime)) {
    throw new HiveError(400, `File type not allowed: ${mime}`);
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
}

export async function streamUpload(
  body: ReadableStream<Uint8Array> | null,
  mime: string,
  home = hiveHome(),
): Promise<{ tmp: string; bytes: number; sha256: string }> {
  if (!body) throw new HiveError(400, "Empty upload");
  assertAllowedMime(mime);
  mkdirSync(filesDir(home), { recursive: true });
  const tmp = path.join(filesDir(home), `part-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const node = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  node.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > FILE_MAX_BYTES) node.destroy(new HiveError(413, "File too large (512 MB max)"));
  });
  try {
    await pipeline(node, createWriteStream(tmp));
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
  if (bytes === 0) {
    unlinkSync(tmp);
    throw new HiveError(400, "Empty upload");
  }
  return { tmp, bytes, sha256: hash.digest("hex") };
}

export async function commitUpload(tmp: string, sha256: string, home = hiveHome()): Promise<string> {
  const dest = filePathForHash(sha256, home);
  activePublications.add(sha256);
  try {
    if (existsSync(dest)) {
      await unlink(tmp).catch(() => undefined);
      return dest;
    }
    await rename(tmp, dest);
    return dest;
  } catch (err) {
    activePublications.delete(sha256);
    throw err;
  }
}

export function openBlob(sha256: string, home = hiveHome()) {
  const dest = filePathForHash(sha256, home);
  if (!existsSync(dest)) throw new HiveError(404, "File not found");
  return { stream: createReadStream(dest), bytes: statSync(dest).size };
}

export function removeOrphanBlobs(
  usedHashes: Set<string>,
  home = hiveHome(),
  opts: { now?: number; staleTempMs?: number } = {},
) {
  if (!existsSync(filesDir(home))) return 0;
  const nowMs = opts.now ?? Date.now();
  const staleTempMs = opts.staleTempMs ?? 24 * 60 * 60 * 1000;
  let n = 0;
  for (const name of readdirSync(filesDir(home))) {
    const full = path.join(filesDir(home), name);
    const temporary = name.startsWith("part-") || name.startsWith("tg-") || name.includes(".thumb-");
    if (temporary) {
      if (nowMs - statSync(full).mtimeMs < staleTempMs) continue;
      unlinkSync(full);
      n += 1;
      continue;
    }
    if (usedHashes.has(name) || activePublications.has(name)) continue;
    unlinkSync(full);
    n += 1;
  }
  return n;
}

/** Store keeps the original. Models get a bounded preview; conversion work never blocks the event loop. */
export const IMAGE_PREVIEW_MAX_DIMENSION = 12_000;
export const IMAGE_PREVIEW_MAX_PIXELS = 40_000_000;

export function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && bytes.length >= 24 && bytes.subarray(1, 4).toString() === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if ((mime === "image/jpeg" || mime === "image/jpg") && bytes.length >= 4) {
    let offset = 2;
    while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function previewWithinDimensionBudget(bytes: Buffer, mime: string): boolean {
  const dimensions = imageDimensions(bytes, mime);
  if (!dimensions) return true;
  return (
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= IMAGE_PREVIEW_MAX_DIMENSION &&
    dimensions.height <= IMAGE_PREVIEW_MAX_DIMENSION &&
    dimensions.width * dimensions.height <= IMAGE_PREVIEW_MAX_PIXELS
  );
}

function runPreviewCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 64 * 1024,
        signal,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export async function imagePreview(
  filePath: string,
  mime: string,
  bytes: Buffer,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    commands?: Array<[string, (input: string, output: string) => string[]]>;
  } = {},
): Promise<{ data: Buffer; mime: string } | null> {
  if (!mime.startsWith("image/")) return null;
  if (!previewWithinDimensionBudget(bytes, mime)) return null;
  const timeoutMs = Math.min(Math.max(50, opts.timeoutMs ?? 5_000), 15_000);
  const commands =
    opts.commands ??
    [
      ...(process.platform === "darwin"
        ? ([["sips", (input: string, output: string) => ["-Z", "1600", "-s", "format", "jpeg", input, "--out", output]]] as Array<
            [string, (input: string, output: string) => string[]]
          >)
        : []),
      ["ffmpeg", (input: string, output: string) => ["-y", "-i", input, "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease", "-q:v", "5", output]],
      ["magick", (input: string, output: string) => [input, "-resize", "1600x1600>", output]],
      ["convert", (input: string, output: string) => [input, "-resize", "1600x1600>", output]],
    ];
  for (const [bin, argsFor] of commands) {
    const out = `${filePath}.thumb-${randomUUID()}.jpg`;
    try {
      await runPreviewCommand(bin, argsFor(filePath, out), timeoutMs, opts.signal);
      if (!existsSync(out)) continue;
      const data = readFileSync(out);
      if (data.length > 0 && data.length <= IMAGE_PREVIEW_MAX_BYTES) {
        return { data, mime: "image/jpeg" };
      }
    } catch {
      if (opts.signal?.aborted) return null;
      /* try the next encoder */
    } finally {
      await unlink(out).catch(() => undefined);
    }
  }
  if (bytes.length <= IMAGE_PREVIEW_MAX_BYTES) return { data: bytes, mime };
  return null;
}

