import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentRequest, agentUpload, agentUploadFile, agentDownload, agentDownloadToFile, HttpError } from "./http.ts";
import { isTransientWaitError, waitUntilMail } from "../mcp/wait-loop.ts";
import type { WaitResult } from "../shared/types.ts";

test("all HTTP helpers retain failing status regardless of body encoding", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-http-errors-"));
  const file = path.join(dir, "input.txt");
  writeFileSync(file, "fixture");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let status = 401;
  let body = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    // Dispose streaming upload inputs in the mock too.
    if (init?.body instanceof ReadableStream) await init.body.cancel();
    return new Response(body, { status });
  });
  const helpers = [
    () => agentRequest("GET", "/fixture", undefined, "fixture-token"),
    () => agentUpload("/fixture", Buffer.from("x"), "fixture-token", "a.txt", "text/plain"),
    () => agentUploadFile("/fixture", file, "fixture-token", "a.txt", "text/plain"),
    () => agentDownload("/fixture", "fixture-token"),
    () => agentDownloadToFile("/fixture", "fixture-token", dir, "download"),
  ];
  for (status of [401, 403, 404, 409, 429, 500, 503]) {
    for (body of ["", "404 Not Found", "<html>Unauthorized</html>", "{broken", '{"error":"Denied","code":"fixture_denied"}']) {
      for (const helper of helpers) {
        await assert.rejects(helper, (err: unknown) => {
          assert.ok(err instanceof HttpError);
          assert.equal(err.status, status);
          assert.equal(isTransientWaitError(err), ![401, 403, 404, 409].includes(status));
          if (body.startsWith('{"error"')) assert.equal(err.code, "fixture_denied");
          return true;
        });
      }
    }
  }
  status = 200;
  body = "not JSON";
  await assert.rejects(() => agentRequest("GET", "/fixture", undefined, "fixture-token"), SyntaxError);
});

test("non-JSON authentication errors stop the actual client-to-wait boundary immediately", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("Unauthorized", { status: 401 }); });
  await assert.rejects(() => waitUntilMail(
    () => agentRequest<WaitResult>("POST", "/api/agent/wait", {}, "bad-token"),
    { maxTransientErrors: 2, retryDelayMs: 1 },
  ), HttpError);
  assert.equal(calls, 1);
});
