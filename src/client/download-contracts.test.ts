import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { childEnv } from "../test-support/child-process.ts";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentDownloadToFile, cleanupDownloadTemps, HttpError } from "./http.ts";

for (const outcome of ["success", "interrupted", "length-mismatch", "cancelled", "http-error"]) {
  test(`atomic download ${outcome}: no partial destination or leftover files`, async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-download-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dest = path.join(dir, "prefix-file.txt");
    writeFileSync(dest, "previous");
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async (_url: unknown, opts: RequestInit) => {
      assert.ok(opts.signal);
      assert.equal(opts.signal.aborted, controller.signal.aborted);
      controller.signal.addEventListener("abort", () => assert.equal(opts.signal!.aborted, true), { once: true });
      if (outcome === "http-error") return new Response("<html>denied</html>", { status: 403 });
      let count = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (count++ === 0) { c.enqueue(Buffer.from("complete")); return; }
          if (outcome === "interrupted") c.error(new Error("interrupted transfer"));
          else if (outcome === "cancelled") controller.abort();
          else c.close();
        },
      }), { headers: { "content-disposition": 'attachment; filename="file.txt"', "content-length": outcome === "length-mismatch" ? "99" : "8" } });
    });
    const download = agentDownloadToFile("/fixture", "fixture-token", dir, "prefix", controller.signal);
    if (outcome === "success") {
      const file = await download;
      assert.equal(file.path, dest);
      assert.equal(file.bytes, 8);
      assert.equal(readFileSync(dest, "utf8"), "complete");
    } else {
      if (outcome === "http-error") await assert.rejects(download, (err: unknown) => err instanceof HttpError && err.status === 403);
      else await assert.rejects(download);
      assert.equal(readFileSync(dest, "utf8"), "previous");
    }
    assert.deepEqual(readdirSync(dir), ["prefix-file.txt"]);
  });
}

test("download cleanup preserves active owners and reaps crash leftovers", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-download-reap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ["-e", ""], { env: childEnv() });
  assert.equal(child.status, 0);
  const dead = path.join(dir, `.download-${child.pid}-aaaa-bbbb`);
  const live = path.join(dir, `.download-${process.pid}-aaaa-bbbb`);
  for (const file of [dead, live]) { writeFileSync(file, "part"); utimesSync(file, 0, 0); }
  await cleanupDownloadTemps(dir);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
});
