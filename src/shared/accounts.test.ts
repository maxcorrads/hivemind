import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { childEnv } from "../test-support/child-process.ts";
import {
  ACCOUNT_CONTROLLED_ENV, ACCOUNT_DRIVERS, ACCOUNT_ENV, ACCOUNT_ERRORS, ACCOUNT_LIMITS, ACCOUNT_POLICIES, USAGE_STALE_MS,
  accountDriverForSoftware, accountEnvironment, accountEnvironmentConflict, accountLoginCommand, accountPathProblem,
  accountSpecSchema, softwareAliasWarning, toLaunchAccount, usageSnapshotSchema, usageWindowSchema,
  type AccountDriver, type AgentAccount, type LaunchAccount, type UsageSnapshot,
} from "./accounts.ts";
import { shSingleQuote } from "./launch-prompt.ts";

// The rules HivemindKit's LaunchAccount checks too (macos/Tests/HivemindKitTests/LaunchAccountTests.swift).
const vectors = JSON.parse(readFileSync(new URL("./account-paths.vectors.json", import.meta.url), "utf8")) as {
  limits: Record<string, number>;
  controlledEnv: Record<string, string[]>;
  validPaths: string[];
  invalidPaths: Array<{ path: string; problem: string }>;
  environments: Array<{ account: Pick<LaunchAccount, "driver" | "homePath" | "shadowPath">; environment: Array<{ name: string; value: string }> }>;
};

// The conflict rule HivemindKit's LaunchAccount checks too (macos/Tests/HivemindKitTests/LaunchAccountTests.swift).
const conflictVectors = JSON.parse(readFileSync(new URL("./account-environment.vectors.json", import.meta.url), "utf8")) as {
  cases: Array<{
    account: Pick<LaunchAccount, "driver" | "label" | "homePath" | "shadowPath">;
    environment: Record<string, string>;
    secretNames: string[];
    message: string | null;
  }>;
};

const launchAccount = (driver: AccountDriver, homePath = "", shadowPath = "", label = "Work"): LaunchAccount =>
  ({ id: "00000000-0000-4000-8000-000000000001", driver, label, homePath, shadowPath });

const snapshot = (overrides: Partial<UsageSnapshot> = {}): Record<string, unknown> => ({
  accountId: "00000000-0000-4000-8000-000000000001", capturedAt: 1791802000000, source: "claude", plan: "subscription",
  windows: [{ key: "five_hour", label: "5 h", usedPercent: 23.5, resetsAt: 1791820800000 },
    { key: "seven_day", label: "Week", usedPercent: 100, resetsAt: null }],
  error: null, limitErrorAt: null, ...overrides,
});

