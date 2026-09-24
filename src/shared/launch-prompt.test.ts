import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { childEnv } from "../test-support/child-process.ts";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ADOPT_UNTRUSTED,
  buildLaunchBlock,
  buildLaunchPrompt,
  buildRosterPaste,
  codexSessionTitle,
  sanitizeExtraFlags,
  sanitizeModel,
  sanitizeSoftware,
  sanitizeWorkspacePath,
  resolveLaunchTune,
  shSingleQuote,
  softwareFamily,
} from "./launch-prompt.ts";

const base = {
  software: "codex",
  workspacePath: "/tmp/hive-work",
  cdWorktree: true,
  projectSlug: "alpha",
  hiveName: "Alpha",
  passProject: true,
  role: "brain" as const,
  focus: "coord",
  adoptUntrusted: true,
};

test("README points to the UI prompts and keeps only a resume one-liner", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("## Prompts (English)")[1]!.split("### After they are online")[0]!;
  assert.match(section, /Launch agent → Copy/);
  const prompts = [...section.matchAll(/```\n([\s\S]*?)\n```/g)].map(match => match[1]!);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /join with role=worker, resume=Forge\. Then call whoami with orders=true/);
  assert.doesNotMatch(readme, /do not implement/i);
});

test("launch prompt adopts untrusted hive mail first", () => {
  const text = buildLaunchPrompt(base);
  assert.ok(text.startsWith(ADOPT_UNTRUSTED));
  assert.match(text, /join with role=brain, focus=coord, project=alpha/);
  assert.match(text, /You work only in hive Alpha/);
  assert.match(text, /read your standing orders \(a first join returns them; otherwise call whoami with orders=true\)/);
  assert.match(text, /output no text/);
  assert.equal(text.includes("Do not call wait in a loop"), false);
  assert.match(text, /Coordinate and delegate to workers, or do the work yourself when that serves the request better: you decide/);
  assert.doesNotMatch(text, /do not implement/i);
  assert.match(text, /call ack_delivery with that exact ID before acting/);
  assert.match(text, /inbox session was superseded, stop waiting/);
  assert.match(text, /On a protocol-upgrade error, stop; the MCP client must be restarted before rejoining/);
});

test("resume worker keeps identity and rereads its standing orders", () => {
  const text = buildLaunchPrompt({
    ...base,
    role: "worker",
    seniority: "senior",
    focus: "api",
    resume: true,
    resumeName: "Forge",
    adoptUntrusted: false,
  });
  assert.equal(text.includes(ADOPT_UNTRUSTED), false);
  assert.match(text, /already a Hivemind worker/);
  assert.match(text, /resume=Forge/);
  assert.match(text, /seniority=senior/);
  assert.match(text, /otherwise call whoami with orders=true/);
  assert.match(text, /You cannot see other projects/);
  assert.match(text, /Never mention @Human/);
  assert.match(text, /you may reply in a DM Human already opened/);
  assert.match(text, /never delegate/);
  assert.doesNotMatch(text, /SINGLE/);
});

test("without project flag, join from the worktree", () => {
  const text = buildLaunchPrompt({ ...base, passProject: false, adoptUntrusted: false });
  assert.match(text, /Join from the project worktree/);
  assert.match(text, /hive Alpha/);
  assert.equal(text.includes("project=alpha"), false);
});

test("hive name is omitted when left blank", () => {
  const text = buildLaunchPrompt({ ...base, hiveName: "", adoptUntrusted: false });
  assert.equal(text.includes("You work only in hive"), false);
});

test("Codex new join asks for /rename Hive - assigned name after join", () => {
  const text = buildLaunchPrompt({ ...base, adoptUntrusted: false });
  assert.match(text, /\/rename Alpha - that assigned name/);
  assert.equal(codexSessionTitle("Alpha", "Forge"), "Alpha - Forge");
});

test("Codex resume uses the exact /rename Hive - Name", () => {
  const text = buildLaunchPrompt({
    ...base,
    role: "worker",
    seniority: "senior",
    resume: true,
    resumeName: "Forge",
    adoptUntrusted: false,
  });
  assert.match(text, /\/rename Alpha - Forge/);
});

