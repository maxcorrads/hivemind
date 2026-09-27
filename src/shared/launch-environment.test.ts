import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { childEnv } from "../test-support/child-process.ts";
import {
  LAUNCH_ENVIRONMENT_LIMITS, launchEnvironmentNameProblem, launchEnvironmentPrefix, launchEnvironmentProblem, launchEnvironmentValueProblem,
  parseLaunchEnvironment,
} from "./launch-environment.ts";
import { buildLaunchCommand, launchBlockText, shSingleQuote } from "./launch-prompt.ts";

// The rules HivemindKit's LaunchEnvironment checks too (macos/Tests/HivemindKitTests/LaunchEnvironmentTests.swift).
const vectors = JSON.parse(readFileSync(new URL("./launch-environment.vectors.json", import.meta.url), "utf8")) as {
  validNames: string[]; invalidNames: string[]; deniedNames: string[]; validValues: string[]; invalidValues: string[];
  limits: Record<string, number>;
};

const MARKER = "V4LUE_MARKER";
const JSON_VALUE = `{"snapshot":false,"x":"${MARKER}"}`;

test("names, values and limits follow the vectors the app shares", () => {
  assert.deepEqual(vectors.limits, LAUNCH_ENVIRONMENT_LIMITS);
  for (const name of vectors.validNames) {
    assert.equal(launchEnvironmentNameProblem(name), null, name);
    assert.equal(launchEnvironmentProblem({ [name]: "v" }), null, name);
  }
  for (const name of [...vectors.invalidNames, ...vectors.deniedNames]) {
    assert.notEqual(launchEnvironmentNameProblem(name), null, JSON.stringify(name));
    assert.notEqual(launchEnvironmentProblem({ [name]: "v" }), null, JSON.stringify(name));
  }
  for (const value of vectors.validValues) {
    assert.equal(launchEnvironmentValueProblem(value), null, JSON.stringify(value));
    assert.equal(launchEnvironmentProblem({ A: value }), null, JSON.stringify(value));
  }
  for (const value of [...vectors.invalidValues, "\ud800"]) {
    assert.notEqual(launchEnvironmentValueProblem(value), null, JSON.stringify(value));
    assert.notEqual(launchEnvironmentProblem({ A: value }), null, JSON.stringify(value));
  }
});

test("the payload check enforces the counts and sizes the app does", () => {
  const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`V${i + 1}`, "x"]));
  assert.equal(launchEnvironmentProblem(full), null);
  assert.match(launchEnvironmentProblem({ ...full, V33: "x" })!, /At most 32/);
  assert.equal(launchEnvironmentProblem({ A: "x".repeat(8192) }), null);
  assert.match(launchEnvironmentProblem({ A: "x".repeat(8193) })!, /8 KiB/);
  assert.match(launchEnvironmentProblem({ A: "日".repeat(2731) })!, /8 KiB/, "bytes, not characters");
  const exact = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`V${i + 1}`, "x".repeat(8189)]));
  assert.equal(launchEnvironmentProblem(exact), null, "32,768 bytes of NAME=value");
  assert.match(launchEnvironmentProblem({ ...exact, B: "" })!, /32 KiB/);
  for (const shape of [{}, [], null, "A=b", 7, { A: 1 }]) assert.notEqual(launchEnvironmentProblem(shape), null, JSON.stringify(shape));
});

test("the field takes NAME=value lines, skips blanks and comments, and strips one pair of matching quotes", () => {
  const parsed = parseLaunchEnvironment([
    "# OpenCode",
    "OPENCODE_DISABLE_FFF=1",
    "",
    "   ",
    `OPENCODE_CONFIG_CONTENT=${JSON_VALUE}`,
    "  INDENTED=kept",
    "SPACES=  both ends  ",
    "EMPTY=",
    `DQ="double quoted"`,
    "SQ='single quoted'",
    `MIXED="not stripped'`,
    `ONE="`,
    `INNER=a "b" c`,
    "EQ=a=b=c",
    "HASH=#not a comment",
    "\t# tabbed comment",
  ].join("\r\n"));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.environment, {
    OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: JSON_VALUE, INDENTED: "kept", SPACES: "  both ends  ", EMPTY: "",
    DQ: "double quoted", SQ: "single quoted", MIXED: `"not stripped'`, ONE: `"`, INNER: `a "b" c`, EQ: "a=b=c", HASH: "#not a comment",
  });
  assert.deepEqual(parseLaunchEnvironment(""), { environment: {}, errors: [], warnings: [] });
});

test("a name set twice keeps its last value and says so", () => {
  const parsed = parseLaunchEnvironment("A=1\nB=2\nA=3\nA=4");
  assert.deepEqual(parsed.environment, { B: "2", A: "4" });
  assert.deepEqual(Object.keys(parsed.environment), ["B", "A"], "where it was last set");
  assert.deepEqual(parsed.warnings, ["A is set on lines 1, 3, 4; line 4 wins"]);
  assert.deepEqual(parsed.errors, []);
});

