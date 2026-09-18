import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { imagePreview } from "../server/files.ts";
import { guessMime, resolveUploadMime } from "./mime.ts";

test("guessMime maps allowlisted extensions", () => {
  assert.equal(guessMime("shot.png"), "image/png");
  assert.equal(guessMime("notes.JSON"), "application/json");
  assert.equal(guessMime("noext"), "application/octet-stream");
});

test("resolveUploadMime prefers a valid header then the filename", () => {
  assert.equal(resolveUploadMime("image/png", "x"), "image/png");
  assert.equal(resolveUploadMime("application/octet-stream", "paste.png"), "image/png");
  assert.equal(resolveUploadMime("", "clip.webp"), "image/webp");
  assert.equal(resolveUploadMime(undefined, "paste.png"), "image/png");
});

test("imagePreview never returns a payload over the model cap", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mime-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.png");
  writeFileSync(file, Buffer.alloc(2_000_000, 1));
  const preview = await imagePreview(file, "image/png");
  assert.equal(preview, null);
});
