import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createRedactor, MAX_LOG_LINE } from "./redact-log.mjs";
import { discoverTests, suiteOf } from "./test-suites.mjs";

test("new TS/TSX/MJS tests are included exactly once and unknown files default to integration", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hive-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["src/shared", "web", "scripts"]) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["src/shared/new.test.ts", "web/new.test.tsx", "scripts/new.test.mjs", "web/ignored.ts"]) await writeFile(path.join(root, file), "");
  const files = await discoverTests(root);
  assert.equal(files.length, 3);
  const unit = files.filter(f => suiteOf(f) === "unit"), integration = files.filter(f => suiteOf(f) === "integration");
  assert.equal(new Set([...unit, ...integration]).size, files.length);
  assert.deepEqual(integration, ["web/new.test.tsx"]);
});

test("redaction survives single-byte chunks, ANSI, key blocks, UTF-8 and oversized lines", async () => {
  const input = 'café\nAuthorization: Bearer abcdefg\n{"token":"json-secret-value"}\nCookie: hive=xyz\nhttps://user:pass@example.test?q=1&api_key=query-secret\n' +
    '-----BEGIN PRIVATE KEY-----\nkey-material\n-----END PRIVATE KEY-----\n' +
    'x'.repeat(MAX_LOG_LINE + 1) + 'SECRET-TAIL\nnext line\n' + 'known-exact-secret\n';
  let output = "";
  for await (const chunk of Readable.from([...Buffer.from(input)].map(b => Buffer.from([b]))).pipe(createRedactor(["known-exact-secret"]))) output += chunk;
  for (const secret of ["abcdefg", "json-secret-value", "hive=xyz", "user:pass", "query-secret", "key-material", "SECRET-TAIL", "known-exact-secret"]) assert.ok(!output.includes(secret), secret);
  assert.match(output, /café/); assert.match(output, /next line/); assert.match(output, /OVERSIZED/);
});

test("retained failure logs are redacted and the command exit status remains failing", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hive-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "failure.log");
  await assert.rejects(promisify(execFile)(process.execPath,
    ["scripts/run-logged.mjs", file, process.execPath, "-e", 'console.error("Authorization: Bearer fixture-secret"); process.exit(7)']),
    error => error.code === 7 && !String(error.stdout).includes("fixture-secret"));
  assert.match(await readFile(file, "utf8"), /REDACTED/);
  assert.ok(!(await readFile(file, "utf8")).includes("fixture-secret"));
});
