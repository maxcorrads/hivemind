import { Readable } from "node:stream";
import { MAX_WAIT_MS, ORDINARY_REQUEST_MS, REQUEST_BODY_MS, safeInteger, validated } from "../shared/api-contract.ts";
import { createReadStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, opendir, rename, unlink } from "node:fs/promises";
import { FILE_MAX_BYTES } from "../shared/types.ts";
import { streamToTemporaryFile } from "../shared/stream-file.ts";
import path from "node:path";
import { safeFileName } from "../server/files.ts";

import { currentToken, identityOrigin } from "./identity.ts";
export { identitiesDir, identityPath, saveIdentity, loadIdentityFile, loadIdentityByName, currentToken } from "./identity.ts";

export function hiveUrl(): string {
  return identityOrigin();
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
    payload = JSON.parse(await boundedText(res, 8192));
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
  const duration = validated(safeInteger.min(1).max(MAX_WAIT_MS + 10_000), timeoutMs ?? ORDINARY_REQUEST_MS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token === null ? undefined : (token ?? currentToken());
  if (t) headers.authorization = `Bearer ${t}`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException("Request timed out", "TimeoutError")), duration);
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
      signal: AbortSignal.timeout(REQUEST_BODY_MS),
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
  if (!Number.isSafeInteger(size) || size < 1 || size > FILE_MAX_BYTES) throw new Error("Invalid upload size");
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
      signal: AbortSignal.timeout(REQUEST_BODY_MS),
    } as unknown as RequestInit),
  );
}

export async function boundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw new Error("Response exceeds client byte budget");
      text += decoder.decode(item.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  const text = await boundedText(res, 8 * 1024 * 1024);
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
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_BODY_MS)]) : AbortSignal.timeout(REQUEST_BODY_MS);
  signal.throwIfAborted();
  await cleanupDownloadTemps(destDir);
  const res = await fetch(`${hiveUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` }, signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new Error("Empty download");
  const name = fileNameFromDisposition(res.headers.get("content-disposition") ?? "");
  const dest = path.join(destDir, `${safeFileName(filePrefix)}-${safeFileName(name)}`);
  const tmp = path.join(destDir, `.download-${process.pid}-${randomUUID()}`);
  let ownsTemp = false;
  try {
    const bytes = await streamToTemporaryFile(res.body, tmp, FILE_MAX_BYTES, signal);
    ownsTemp = true;
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
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_BODY_MS),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const chunks: Uint8Array[] = []; let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > 8 * 1024 * 1024) throw new Error("Use streaming download for files larger than 8 MiB");
        chunks.push(chunk.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  const bytes = Buffer.concat(chunks, total);
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, mime, name: fileNameFromDisposition(res.headers.get("content-disposition") ?? "") };
}
