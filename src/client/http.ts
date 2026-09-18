import { mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, opendir, rename, unlink } from "node:fs/promises";
import { FILE_MAX_BYTES } from "../shared/types.ts";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { hiveHome } from "../server/hive.ts";
import { safeFileName } from "../server/files.ts";
import type { Identity } from "../shared/types.ts";

export function identitiesDir(): string {
  return path.join(hiveHome(), "identities");
}

export function identityPath(name: string): string {
  return path.join(identitiesDir(), `${name}.json`);
}

export function saveIdentity(id: Identity) {
  mkdirSync(identitiesDir(), { recursive: true });
  writeFileSync(identityPath(id.name), JSON.stringify(id, null, 2));
  writeFileSync(path.join(hiveHome(), "last-join.json"), JSON.stringify(id, null, 2));
}

export function loadIdentityFile(file: string): Identity {
  return JSON.parse(readFileSync(file, "utf8")) as Identity;
}

export function loadIdentityByName(name: string): Identity | null {
  const file = identityPath(name);
  if (!existsSync(file)) return null;
  return loadIdentityFile(file);
}

export function currentToken(cliToken?: string): string | undefined {
  if (cliToken) return cliToken;
  if (process.env.HIVEMIND_TOKEN) return process.env.HIVEMIND_TOKEN;
  const last = path.join(hiveHome(), "last-join.json");
  if (existsSync(last)) {
    const id = loadIdentityFile(last);
    return id.token;
  }
  return undefined;
}

export function hiveUrl(): string {
  return process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420";
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function responseError(res: Response, data: unknown): HttpError {
  const payload = data && typeof data === "object" ? (data as { error?: unknown; code?: unknown }) : {};
  const message = typeof payload.error === "string" && payload.error ? payload.error : `HTTP ${res.status}`;
  const code = typeof payload.code === "string" && payload.code ? payload.code : undefined;
  return new HttpError(res.status, message, code);
}

async function errorFromResponse(res: Response): Promise<HttpError> {
  // Status is authoritative. Bodies may be empty, malformed JSON, HTML, or plain text.
  // Avoid reflecting arbitrary response bodies into logs/errors.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    // Best-effort structured details only.
  }
  return responseError(res, payload);
}

export async function agentRequest<T>(
  method: string,
  pathname: string,
  body?: unknown,
  token?: string | null,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token === null ? undefined : (token ?? currentToken());
  if (t) headers.authorization = `Bearer ${t}`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs
    ? setTimeout(() => ctrl.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs)
    : undefined;
  try {
    const res = await fetch(`${hiveUrl()}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await parseJsonResponse<T>(res);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function agentUpload<T>(
  pathname: string,
  bytes: Buffer,
  token: string,
  name: string,
  mime: string,
): Promise<T> {
  return parseJsonResponse(
    await fetch(`${hiveUrl()}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-file-name": name,
        "x-file-mime": mime,
      },
      body: new Uint8Array(bytes),
    }),
  );
}

export async function agentUploadFile<T>(
  pathname: string,
  filePath: string,
  token: string,
  name: string,
  mime: string,
): Promise<T> {
  const { size } = statSync(filePath);
  return parseJsonResponse(
    await fetch(`${hiveUrl()}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-file-name": name,
        "x-file-mime": mime,
        "content-length": String(size),
      },
      body: Readable.toWeb(createReadStream(filePath)),
      duplex: "half",
    } as unknown as RequestInit),
  );
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  const text = await res.text();
  // Malformed successful JSON is a protocol error, not an HTTP retry classification.
  return (text ? JSON.parse(text) : {}) as T;
}

function fileNameFromDisposition(disp: string): string {
  return /filename="([^"]+)"/.exec(disp)?.[1] ?? "file";
}

/** Reap only old downloads whose owner is provably gone; a live/reused PID is always preserved. */
export async function cleanupDownloadTemps(dir: string, nowMs = Date.now()): Promise<void> {
  const directory = await opendir(dir);
  let visited = 0;
  for await (const entry of directory) {
    if (visited++ >= 256) break;
    const match = /^\.download-(\d+)-[a-f0-9-]+$/.exec(entry.name);
    if (!match || Number(match[1]) <= 0) continue;
    try {
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if ((!info.isFile() && !info.isSymbolicLink()) || nowMs - info.mtimeMs < 86_400_000) continue;
      try { process.kill(Number(match[1]), 0); continue; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      await unlink(full);
    } catch { /* Races with another cleanup do not invalidate this download. */ }
  }
}

export async function agentDownloadToFile(
  pathname: string,
  token: string,
  destDir: string,
  filePrefix: string,
  signal?: AbortSignal,
): Promise<{ path: string; mime: string; name: string; bytes: number }> {
  signal?.throwIfAborted();
  await cleanupDownloadTemps(destDir);
  const res = await fetch(`${hiveUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` }, signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new Error("Empty download");
  const name = fileNameFromDisposition(res.headers.get("content-disposition") ?? "");
  const dest = path.join(destDir, `${safeFileName(filePrefix)}-${safeFileName(name)}`);
  const tmp = path.join(destDir, `.download-${process.pid}-${randomUUID()}`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > FILE_MAX_BYTES ? new Error("Download exceeds file limit") : null, chunk);
    },
  });
  const input = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  let ownsTemp = false;
  const output = createWriteStream(tmp, { flags: "wx", mode: 0o600 });
  output.once("open", () => { ownsTemp = true; });
  try {
    await pipeline(input, meter,
      output, { signal });
    // Fetch may transparently decompress content; compare length only for identity encoding.
    const declared = res.headers.get("content-length");
    const encoding = res.headers.get("content-encoding");
    if (declared !== null && (!encoding || encoding === "identity") &&
        (!/^\d+$/.test(declared) || Number(declared) !== bytes)) throw new Error("Incomplete download");
    signal?.throwIfAborted();
    await rename(tmp, dest);
    return { path: dest, mime: res.headers.get("content-type") || "application/octet-stream", name, bytes };
  } finally { if (ownsTemp) await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

export async function agentDownload(
  pathname: string,
  token: string,
): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const res = await fetch(`${hiveUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await errorFromResponse(res);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, mime, name: fileNameFromDisposition(res.headers.get("content-disposition") ?? "") };
}
