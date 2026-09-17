import { mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, statSync } from "node:fs";
import { Readable } from "node:stream";
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

export async function agentRequest<T>(
  method: string,
  pathname: string,
  body?: unknown,
  token?: string | null,
  timeoutMs?: number,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token === null ? undefined : (token ?? currentToken());
  if (t) headers.authorization = `Bearer ${t}`;
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${hiveUrl()}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw responseError(res, data);
    }
    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
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
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw responseError(res, data);
  return data as T;
}

function fileNameFromDisposition(disp: string): string {
  return /filename="([^"]+)"/.exec(disp)?.[1] ?? "file";
}

export async function agentDownloadToFile(
  pathname: string,
  token: string,
  destDir: string,
  filePrefix: string,
): Promise<{ path: string; mime: string; name: string; bytes: number }> {
  const res = await fetch(`${hiveUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    let error = `HTTP ${res.status}`;
    try {
      error = JSON.parse(text).error || error;
    } catch {
      /* keep */
    }
    throw new HttpError(res.status, error);
  }
  if (!res.body) throw new Error("Empty download");
  const name = fileNameFromDisposition(res.headers.get("content-disposition") ?? "");
  const dest = path.join(destDir, `${filePrefix}-${safeFileName(name)}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
  return {
    path: dest,
    mime: res.headers.get("content-type") || "application/octet-stream",
    name,
    bytes: statSync(dest).size,
  };
}

export async function agentDownload(
  pathname: string,
  token: string,
): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const res = await fetch(`${hiveUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    let error = `HTTP ${res.status}`;
    try {
      error = JSON.parse(text).error || error;
    } catch {
      /* keep */
    }
    throw new Error(error);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, mime, name: fileNameFromDisposition(res.headers.get("content-disposition") ?? "") };
}
