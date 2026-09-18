import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IMAGE_PREVIEW_MAX_BYTES } from "../shared/types.ts";

export const IMAGE_PREVIEW_MAX_DIMENSION = 12_000;
export const IMAGE_PREVIEW_MAX_PIXELS = 40_000_000;
export const IMAGE_PREVIEW_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const IMAGE_PREVIEW_CONCURRENCY = 2;
const HEADER_BYTES = 64 * 1024;
let active = 0;
let requests = 0;
let previews = 0;
let totalDurationMs = 0;

/** Process-local counters contain no names, paths, credentials or file contents. */
export function previewMetrics() {
  return { requests, previews, active, totalDurationMs };
}
type Dimensions = { width: number; height: number };
type Command = [string, (input: string, output: string) => string[]];

/** Only formats with bounded, understood metadata are decoded. Other formats return metadata only. */
export function imageDimensions(bytes: Buffer, mime: string): Dimensions | null {
  if (mime === "image/png") {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime !== "image/jpeg" || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at++] !== 0xff) return null;
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0 || marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || length !== 8 + 3 * bytes[at + 7]!) return null;
      return { height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) };
    }
    at += length;
  }
  return null;
}

function within(d: Dimensions | null, max: number, pixels: number): boolean {
  return d !== null && d.width > 0 && d.height > 0 && d.width <= max && d.height <= max && d.width * d.height <= pixels;
}

async function boundedRead(file: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error("Preview file size limit");
    // Fixed allocation also limits a file that grows after fstat.
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const result = await fd.read(bytes, count, Math.min(HEADER_BYTES, bytes.length - count), count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== stat.size) throw new Error("Preview file changed while reading");
    return bytes.subarray(0, count);
  } finally { await fd.close(); }
}

function validJpeg(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt16BE(data.length - 2) === 0xffd9 &&
    data.indexOf(Buffer.from([0xff, 0xda])) > 0 &&
    within(imageDimensions(data.subarray(0, HEADER_BYTES), "image/jpeg"), 1600, 1600 * 1600);
}

function run(bin: string, args: string[], remaining: number, signal?: AbortSignal): Promise<boolean> {
  if (remaining <= 0 || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Isolate the process group so cancellation also terminates decoder helpers.
    const grouped = process.platform !== "win32";
    const child = spawn(bin, args, { stdio: "ignore", windowsHide: true, detached: grouped });
    let killed = false;
    const stop = () => {
      killed = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* process already exited */ }
    };
    const timer = setTimeout(stop, remaining);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.on("error", () => { killed = true; });
    // 'close', not an abort callback: do not release the slot while the process is alive.
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(code === 0 && !killed);
    });
  });
}

function defaults(): Command[] {
  const commands: Command[] = [];
  if (process.platform === "darwin") {
    commands.push(["sips", (input, output) => ["-Z", "1600", "-s", "format", "jpeg", input, "--out", output]]);
  }
  commands.push(["ffmpeg", (input, output) => [
    "-nostdin", "-y", "-max_alloc", "67108864", "-threads", "1", "-i", input,
    "-frames:v", "1", "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease",
    "-threads", "1", "-fs", String(IMAGE_PREVIEW_MAX_BYTES), "-q:v", "5", output,
  ]]);
  for (const bin of ["magick", "convert"]) commands.push([bin, (input, output) => [
    "-limit", "memory", "128MiB", "-limit", "map", "128MiB", "-limit", "disk", "64MiB",
    "-limit", "thread", "1", `${input}[0]`, "-resize", "1600x1600>", output,
  ]]);
  return commands;
}

/** Best-effort bounded sweep of crash leftovers; never removes a live/reused PID's workspace. */
export async function cleanupPreviewTemps(root: string, nowMs = Date.now()): Promise<void> {
  const directory = await opendir(root);
  let visited = 0;
  for await (const entry of directory) {
    if (visited++ >= 256) break;
    const name = entry.name;
    const match = /^p(\d+)-[A-Za-z0-9]{6}$/.exec(name);
    if (!match || Number(match[1]) <= 0) continue;
    try {
      const full = path.join(root, name);
      const info = await lstat(full);
      if (nowMs - info.mtimeMs < 86_400_000) continue;
      try { process.kill(Number(match[1]), 0); continue; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      await rm(full, { recursive: true, force: true });
    } catch { /* An unrelated cleanup must not break this preview. */ }
  }
}

export async function imagePreview(
  filePath: string, mime: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; commands?: Command[] } = {},
): Promise<{ data: Buffer; mime: string } | null> {
  requests += 1;
  if (!["image/png", "image/jpeg"].includes(mime) || opts.signal?.aborted || active >= IMAGE_PREVIEW_CONCURRENCY) return null;
  active += 1;
  const timeout = Number.isFinite(opts.timeoutMs) ? Math.min(15_000, Math.max(1, opts.timeoutMs!)) : 5_000;
  const started = performance.now();
  const deadline = started + timeout;
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("Preview deadline exceeded")), timeout);
  let temp: string | undefined;
  try {
    // Read actual bytes, never the MCP placeholder. Copy into a private immutable-to-callers input
    // so the decoder cannot reopen a replaced/symlinked original after validation.
    const bytes = await boundedRead(filePath, IMAGE_PREVIEW_MAX_SOURCE_BYTES, signal);
    const d = imageDimensions(bytes.subarray(0, HEADER_BYTES), mime);
    if (!within(d, IMAGE_PREVIEW_MAX_DIMENSION, IMAGE_PREVIEW_MAX_PIXELS)) return null;
    if (mime === "image/png" && (bytes.length < 45 || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND")) return null;
    if (mime === "image/jpeg" && bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return null;
    if (signal.aborted || performance.now() >= deadline) return null;
    const root = path.join(os.tmpdir(), `hivemind-previews-${process.getuid?.() ?? "user"}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0 ||
        (process.getuid && rootInfo.uid !== process.getuid())) return null;
    await cleanupPreviewTemps(root);
    temp = await mkdtemp(path.join(root, `p${process.pid}-`));
    const input = path.join(temp, mime === "image/png" ? "input.png" : "input.jpg");
    const fd = await open(input, "wx", 0o600);
    try { await fd.writeFile(bytes, { signal }); } finally { await fd.close(); }
    let attempt = 0;
    for (const [bin, makeArgs] of opts.commands ?? defaults()) {
      if (signal.aborted || performance.now() >= deadline) break;
      const output = path.join(temp, `preview-${attempt++}.jpg`);
      try {
        if (!await run(bin, makeArgs(input, output), deadline - performance.now(), signal)) continue;
        const data = await boundedRead(output, IMAGE_PREVIEW_MAX_BYTES, signal);
        if (!signal.aborted && performance.now() < deadline && validJpeg(data)) {
          previews += 1;
          return { data, mime: "image/jpeg" };
        }
      } catch { /* Safe metadata-only fallback or next encoder within the same deadline. */ }
    }
    return null;
  } catch { return null; } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    try { if (temp) await rm(temp, { recursive: true, force: true }); } finally {
      active -= 1;
      totalDurationMs += performance.now() - started;
    }
  }
}
