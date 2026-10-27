import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { imagePreview } from "../server/files.ts";
import { guessMime, INLINE_IMAGE_MIMES, isInlineImageMime, isInlineMime, isValidMime, resolveUploadMime } from "./mime.ts";

test("guessMime maps known extensions and leaves the rest opaque", () => {
  assert.equal(guessMime("shot.png"), "image/png");
  assert.equal(guessMime("notes.JSON"), "application/json");
  assert.equal(guessMime("page.html"), "text/html");
  assert.equal(guessMime("logo.svg"), "image/svg+xml");
  assert.equal(guessMime("noext"), "application/octet-stream");
  assert.equal(guessMime("data.unknown-ext"), "application/octet-stream");
});

test("resolveUploadMime prefers a valid header then the filename, for any type", () => {
  assert.equal(resolveUploadMime("image/png", "x"), "image/png");
  assert.equal(resolveUploadMime("application/octet-stream", "paste.png"), "image/png");
  assert.equal(resolveUploadMime("", "clip.webp"), "image/webp");
  assert.equal(resolveUploadMime(undefined, "paste.png"), "image/png");
  assert.equal(resolveUploadMime("text/html", "x"), "text/html");
  assert.equal(resolveUploadMime("Image/SVG+XML", "x"), "image/svg+xml");
  assert.equal(resolveUploadMime("text/plain; charset=utf-8", "x"), "text/plain");
  assert.equal(resolveUploadMime("not a type", "a.txt"), "text/plain");
  assert.equal(resolveUploadMime("text/html\r\nx-injected: 1", "x"), "application/octet-stream");
  assert.equal(resolveUploadMime(undefined, "blob.bin"), "application/octet-stream");
});

test("only raster images, PDF and plain text preview inline; never SVG or HTML", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]) assert.ok(isInlineMime(mime), mime);
  for (const mime of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/xml", "text/csv",
    "application/json", "application/zip", "application/octet-stream", "text/javascript", "IMAGE/PNG", "image/png; x=1"]) {
    assert.equal(isInlineMime(mime), false, mime);
  }
  assert.deepEqual([...INLINE_IMAGE_MIMES].filter(isInlineImageMime), ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.equal(isInlineImageMime("image/svg+xml"), false);
  assert.equal(isInlineImageMime("application/pdf"), false);
  assert.ok(isValidMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  for (const bad of ["", "text", "text/", "/html", "text/html; charset=utf-8", "Text/HTML", "text/html\n", "a/b/c"]) assert.equal(isValidMime(bad), false, bad);
});

test("imagePreview never returns a payload over the model cap", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mime-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.png");
  writeFileSync(file, Buffer.alloc(2_000_000, 1));
  const preview = await imagePreview(file, "image/png");
  assert.equal(preview, null);
});