test("Claude and Cursor prompts do not mention /rename", () => {
  const claude = buildLaunchPrompt({ ...base, software: "claude-tw", adoptUntrusted: false });
  const cursor = buildLaunchPrompt({ ...base, software: "agent", adoptUntrusted: false });
  assert.equal(claude.includes("/rename"), false);
  assert.equal(cursor.includes("/rename"), false);
});

test("Codex rename falls back to the assigned name when the hive title is blank", () => {
  const resume = buildLaunchPrompt({
    ...base,
    hiveName: "",
    resume: true,
    resumeName: "Forge",
    adoptUntrusted: false,
  });
  assert.match(resume, /\/rename Forge/);
  const fresh = buildLaunchPrompt({ ...base, hiveName: "", adoptUntrusted: false });
  assert.match(fresh, /\/rename with that assigned name/);
});

test("one block cds then runs the alias with a literal prompt", () => {
  const block = buildLaunchBlock({ ...base, software: "codex-tw" });
  assert.equal(block, "cd -- '/tmp/hive-work' && codex-tw " +
    shSingleQuote(buildLaunchPrompt({ ...base, software: "codex-tw" })) + "\n");
  assert.ok(block.includes(ADOPT_UNTRUSTED));
});

test("cd toggle off skips the worktree", () => {
  const block = buildLaunchBlock({ ...base, cdWorktree: false, software: "claude" });
  assert.ok(block.startsWith("claude '"));
  assert.equal(block.includes("cd "), false);
});

test("Claude launch requests eager loading only for Hivemind without changing permissions", () => {
  const binding = {
    command: "/fixture/node",
    args: ["/fixture/it's hive/cli.ts", "mcp"],
    env: { HIVEMIND_URL: "http://127.0.0.1:7420", HIVEMIND_TOKEN: "" },
  };
  const original = structuredClone(binding);
  for (const software of ["claude", "claude-company"]) {
    for (const role of ["brain", "worker"] as const) {
      for (const resume of [false, true]) {
        const input = { ...base, software, role, seniority: "senior" as const,
          resume, resumeName: "Fixture", cdWorktree: false, hivemindMcp: binding };
        const block = buildLaunchBlock(input);
        // Capture argv using a shell function, never launch the real model.
        const capture = `function ${software}() { ${shSingleQuote(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }\n`;
        const shell = process.platform === "darwin" ? "zsh" : "/bin/bash";
        const result = spawnSync(shell, ["-f"], { input: capture + block, encoding: "utf8", env: childEnv() });
        assert.equal(result.status, 0, result.stderr);
        const argv = JSON.parse(result.stdout) as string[];
        assert.deepEqual(argv.slice(0, 3), ["--mcp-config", JSON.stringify({
          mcpServers: { hivemind: { ...binding, alwaysLoad: true } },
        }), "--"]);
        assert.equal(argv[3], buildLaunchPrompt(input));
        assert.equal(argv.length, 4);
        assert.doesNotMatch(block, /--strict-mcp-config|--permission-mode|skip-permissions|MCP_CONNECTION_NONBLOCKING/);
      }
    }
  }
  assert.deepEqual(binding, original);
  for (const software of ["codex", "agent", "opencode"]) {
    assert.doesNotMatch(buildLaunchBlock({ ...base, software, hivemindMcp: binding }), /alwaysLoad|--mcp-config/);
  }
});

test("launch prompt requires a real join result and stops if tools are unavailable", () => {
  for (const resume of [false, true]) {
    const prompt = buildLaunchPrompt({ ...base, resume, resumeName: "Fixture" });
    assert.match(prompt, /Use a real tool call; never simulate a tool result or invent an agent name/);
    assert.match(prompt, /use the host's available tool discovery to load Hivemind's tools first/);
    assert.match(prompt, /If join is unavailable or fails, report the startup failure and stop/);
  }
});