test("refused lines say why by line and name, never by value", () => {
  const parsed = parseLaunchEnvironment([
    `${MARKER} without equals`,
    `1${MARKER}=x`,
    `PATH=${MARKER}`,
    `path=${MARKER}`,
    `LD_PRELOAD=${MARKER}`,
    `DYLD_INSERT_LIBRARIES=${MARKER}`,
    `HIVEMIND_TMUX_SESSION=${MARKER}`,
    `OPENCODE_API_KEY=${MARKER}`,
    `TERM=${MARKER}`,
    `CTRL=${MARKER}\x1b[0m`,
    `BIG=${MARKER}${"x".repeat(8192)}`,
  ].join("\n"));
  assert.equal(parsed.errors.length, 11);
  assert.deepEqual(parsed.environment, {});
  assert.match(parsed.errors[0]!, /^Line 1: expected NAME=value$/);
  assert.match(parsed.errors[1]!, /^Line 2: a name is letters/);
  assert.match(parsed.errors[2]!, /^Line 3: PATH belongs to the shell/);
  assert.match(parsed.errors[3]!, /^Line 4: path belongs to the shell/);
  assert.match(parsed.errors[4]!, /^Line 5: LD_PRELOAD: LD_\* and DYLD_\*/);
  assert.match(parsed.errors[6]!, /^Line 7: HIVEMIND_TMUX_SESSION: Hivemind sets/);
  assert.match(parsed.errors[7]!, /^Line 8: OPENCODE_API_KEY goes in the OpenCode Go API key field/);
  assert.match(parsed.errors[9]!, /^Line 10: a value cannot hold/);
  assert.match(parsed.errors[10]!, /^Line 11: a value is at most 8 KiB/);
  for (const text of [...parsed.errors, ...parsed.warnings]) assert.ok(!text.includes(MARKER), text);
  assert.ok(!(launchEnvironmentProblem({ PATH: MARKER }) ?? "").includes(MARKER));
  assert.ok(!(launchEnvironmentProblem({ A: `${MARKER}\n` }) ?? "").includes(MARKER));
});

test("more than 32 variables or 32 KiB in all is refused as a whole", () => {
  const many = parseLaunchEnvironment(Array.from({ length: 33 }, (_, i) => `V${i}=x`).join("\n"));
  assert.deepEqual(many.errors, ["At most 32 variables (33 here)"]);
  const big = parseLaunchEnvironment(Array.from({ length: 5 }, (_, i) => `V${i}=${"x".repeat(8000)}`).join("\n"));
  assert.deepEqual(big.errors, ["The variables come to more than 32 KiB"]);
  // A duplicate counts once.
  assert.deepEqual(parseLaunchEnvironment(Array.from({ length: 40 }, (_, i) => `V${i % 32}=x`).join("\n")).errors, []);
});

test("the copied command puts each variable, single-quoted, before the command and after the cd", () => {
  const launch = { cwd: "/Users/me/My Acme", command: "opencode --prompt 'hi'" };
  assert.equal(launchBlockText(launch), "cd -- '/Users/me/My Acme' && opencode --prompt 'hi'\n");
  assert.equal(launchBlockText(launch, {}), "cd -- '/Users/me/My Acme' && opencode --prompt 'hi'\n");
  assert.equal(launchBlockText(launch, { OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: '{"snapshot":false}' }),
    `cd -- '/Users/me/My Acme' && OPENCODE_DISABLE_FFF='1' OPENCODE_CONFIG_CONTENT='{"snapshot":false}' opencode --prompt 'hi'\n`);
  assert.equal(launchBlockText({ cwd: null, command: "opencode" }, { A: "it's" }), `A='it'\\''s' opencode\n`);
  assert.equal(launchEnvironmentPrefix({ E: "" }), "E='' ");
  assert.throws(() => launchEnvironmentPrefix({ A: "a\nb" }), /not valid/);
  assert.throws(() => launchEnvironmentPrefix({ "A;id": "x" }), /not valid/);
});

test("a pasted block hands the agent every value exactly, expanding nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivemind-launch-env-"));
  try {
    // The "agent" is a script in the workspace that prints its environment as JSON.
    mkdirSync(path.join(dir, "bin"));
    const agent = path.join(dir, "bin", "envdump");
    writeFileSync(agent, `#!/bin/sh\nexec ${shSingleQuote(process.execPath)} -e 'console.log(JSON.stringify(process.env))'\n`);
    chmodSync(agent, 0o755);
    const environment = {
      OPENCODE_CONFIG_CONTENT: JSON_VALUE,
      QUOTE: "it's a 'quote' and \"double\"",
      DOLLAR: "$HOME ${USER} $(echo pwned) `echo pwned` $((1+1))",
      SPACES: "  lead and trail  ",
      BACKSLASH: "a\\nb\\\\c\\",
      GLOB: "* ? [a] ~ ~/x !! #",
      UNICODE: "héllo 😀 日本  ",
      TAB: "a\tb",
      EMPTY: "",
      SEMI: "a; echo pwned; b && c | d > /dev/null",
    };
    const launch = buildLaunchCommand({ software: "bin/envdump", workspacePath: dir, cdWorktree: true, projectSlug: "acme", passProject: false,
      role: "brain", focus: "coord", adoptUntrusted: false });
    const block = launchBlockText(launch, environment);
    for (const shell of process.platform === "darwin" ? ["zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"]) {
      const result = spawnSync(shell, shell === "zsh" ? ["-f"] : [], { input: block, encoding: "utf8", env: childEnv() });
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
      const seen = JSON.parse(result.stdout) as Record<string, string>;
      for (const [name, value] of Object.entries(environment)) assert.equal(seen[name], value, `${shell} ${name}`);
      assert.ok(!result.stdout.includes("pwned\n") && !/"pwned"/.test(result.stdout), shell);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