test("the constants are the ones every later phase names", () => {
  assert.deepEqual(ACCOUNT_DRIVERS, ["codex", "claude"]);
  assert.deepEqual(ACCOUNT_POLICIES, ["sequential", "balanced"]);
  assert.deepEqual(ACCOUNT_ENV, { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR" });
  assert.deepEqual(ACCOUNT_ERRORS, { exhausted: "accounts_exhausted", pinned: "account_pinned", unknown: "account_unknown",
    conflict: "account_env_conflict", driverMismatch: "account_driver_mismatch" });
  assert.equal(USAGE_STALE_MS, 600_000);
  for (const driver of ACCOUNT_DRIVERS) assert.ok((ACCOUNT_CONTROLLED_ENV[driver] as readonly string[]).includes(ACCOUNT_ENV[driver]), driver);
});

test("paths, limits and controlled names follow the vectors the app shares", () => {
  assert.deepEqual(vectors.limits, ACCOUNT_LIMITS);
  assert.deepEqual(vectors.controlledEnv, ACCOUNT_CONTROLLED_ENV);
  for (const valid of vectors.validPaths) {
    assert.equal(accountPathProblem(valid), null, JSON.stringify(valid));
    assert.ok(accountSpecSchema.safeParse({ driver: "codex", label: "A", homePath: valid, shadowPath: "" }).success, JSON.stringify(valid));
  }
  for (const { path: invalid, problem } of vectors.invalidPaths) {
    assert.equal(accountPathProblem(invalid), problem, JSON.stringify(invalid));
    for (const field of ["homePath", "shadowPath"] as const) {
      const parsed = accountSpecSchema.safeParse({ driver: "claude", label: "A", homePath: "", shadowPath: "", [field]: invalid });
      assert.ok(!parsed.success, `${field} ${JSON.stringify(invalid)}`);
      assert.equal(parsed.error.issues[0]!.message, problem);
      assert.deepEqual(parsed.error.issues[0]!.path, [field]);
    }
  }
  // Not representable in the shared JSON (Swift strings have no lone surrogates).
  assert.equal(accountPathProblem("/a\ud800"), "a path cannot hold control characters");
});

test("a path is at most 1024 UTF-8 bytes", () => {
  const max = vectors.limits.path!;
  assert.equal(accountPathProblem("/" + "a".repeat(max - 1)), null);
  assert.equal(accountPathProblem("~/" + "a".repeat(max - 2)), null);
  assert.equal(accountPathProblem("/" + "a".repeat(max)), "a path is at most 1024 bytes");
  assert.equal(accountPathProblem("/" + "é".repeat(511) + "a"), null, "1,024 bytes in 513 characters");
  assert.equal(accountPathProblem("/" + "é".repeat(512)), "a path is at most 1024 bytes", "bytes, not characters");
});

test("a spec is strict, trims its label and keeps a shadow off the shared tree", () => {
  const spec = { driver: "codex", label: "  Codex work  ", homePath: "", shadowPath: "~/.codex_personal" };
  assert.deepEqual(accountSpecSchema.parse(spec), { ...spec, label: "Codex work" });
  assert.ok(accountSpecSchema.safeParse({ ...spec, label: "x".repeat(80) }).success);
  for (const bad of [
    { ...spec, label: "x".repeat(81) }, { ...spec, label: "   " }, { ...spec, driver: "opencode" }, { ...spec, command: "codex" },
    { ...spec, id: "x" }, { driver: "codex", label: "A", homePath: "" }, { ...spec, homePath: null },
  ]) assert.ok(!accountSpecSchema.safeParse(bad).success, JSON.stringify(bad));
  for (const [driver, homePath, shadowPath] of [
    ["codex", "", "~/.codex"], ["claude", "", "~/.claude"], ["codex", "~/.c", "~/.c"], ["claude", "/x/y", "/x/y"], ["claude", "/café", "/café"],
  ]) {
    const parsed = accountSpecSchema.safeParse({ driver, label: "A", homePath, shadowPath });
    assert.ok(!parsed.success, `${driver} ${shadowPath}`);
    assert.deepEqual(parsed.error.issues.map(issue => [issue.path, issue.message]), [[["shadowPath"], "a shadow is its own directory, not the shared tree"]]);
  }
  // A primary may name the default tree; only a shadow cannot be it.
  assert.ok(accountSpecSchema.safeParse({ driver: "claude", label: "A", homePath: "~/.claude", shadowPath: "" }).success);
  assert.ok(accountSpecSchema.safeParse({ driver: "codex", label: "A", homePath: "~/.codex", shadowPath: "~/.claude" }).success);
});

test("a launch carries the account's paths and nothing of the catalog", () => {
  const account: AgentAccount = {
    id: "a1", driver: "claude", command: "claude", label: "Claude work", homePath: "", shadowPath: "~/.claude-work", order: 2,
    revision: 3, lastSelectedAt: null, createdAt: 1, updatedAt: 2,
  };
  assert.deepEqual(toLaunchAccount(account), { id: "a1", driver: "claude", label: "Claude work", homePath: "", shadowPath: "~/.claude-work" });
});

test("the variables follow the vectors the app shares, values unexpanded", () => {
  assert.ok(vectors.environments.length >= 8);
  for (const { account, environment } of vectors.environments) {
    assert.deepEqual(accountEnvironment({ ...launchAccount(account.driver), ...account }), environment, JSON.stringify(account));
  }
});

test("an account manages its driver's variables, in the environment or the secrets, without case", () => {
  const codex = launchAccount("codex", "", "", "Codex work");
  const claude = launchAccount("claude", "~/.claude-work", "", "Claude work");
  for (const name of ACCOUNT_CONTROLLED_ENV.codex) {
    assert.equal(accountEnvironmentConflict({ [name]: "x" }, [], codex), `${name} is managed by the account Codex work; remove it.`);
    assert.equal(accountEnvironmentConflict({}, [name], codex), `${name} is managed by the account Codex work; remove it.`);
    assert.equal(accountEnvironmentConflict({ [name]: "x" }, [name], claude), null, "another driver's name");
  }
  for (const name of ACCOUNT_CONTROLLED_ENV.claude) {
    assert.equal(accountEnvironmentConflict({ A: "1", [name]: "x" }, ["OPENCODE_API_KEY"], claude), `${name} is managed by the account Claude work; remove it.`);
    assert.equal(accountEnvironmentConflict({}, ["B", name], claude), `${name} is managed by the account Claude work; remove it.`);
  }
  assert.equal(accountEnvironmentConflict({ codex_home: "x" }, [], codex), "codex_home is managed by the account Codex work; remove it.");
  assert.equal(accountEnvironmentConflict({}, ["Anthropic_Api_Key"], claude), "Anthropic_Api_Key is managed by the account Claude work; remove it.");
  assert.equal(accountEnvironmentConflict({ CODEX_HOME: "x" }, ["CODEX_API_KEY"], codex), "CODEX_HOME is managed by the account Codex work; remove it.",
    "the environment is named first");
  assert.equal(accountEnvironmentConflict({ CODEX_HOME: "secret-value" }, [], null), null, "no account manages nothing");
  assert.equal(accountEnvironmentConflict({ CODEX_HOMES: "x", MY_CODEX_HOME: "x", HOME_DIR: "x" }, ["CLAUDE_API_KEY"], codex), null);
  assert.ok(!accountEnvironmentConflict({ CODEX_HOME: "V4LUE_MARKER" }, [], codex)!.includes("V4LUE_MARKER"), "never a value");
});

test("the conflicts follow the vectors the app shares, every controlled name among them", () => {
  assert.ok(conflictVectors.cases.length >= 20);
  for (const driver of ACCOUNT_DRIVERS) {
    for (const name of ACCOUNT_CONTROLLED_ENV[driver]) {
      assert.ok(conflictVectors.cases.some(item => item.account.driver === driver && (name in item.environment || item.secretNames.includes(name))), name);
    }
  }
  for (const { account, environment, secretNames, message } of conflictVectors.cases) {
    const launch = launchAccount(account.driver, account.homePath, account.shadowPath, account.label);
    assert.equal(accountEnvironmentConflict(environment, secretNames, launch), message, JSON.stringify({ account, environment, secretNames }));
  }
});

test("only exactly codex or claude takes an account; an alias of a driver with accounts warns", () => {
  assert.equal(accountDriverForSoftware("codex"), "codex");
  assert.equal(accountDriverForSoftware("claude"), "claude");
  assert.equal(accountDriverForSoftware(""), "codex", "an empty Software field launches codex");
  assert.equal(accountDriverForSoftware("  claude "), "claude");
  for (const software of ["codex2", "Codex", "CLAUDE", "claude-work", "codex-hm", "/opt/homebrew/bin/codex", "bin/claude", "opencode", "agent", "x"]) {
    assert.equal(accountDriverForSoftware(software), null, software);
  }
  const both = new Set<AccountDriver>(["codex", "claude"]);
  assert.equal(softwareAliasWarning("codex2", new Set(["codex"])),
    "codex2 launches without a Codex account: accounts apply only when Software is exactly codex.");
  assert.equal(softwareAliasWarning(" claude-work ", both),
    "claude-work launches without a Claude account: accounts apply only when Software is exactly claude.");
  assert.equal(softwareAliasWarning("codex2", new Set()), null, "no Codex accounts");
  assert.equal(softwareAliasWarning("codex2", new Set(["claude"])), null, "only Claude accounts");
  for (const software of ["codex", "claude", "", "opencode", "opencode-hm", "agent", "cursor-agent"]) assert.equal(softwareAliasWarning(software, both), null, software);
});

test("the login commands set the account's variables and never HOME", () => {
  const cases: Array<[Pick<LaunchAccount, "driver" | "homePath" | "shadowPath">, string]> = [
    [{ driver: "codex", homePath: "", shadowPath: "" }, "codex login"],
    [{ driver: "codex", homePath: "~/.codex-work", shadowPath: "" }, "CODEX_HOME=~/.codex-work codex login"],
    [{ driver: "codex", homePath: "", shadowPath: "~/.codex_personal" },
      "mkdir -p ~/.codex_personal && CODEX_HOME=~/.codex_personal CODEX_SQLITE_HOME=~/.codex codex -c cli_auth_credentials_store=file login"],
    [{ driver: "codex", homePath: "/Users/test/shared codex", shadowPath: "~/codex work" },
      "mkdir -p ~/'codex work' && CODEX_HOME=~/'codex work' CODEX_SQLITE_HOME='/Users/test/shared codex' codex -c cli_auth_credentials_store=file login"],
    [{ driver: "claude", homePath: "", shadowPath: "" }, "claude auth login"],
    [{ driver: "claude", homePath: "~/.claude-work", shadowPath: "" }, "mkdir -p ~/.claude-work && CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"],
    [{ driver: "claude", homePath: "~/.claude-shared", shadowPath: "~/.claude-personal" },
      "mkdir -p ~/.claude-personal && CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login"],
    [{ driver: "claude", homePath: "", shadowPath: "~/it's $HOME" }, `mkdir -p ~/'it'\\''s $HOME' && CLAUDE_CONFIG_DIR=~/'it'\\''s $HOME' claude auth login`],
  ];
  for (const [spec, command] of cases) {
    assert.equal(accountLoginCommand(spec), command);
    assert.doesNotMatch(command, /(^|[\s;&|])HOME=/, command);
  }
  for (const bad of ["~/a/", "relative", "/a/../b", "/a\nrm -rf ~"]) {
    assert.throws(() => accountLoginCommand({ driver: "claude", homePath: "", shadowPath: bad }), /not valid/);
    assert.throws(() => accountLoginCommand({ driver: "codex", homePath: bad, shadowPath: "" }), /not valid/);
  }
});

test("a pasted login command exports exactly the paths the broker will, ~/ expanded with the home", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivemind-accounts-"));
  try {
    // A fake HOME, and fake codex and claude that print their arguments and the variables they were given.
    const home = path.join(dir, "home");
    const bin = path.join(dir, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    const names = ["HOME", ...ACCOUNT_CONTROLLED_ENV.codex, ...ACCOUNT_CONTROLLED_ENV.claude];
    const print = `const e = {}; for (const n of ${JSON.stringify(names)}) if (n in process.env) e[n] = process.env[n]; ` +
      "console.log(JSON.stringify({ argv: process.argv.slice(1), env: e }))";
    for (const cli of ["codex", "claude"]) {
      writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec ${shSingleQuote(process.execPath)} -e ${shSingleQuote(print)} -- "$@"\n`);
      chmodSync(path.join(bin, cli), 0o755);
    }
    const awkward = "~/it's \"quoted\" $HOME `id` 日本";
    const absolute = path.join(dir, "abs dir", "claude work");
    const specs: Array<Pick<LaunchAccount, "driver" | "homePath" | "shadowPath">> = [
      { driver: "codex", homePath: "", shadowPath: "~/.codex_personal" },
      { driver: "codex", homePath: "~/shared codex", shadowPath: awkward },
      { driver: "codex", homePath: "~/.codex-work", shadowPath: "" },
      { driver: "codex", homePath: "", shadowPath: "" },
      { driver: "claude", homePath: "", shadowPath: "~/.claude-personal" },
      { driver: "claude", homePath: absolute, shadowPath: "" },
      { driver: "claude", homePath: "", shadowPath: "" },
    ];
    const expand = (value: string) => value.startsWith("~/") ? home + value.slice(1) : value;
    for (const shell of process.platform === "darwin" ? ["zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"]) {
      for (const spec of specs) {
        const command = accountLoginCommand(spec);
        const result = spawnSync(shell, shell === "zsh" ? ["-f"] : [], {
          input: command + "\n", encoding: "utf8", env: childEnv({ HOME: home, PATH: `${bin}:/usr/bin:/bin` }),
        });
        assert.equal(result.status, 0, `${shell} ${command}: ${result.stderr}`);
        const seen = JSON.parse(result.stdout) as { argv: string[]; env: Record<string, string> };
        const expected = Object.fromEntries(accountEnvironment({ ...launchAccount(spec.driver), ...spec }).map(({ name, value }) => [name, expand(value)]));
        assert.deepEqual(seen.env, { HOME: home, ...expected }, `${shell} ${command}`);
        assert.deepEqual(seen.argv, spec.driver === "claude" ? ["auth", "login"]
          : spec.shadowPath ? ["-c", "cli_auth_credentials_store=file", "login"] : ["login"], `${shell} ${command}`);
        const created = spec.shadowPath || (spec.driver === "claude" ? spec.homePath : "");
        if (created) assert.ok(existsSync(expand(created)), `${shell} made ${created}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage windows and snapshots are strict and bounded", () => {
  assert.deepEqual(usageSnapshotSchema.parse(snapshot()), snapshot());
  assert.ok(usageSnapshotSchema.safeParse(snapshot({ source: "codex", plan: "api-key", windows: [], error: "chatgpt authentication required", limitErrorAt: 1 })).success);
  assert.ok(usageSnapshotSchema.safeParse(snapshot({ plan: "unknown", error: "x".repeat(200) })).success);
  const window = { key: "codex.primary", label: "5 h", usedPercent: 0, resetsAt: 1791820800000 };
  assert.ok(usageWindowSchema.safeParse(window).success);
  for (const bad of [
    { ...window, usedPercent: 100.5 }, { ...window, usedPercent: -1 }, { ...window, usedPercent: Number.NaN }, { ...window, resetsAt: 1.5 },
    { ...window, resetsAt: -1 }, { ...window, key: "" }, { ...window, key: "k".repeat(65) }, { ...window, label: "" },
    { ...window, label: "x".repeat(81) }, { ...window, remainingPercent: 58 }, { key: "a", label: "a", usedPercent: 1 },
  ]) assert.ok(!usageWindowSchema.safeParse(bad).success, JSON.stringify(bad));
  const windows = Array.from({ length: 8 }, (_, i) => ({ ...window, key: `w${i}` }));
  assert.ok(usageSnapshotSchema.safeParse(snapshot({ windows })).success);
  for (const bad of [
    snapshot({ windows: [...windows, { ...window, key: "w8" }] }), snapshot({ windows: [window, window] }),
    snapshot({ error: "x".repeat(201) }), { ...snapshot(), email: "someone@example.com" }, snapshot({ source: "opencode" as never }),
    snapshot({ plan: "plus" as never }), snapshot({ accountId: "" }), snapshot({ capturedAt: 1.5 }), snapshot({ limitErrorAt: undefined }),
  ]) assert.ok(!usageSnapshotSchema.safeParse(bad).success, JSON.stringify(bad));
});
