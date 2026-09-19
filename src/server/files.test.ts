import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once, getEventListeners } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Hive } from "./hive.ts";
import { commitUpload, filePathForHash, filesDir, imageDimensions, imagePreview, openBlob, removeOrphanBlobs, streamUpload, uploadTempName } from "./files.ts";
import { cleanupPreviewTemps, previewMetrics, IMAGE_PREVIEW_MAX_SOURCE_BYTES } from "./image-preview.ts";
import { PNG, JPEG } from "./fixtures/preview-images.ts";

function temp(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-file-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function store(t: TestContext, uploadLimits = {}) {
  const dir = temp(t);
  const hive = new Hive(path.join(dir, "hive.db"), { uploadLimits });
  t.after(() => hive.db.close());
  return { dir, hive, human: hive.getAgent("human") };
}
function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
function encode(output: Buffer): [string, (input: string, dest: string) => string[]] {
  return [process.execPath, (_input, dest) => ["-e", `require('node:fs').writeFileSync(process.argv[1], Buffer.from('${output.toString("base64")}', 'base64'))`, dest]];
}

for (const mime of ["image/png", "image/jpeg"]) test(`valid ${mime} input produces a bounded real JPEG and removes temporary output`, async (t) => {
  const dir = temp(t);
  const input = path.join(dir, "image");
  writeFileSync(input, mime === "image/png" ? PNG : JPEG);
  assert.deepEqual(imageDimensions(readFileSync(input), mime), { width: 2, height: 3 });
  let outputPath = "";
  const command = encode(JPEG);
  const result = await imagePreview(input, mime, { commands: [[command[0], (source, output) => {
    assert.notEqual(source, input);
    outputPath = output;
    return command[1](source, output);
  }]] });
  assert.deepEqual(result?.data, JPEG);
  assert.equal(result?.mime, "image/jpeg");
  assert.equal(existsSync(path.dirname(outputPath)), false);
});

for (const kind of ["huge-pixels", "pixel-product", "zero-size", "truncated", "malformed", "unsupported", "oversized-source", "symlink"]) {
  test(`preview rejects ${kind} input before invoking any decoder`, async (t) => {
    const dir = temp(t);
    const file = path.join(dir, "input");
    let bytes = Buffer.from(PNG);
    if (kind === "huge-pixels") { bytes.writeUInt32BE(50_000, 16); bytes.writeUInt32BE(50_000, 20); }
    if (kind === "pixel-product") { bytes.writeUInt32BE(8000, 16); bytes.writeUInt32BE(8000, 20); }
    if (kind === "zero-size") bytes.writeUInt32BE(0, 16);
    if (kind === "truncated") bytes = bytes.subarray(0, 25);
    if (kind === "malformed") bytes[0] = 0;
    if (kind === "oversized-source") bytes = Buffer.alloc(IMAGE_PREVIEW_MAX_SOURCE_BYTES + 1);
    writeFileSync(file, bytes);
    if (kind === "symlink") symlinkSync(file, `${file}.link`);
    let calls = 0;
    const result = await imagePreview(kind === "symlink" ? `${file}.link` : file, kind === "unsupported" ? "image/webp" : "image/png", {
      commands: [["not-run", () => { calls++; return []; }]],
    });
    assert.equal(result, null);
    assert.equal(calls, 0);
  });
}

test("malformed, oversized and symlinked converter outputs never reach the model", async (t) => {
  const dir = temp(t);
  const input = path.join(dir, "input");
  writeFileSync(input, PNG);
  for (const source of [
    `require('node:fs').writeFileSync(process.argv[1], 'not a jpeg')`,
    `require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(2000000))`,
    `require('node:fs').symlinkSync(process.argv[2], process.argv[1])`,
  ]) {
    let output = "";
    assert.equal(await imagePreview(input, "image/png", { commands: [[process.execPath, (_source, dest) => {
      output = dest;
      return ["-e", source, dest, input];
    }]] }), null);
    assert.equal(existsSync(path.dirname(output)), false);
  }
});

test("missing tools fall back to metadata; a stalled converter consumes one shared deadline", async (t) => {
  const dir = temp(t);
  const input = path.join(dir, "input");
  writeFileSync(input, PNG);
  assert.equal(await imagePreview(input, "image/png", { commands: [[path.join(dir, "missing"), () => []]] }), null);
  let calls = 0;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const command: [string, () => string[]] = [process.execPath, () => { calls++; return ["-e", "setInterval(() => {}, 1000)"]; }];
    assert.equal(await imagePreview(input, "image/png", { commands: [command, command], timeoutMs: 80 }), null);
    assert.equal(calls, 1);
    assert.ok(ticks > 0, "heartbeat/event loop kept running");
  } finally { clearInterval(timer); }
});

