import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { imagePreview } from "./image-preview.ts";
import { PNG } from "./fixtures/preview-images.ts";

test("a decoder timeout ends fallback even when the monotonic deadline has not advanced", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-preview-deadline-")), input = path.join(dir, "input");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(input, PNG);
  const now = performance.now();
  t.mock.method(performance, "now", () => now);
  const realTimeout = globalThis.setTimeout;
  // Leave the outer shared deadline intact; expire the per-decoder timer
  // immediately. This models runtime timer rounding without an 80 ms race.
  let registered = 0, calls = 0;
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realTimeout(callback, ++registered === 2 ? 1 : delay, ...args)) as typeof setTimeout);
  const command: [string, () => string[]] = [process.execPath, () => {
    calls++; return ["-e", "setInterval(() => {}, 1000)"];
  }];
  assert.equal(await imagePreview(input, "image/png", { timeoutMs: 1000, commands: [command, command] }), null);
  assert.equal(calls, 1);
});

