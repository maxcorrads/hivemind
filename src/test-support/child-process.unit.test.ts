import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Static guard for #201: every child process a test starts must get its
// environment from childEnv() (src/test-support/child-process.ts), so no child
// inherits the coverage runner's NODE_V8_COVERAGE directory. child_process
// copies that variable into any `env` option that lacks the key, so a child
// with no `env`, or with a hand-built whitelist, still writes coverage there.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const EXEMPT = /child-env:\s*exempt\b/;

function testFiles(relative: string): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(file);
    return /\.test\.(?:tsx?|mjs)$/.test(entry.name) ? [file] : [];
  });
}

/** Index just past the `)` that closes the `(` at `open`, skipping string literals. */
function closing(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
  }
  return source.length;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A local binding (`const env = childEnv(...)` or `const env = (...) => childEnv(...)`). */
function definedByHelper(source: string, name: string): boolean {
  const id = escape(name);
  return new RegExp(`\\b(?:const|let|var)\\s+${id}\\b[^=]*=\\s*(?:\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*)?childEnv\\(`).test(source)
    || new RegExp(`\\bfunction\\s+${id}\\s*\\([^)]*\\)[^{]*\\{\\s*return\\s+childEnv\\(`).test(source);
}

function usesHelper(source: string, args: string): boolean {
  if (/\bchildEnv\(/.test(args)) return true;
  const named = /\benv\s*:\s*([A-Za-z_$][\w$]*)/.exec(args)?.[1] ?? (/[{,]\s*env\s*[,}]/.test(args) ? "env" : undefined);
  return named !== undefined && definedByHelper(source, named);
}

export function childSpawnViolations(source: string): string[] {
  const violations: string[] = [];
  const line = (index: number) => source.slice(0, index).split("\n").length;
  const exempt = (index: number) => {
    const lines = source.split("\n");
    const at = line(index) - 1;
    return EXEMPT.test(lines[at] ?? "") || EXEMPT.test(lines[at - 1] ?? "");
  };
  const check = (index: number, open: number, label: string) => {
    const args = source.slice(open, closing(source, open));
    if (!usesHelper(source, args) && !exempt(index)) {
      violations.push(`line ${line(index)}: ${label} does not take its env from childEnv()`);
    }
  };

  const locals = new Set<string>();
  const imports = /(?:import\s*(\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*from|const\s*(\{[^}]*\})\s*=\s*(?:await\s+)?import\()\s*["'](?:node:)?child_process["']/g;
  const statements: Array<[number, number]> = [];
  for (const match of source.matchAll(imports)) {
    statements.push([match.index, match.index + match[0].length]);
    const clause = match[1] ?? match[2]!;
    if (!clause.startsWith("{")) {
      violations.push(`line ${line(match.index)}: import child_process functions by name so spawns can be checked`);
      continue;
    }
    for (const part of clause.slice(1, -1).split(",")) {
      const [imported, local] = part.trim().split(/\s+as\s+|\s*:\s*/);
      if (imported && SPAWNERS.has(imported)) locals.add(local ?? imported);
    }
  }
  for (const name of locals) {
    for (const match of source.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\b`, "g"))) {
      if (statements.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const after = match.index + name.length;
      // Types (`typeof spawn`) and binding lists (`const { spawn } = require(...)`) start nothing.
      if (/typeof\s+$/.test(source.slice(0, match.index)) || /^\s*[,}]/.test(source.slice(after))) continue;
      const direct = /^\s*\(/.exec(source.slice(after));
      const promisified = /promisify\(\s*$/.test(source.slice(0, match.index)) && /^\s*\)\s*\(/.exec(source.slice(after));
      const call = direct ?? promisified;
      if (!call) {
        if (!exempt(match.index)) violations.push(`line ${line(match.index)}: ${name} is referenced indirectly; call it directly with childEnv()`);
        continue;
      }
      check(match.index, after + call[0].length - 1, `${name}()`);
    }
  }
  for (const match of source.matchAll(/\bnew\s+StdioClientTransport\s*\(/g)) {
    check(match.index, match.index + match[0].length - 1, "StdioClientTransport");
  }
  return violations;
}

test("every child process started by a test gets its environment from childEnv()", () => {
  // This file holds deliberately unguarded fixtures for the checker itself.
  const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join("/");
  const files = ["src", "web", "scripts"].flatMap(testFiles).filter((file) => file !== self).sort();
  assert.ok(files.length > 100, "test discovery found the tree");
  const violations = files.flatMap((file) =>
    childSpawnViolations(readFileSync(path.join(root, file), "utf8")).map((violation) => `${file} ${violation}`));
  assert.deepEqual(violations, [], [
    "A test child inheriting NODE_V8_COVERAGE writes into the coverage runner's directory and can leave",
    "a truncated JSON that aborts the report (#201). Pass env: childEnv(...) from src/test-support/child-process.ts,",
    "or mark a spawn that cannot reach the runner's environment with `// child-env: exempt (<reason>)`.",
  ].join("\n"));
});

test("the static child-env check flags unguarded spawns and accepts guarded ones", () => {
  const imports = 'import { spawn, spawnSync as run, execFile } from "node:child_process";\n';
  const bad = [
    `${imports}spawn(process.execPath, ["-e", ""]);`,
    `${imports}run("node", [], { env: { ...process.env } });`,
    `${imports}const env = { PATH: "" };\nspawn("node", [], { env });`,
    `${imports}const go = promisify(execFile);`,
    `${imports}await promisify(execFile)(process.execPath, ["x"], { cwd: "(" });`,
    'import * as cp from "node:child_process";',
    'const { fork } = await import("node:child_process");\nfork("x.js");',
    'new StdioClientTransport({ command: process.execPath, env: { PATH: "" } });',
  ];
  for (const source of bad) assert.notDeepEqual(childSpawnViolations(source), [], source);
  const good = [
    `${imports}spawn(process.execPath, ["-e", ")"], { env: childEnv() });`,
    `${imports}run("node", [], { env: childEnv({ ...process.env, A: "1" }) });`,
    `${imports}const env = childEnv({ PATH: "" });\nspawn("node", [], { env });`,
    `${imports}const env = (token: string) => childEnv({ TOKEN: token });\nspawn("node", [], { cwd, env: env("t") });`,
    `${imports}await promisify(execFile)(process.execPath, ["x"], { env: childEnv() });`,
    `${imports}// child-env: exempt (runs inside a stripped child)\nspawn(process.execPath, []);`,
    "db.exec('BEGIN'); pattern.exec(text);",
    'new StdioClientTransport({ command: process.execPath, env: childEnv({ PATH: "" }) });',
  ];
  for (const source of good) assert.deepEqual(childSpawnViolations(source), [], source);
});