test("parallel previews have two slots, cancellation kills children and releases slots/listeners", async (t) => {
  const dir = temp(t);
  const input = path.join(dir, "input");
  writeFileSync(input, PNG);
  const controller = new AbortController();
  let launched = 0;
  const outputs: string[] = [];
  const command: [string, (_source: string, dest: string) => string[]] = [process.execPath, (_source, dest) => {
    outputs.push(dest);
    if (++launched === 2) queueMicrotask(() => controller.abort());
    return ["-e", "setInterval(() => {}, 1000)"];
  }];
  const results = await Promise.all(Array.from({ length: 8 }, () => imagePreview(input, "image/png", { commands: [command], signal: controller.signal })));
  assert.equal(launched, 2);
  assert.ok(results.every((r) => r === null));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.ok(outputs.every((out) => !existsSync(path.dirname(out))));
  assert.equal(await imagePreview(input, "image/png", { commands: [command], signal: controller.signal }), null);
  assert.equal(launched, 2);
  assert.deepEqual((await imagePreview(input, "image/png", { commands: [encode(JPEG)] }))?.data, JPEG);
});

test("uploads reject empty, interrupted and cancelled streams and remove partial data", async (t) => {
  const dir = temp(t);
  await assert.rejects(streamUpload(null, "text/plain", dir), /Empty/);
  await assert.rejects(streamUpload(body(new Uint8Array()), "text/plain", dir), /Empty/);
  await assert.rejects(streamUpload(new ReadableStream({ start(c) { c.enqueue(Buffer.from("part")); c.error(new Error("interrupted")); } }), "text/plain", dir), /interrupted/);
  const controller = new AbortController();
  const upload = streamUpload(new ReadableStream({ start(c) { c.enqueue(Buffer.from("part")); } }), "text/plain", dir, controller.signal);
  controller.abort();
  await assert.rejects(upload);
  assert.deepEqual(readdirSync(filesDir(dir)), []);
});

test("identical concurrent uploads retain every attachment and survive garbage collection", async (t) => {
  // This fixture targets publication/GC races, not production admission limits.
  const { hive, human, dir } = store(t, { active: 8, perActor: 8 });
  const atts = await Promise.all(Array.from({ length: 8 }, () => hive.createFileFromBytes(human, { name: "same", mime: "text/plain", bytes: Buffer.from("same") })));
  assert.equal(new Set(atts.map((a) => a.id)).size, 8);
  assert.equal(readdirSync(filesDir(dir)).length, 1);
  assert.deepEqual(hive.gcFiles(), { attachments: 0, blobs: 0 });
  for (const att of atts) assert.equal(readFileSync(filePathForHash(hive.getAttachment(human, att.id).sha256, dir), "utf8"), "same");
});

test("metadata failures and GC commit failures never leave committed references to missing files", async (t) => {
  const { hive, human, dir } = store(t);
  hive.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'metadata failed'); END");
  await assert.rejects(hive.createFileFromBytes(human, { name: "x", mime: "text/plain", bytes: Buffer.from("x") }), /metadata failed/);
  assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM attachments").get()?.n, 0);
  assert.equal(hive.gcFiles().blobs, 1);
  assert.deepEqual(readdirSync(filesDir(dir)), []);
  hive.db.exec("DROP TRIGGER fail_attachment");
  const att = await hive.createFileFromBytes(human, { name: "x", mime: "text/plain", bytes: Buffer.from("x") });
  const hash = hive.getAttachment(human, att.id).sha256;
  hive.db.exec("UPDATE attachments SET created_at = 0");
  const exec = hive.db.exec.bind(hive.db);
  const mock = t.mock.method(hive.db, "exec", (sql: string) => { if (sql === "COMMIT") throw new Error("commit failed"); exec(sql); });
  assert.throws(() => hive.gcFiles(), /commit failed/);
  mock.mock.restore();
  assert.equal(hive.getAttachment(human, att.id).sha256, hash);
  assert.equal(existsSync(filePathForHash(hash, dir)), true);
  assert.deepEqual(hive.gcFiles(), { attachments: 1, blobs: 1 });
});

test("sweeps preserve old active uploads, expire dead owners, and never follow symlinks", async (t) => {
  const dir = temp(t);
  mkdirSync(filesDir(dir));
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  const alive = path.join(filesDir(dir), uploadTempName());
  const fd = openSync(alive, "wx");
  t.after(() => closeSync(fd));
  const expired = path.join(filesDir(dir), `part-p${dead.pid}-aaaaaaaa-bbbb`);
  const recent = path.join(filesDir(dir), `part-p${dead.pid}-cccccccc-dddd`);
  const legacy = path.join(filesDir(dir), "part-old");
  for (const file of [expired, recent, legacy]) writeFileSync(file, "data");
  for (const file of [alive, expired, legacy]) utimesSync(file, 0, 0);
  const outside = path.join(dir, "outside");
  writeFileSync(outside, "outside");
  symlinkSync(outside, filePathForHash("a".repeat(64), dir));
  symlinkSync(path.join(dir, "missing"), filePathForHash("b".repeat(64), dir));
  assert.equal(removeOrphanBlobs(new Set(), dir), 3);
  assert.ok(existsSync(alive) && existsSync(recent) && existsSync(legacy));
  assert.equal(readFileSync(outside, "utf8"), "outside");
  const previewRoot = path.join(dir, "previews");
  mkdirSync(previewRoot);
  const deadPreview = path.join(previewRoot, `p${dead.pid}-abcdef`);
  const livePreview = path.join(previewRoot, `p${process.pid}-abcdef`);
  for (const file of [deadPreview, livePreview]) { mkdirSync(file); utimesSync(file, 0, 0); }
  await cleanupPreviewTemps(previewRoot);
  assert.equal(existsSync(deadPreview), false);
  assert.equal(existsSync(livePreview), true);
});