test("missing worktree skips cd even when the toggle is on", () => {
  const block = buildLaunchBlock({ ...base, workspacePath: null, software: "codex2" });
  assert.ok(block.startsWith("codex2 "));
  assert.equal(block.includes("cd "), false);
});

test("quotes worktrees that contain spaces or quotes", () => {
  assert.equal(shSingleQuote("/tmp/My Project"), "'/tmp/My Project'");
  assert.equal(shSingleQuote("/tmp/it's"), `'/tmp/it'\\''s'`);
  const block = buildLaunchBlock({ ...base, workspacePath: "/tmp/it's hive" });
  assert.ok(block.startsWith(`cd -- '/tmp/it'\\''s hive' &&`));
});

test("empty software becomes codex; flags stay optional", () => {
  assert.equal(sanitizeSoftware("  "), "codex");
  assert.equal(sanitizeSoftware("claude-tw"), "claude-tw");
  assert.throws(() => sanitizeSoftware("codex; rm"), /one command/);
  assert.equal(sanitizeExtraFlags(" --full-auto "), "--full-auto");
  assert.throws(() => sanitizeExtraFlags("--foo; bar"), /metacharacters/);
  const block = buildLaunchBlock({ ...base, extraFlags: "--full-auto" });
  assert.match(block, /codex --full-auto '/);
});

test("model and effort become software-aware flags", () => {
  const codex = buildLaunchBlock({
    ...base,
    software: "codex2",
    model: "gpt-5.4",
    effort: "high",
    cdWorktree: false,
  });
  assert.match(codex, /^codex2 -m gpt-5\.4 -c model_reasoning_effort=high /);
  const claude = buildLaunchBlock({
    ...base,
    software: "claude-tw",
    model: "claude-opus-4-6",
    effort: "max",
    cdWorktree: false,
  });
  assert.match(claude, /^claude-tw --model claude-opus-4-6 --effort max /);
});

test("workers without seniority cannot launch", () => {
  assert.throws(
    () => buildLaunchPrompt({ ...base, role: "worker", seniority: null, adoptUntrusted: false }),
    /seniority/,
  );
});

test("resume worker without seniority omits the join field", () => {
  const text = buildLaunchPrompt({
    ...base,
    role: "worker",
    seniority: null,
    focus: "api",
    resume: true,
    resumeName: "Forge",
    adoptUntrusted: false,
  });
  assert.match(text, /resume=Forge/);
  assert.equal(text.includes("seniority="), false);
});

test("OpenCode TUI takes --prompt and does not pass --variant", () => {
  const block = buildLaunchBlock({
    ...base,
    software: "opencode",
    model: "opencode/muse-spark-1.3-contributor-free",
    effort: "xhigh",
    cdWorktree: false,
  });
  assert.match(block, /^opencode -m opencode\/muse-spark-1\.3-contributor-free --prompt /);
  assert.equal(block.includes("--variant"), false);
  assert.equal(softwareFamily("opencode"), "opencode");
  assert.equal(sanitizeModel("opencode/muse-spark-1.3-contributor-free"), "opencode/muse-spark-1.3-contributor-free");
  assert.throws(() => sanitizeModel("../evil"), /one token/);
});

test("cursor family skips effort flags", () => {
  const block = buildLaunchBlock({
    ...base,
    software: "agent",
    model: "gpt-5.3-codex-high",
    effort: "high",
    cdWorktree: false,
  });
  assert.match(block, /^agent --model gpt-5\.3-codex-high /);
  assert.equal(block.includes("--effort"), false);
  assert.equal(block.includes("model_reasoning_effort"), false);
});

test("roster paste is a macOS script that opens one Terminal window per employee", () => {
  const forge = "codex \"$(cat <<'HIVEMIND_PROMPT'\nhi\nHIVEMIND_PROMPT\n)\"";
  const ada = "claude --model opus \"$(cat <<'HIVEMIND_PROMPT'\nho\nHIVEMIND_PROMPT\n)\"";
  const text = buildRosterPaste([
    { title: "Alpha - Forge", text: forge },
    { title: "Alpha - Ada", text: ada },
  ]);
  assert.ok(text.startsWith("#!/bin/zsh"));
  assert.match(text, /osascript/);
  assert.match(text, /do script/);
  assert.match(text, /HIVEMIND_LAUNCH_1/);
  assert.match(text, /HIVEMIND_LAUNCH_2/);
  assert.ok(text.includes(forge));
  assert.ok(text.includes(ada));
  assert.match(text, /'Alpha - Forge'/);
  assert.match(text, /'Alpha - Ada'/);
  assert.equal(text.includes("does not launch anyone"), false);
  if (process.platform === "darwin") {
    const chk = spawnSync("zsh", ["-n"], { input: text, encoding: "utf8", env: childEnv() });
    assert.equal(chk.status, 0, chk.stderr);
  }
  const empty = buildRosterPaste([]);
  assert.match(empty, /No employees to launch/);
});

test("resume without a name does not emit a placeholder", () => {
  assert.throws(
    () => buildLaunchPrompt({ ...base, resume: true, resumeName: "  ", adoptUntrusted: false }),
    /assigned name/,
  );
  assert.throws(
    () => buildLaunchPrompt({ ...base, resume: true, resumeName: "Human", adoptUntrusted: false }),
    /Human/,
  );
});

test("join values cannot smuggle extra assignments", () => {
  assert.throws(
    () => buildLaunchPrompt({ ...base, focus: "coord, project=other", adoptUntrusted: false }),
    /focus/,
  );
  assert.throws(
    () => buildLaunchPrompt({ ...base, projectSlug: "alpha,other", adoptUntrusted: false }),
    /slug/,
  );
});

test("software and flags reject path tricks and quote breaks", () => {
  assert.throws(() => sanitizeSoftware("../codex"), /one command/);
  assert.throws(() => sanitizeSoftware("./codex"), /one command/);
  assert.throws(() => sanitizeSoftware("--version"), /one command/);
  assert.throws(() => sanitizeSoftware("-e"), /one command/);
  assert.throws(() => sanitizeExtraFlags(`--foo "bar"`), /metacharacters/);
  assert.throws(() => sanitizeExtraFlags("--foo #bar"), /metacharacters/);
  assert.throws(() => sanitizeExtraFlags("--foo\tbar"), /metacharacters/);
  assert.throws(() => sanitizeModel("-gpt"), /one token/);
});

test("card model override does not inherit the global effort", () => {
  assert.deepEqual(resolveLaunchTune({ model: "gpt-6-astra", effort: "high" }, undefined), {
    model: "gpt-6-astra",
    effort: "high",
  });
  assert.deepEqual(
    resolveLaunchTune({ model: "gpt-6-astra", effort: "high" }, { model: "gpt-5.4", effort: "" }),
    { model: "gpt-5.4", effort: "" },
  );
  assert.deepEqual(
    resolveLaunchTune({ model: "gpt-6-astra", effort: "high" }, { model: "", effort: "max" }),
    { model: "gpt-6-astra", effort: "high" },
  );
});

test("empty software is treated as codex; join lists stay comma-separated", () => {
  assert.equal(softwareFamily(""), "codex");
  assert.equal(softwareFamily("  "), "codex");
  const text = buildLaunchPrompt({ ...base, focus: "", adoptUntrusted: false });
  assert.match(text, /join with role=brain, project=alpha/);
  assert.equal(text.includes("role=brain and "), false);
});

test("workspace paths cannot hide extra lines; resume drops a bad focus", () => {
  assert.throws(() => sanitizeWorkspacePath("/tmp/hive\n/tmp/other"), /control characters/);
  assert.throws(
    () => buildLaunchBlock({ ...base, workspacePath: "/tmp/hive\ncd /tmp/evil", adoptUntrusted: false }),
    /control characters/,
  );
  const text = buildLaunchPrompt({
    ...base,
    role: "worker",
    seniority: "senior",
    focus: "api, other",
    resume: true,
    resumeName: "Forge",
    adoptUntrusted: false,
  });
  assert.match(text, /resume=Forge/);
  assert.equal(text.includes("focus="), false);
});
