import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  filesDir,
  imageDimensions,
  imagePreview,
  removeOrphanBlobs,
} from "./files.ts";

test("image preview rejects oversized PNG dimensions without starting a converter", async () => {
  const bytes = Buffer.alloc(24);
  bytes.write("\x89PNG", 0, "binary");
  bytes.writeUInt32BE(50_000, 16);
  bytes.writeUInt32BE(50_000, 20);
  assert.deepEqual(imageDimensions(bytes, "image/png"), { width: 50_000, height: 50_000 });
  let invoked = false;
  const result = await imagePreview("/does/not/matter", "image/png", bytes, {
    commands: [["missing", () => { invoked = true; return []; }]],
  });
  assert.equal(result, null);
  assert.equal(invoked, false);
});

test("stalled preview command is killed by deadline and leaves no thumbnail", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-preview-"));
  const input = path.join(dir, "image.bin");
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  writeFileSync(input, bytes);
  const started = Date.now();
  const result = await imagePreview(input, "image/webp", bytes, {
    timeoutMs: 60,
    commands: [[process.execPath, (_input, _output) => ["-e", "setTimeout(() => {}, 10000)"]]],
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(
    (await import("node:fs")).readdirSync(dir).some((name) => name.includes(".thumb-")),
    false,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("orphan sweep expires stale temp files but leaves recent uploads alone", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-files-gc-"));
  mkdirSync(filesDir(dir), { recursive: true });
  const old = path.join(filesDir(dir), "part-old");
  const recent = path.join(filesDir(dir), "part-recent");
  writeFileSync(old, "old");
  writeFileSync(recent, "recent");
  utimesSync(old, new Date(0), new Date(0));
  const removed = removeOrphanBlobs(new Set(), dir, { now: Date.now(), staleTempMs: 1000 });
  assert.equal(removed, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  rmSync(dir, { recursive: true, force: true });
});