test("blob paths, publication and downloads reject traversal and symlink targets", async (t) => {
  const dir = temp(t);
  assert.throws(() => filePathForHash("../outside", dir), /Invalid blob hash/);
  const upload = await streamUpload(body(Buffer.from("x")), "text/plain", dir);
  const dest = filePathForHash(upload.sha256, dir);
  symlinkSync(path.join(dir, "missing"), dest);
  assert.throws(() => commitUpload(upload.tmp, upload.sha256, dir), /Invalid existing blob/);
  assert.throws(() => openBlob(upload.sha256, dir));
  assert.throws(() => commitUpload(path.join(dir, "outside"), upload.sha256, dir), /Invalid upload path/);
  const other = path.join(dir, "linked-home");
  mkdirSync(other);
  symlinkSync(filesDir(dir), filesDir(other));
  await assert.rejects(streamUpload(body(Buffer.from("x")), "text/plain", other), /symlink/);
});

test("a separate GC process cannot enter the publish-to-metadata window", { timeout: 10_000 }, async (t) => {
  const { dir, hive } = store(t);
  const file = path.join(dir, "hive.db");
  const script = path.join(dir, "publisher.mjs");
  const hiveUrl = new URL("./hive.ts", import.meta.url).href;
  writeFileSync(script, `
    import { Hive } from ${JSON.stringify(hiveUrl)};
    import { readSync } from 'node:fs';
    const hive = new Hive(process.argv[2]);
    const prepare = hive.db.prepare.bind(hive.db);
    hive.db.prepare = (sql) => {
      if (sql.includes('INSERT INTO attachments')) {
        process.send({ published: true });
        readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      return prepare(sql);
    };
    try {
      const att = await hive.createFileFromBytes(hive.getAgent('human'), {name:'interleaving', mime:'text/plain', bytes:Buffer.from('published')});
      process.send({id:att.id});
    } finally { hive.db.close(); process.disconnect(); }
  `);
  const publisher = spawn(process.execPath, ["--import", "tsx", script, file], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  t.after(() => publisher.kill("SIGKILL"));
  let errors = "";
  publisher.stderr!.on("data", (data) => { errors += data; });
  const pubExit = once(publisher, "exit");
  assert.deepEqual((await once(publisher, "message"))[0], { published: true });
  assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM attachments").get()?.n, 0);
  assert.equal(readdirSync(filesDir(dir)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 1);
  const gcScript = path.join(dir, "gc.mjs");
  writeFileSync(gcScript, `
    import { Hive } from ${JSON.stringify(hiveUrl)};
    import { DatabaseSync } from 'node:sqlite';
    const probe = new DatabaseSync(process.argv[2]);
    let locked = false;
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); } catch { locked = true; }
    probe.close(); process.send({locked});
    const hive = new Hive(process.argv[2]);
    try { process.send(hive.gcFiles()); } finally { hive.db.close(); process.disconnect(); }
  `);
  const collector = spawn(process.execPath, ["--import", "tsx", gcScript, file], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => collector.kill("SIGKILL"));
  collector.stderr!.on("data", (data) => { errors += data; });
  const gcExit = once(collector, "exit");
  assert.deepEqual((await once(collector, "message"))[0], { locked: true });
  const receipt = once(publisher, "message");
  const collected = once(collector, "message");
  publisher.stdin!.end("x");
  const { id } = (await receipt)[0] as { id: string };
  assert.deepEqual((await collected)[0], { attachments: 0, blobs: 0 });
  assert.equal((await pubExit)[0], 0, errors);
  assert.equal((await gcExit)[0], 0, errors);
  const expected = createHash("sha256").update("published").digest("hex");
  assert.equal(hive.getAttachment(hive.getAgent("human"), id).sha256, expected);
  assert.equal(readFileSync(filePathForHash(expected, dir), "utf8"), "published");
});

test("preview counters expose only numeric process-local diagnostics", async (t) => {
  const dir = temp(t);
  const file = path.join(dir, "image");
  writeFileSync(file, PNG);
  const before = previewMetrics();
  await imagePreview(file, "image/png", { commands: [encode(JPEG)] });
  const after = previewMetrics();
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.previews, before.previews + 1);
  assert.equal(after.active, 0);
  assert.ok(after.totalDurationMs >= before.totalDurationMs);
  assert.ok(Object.values(after).every((value) => typeof value === "number"));
});
