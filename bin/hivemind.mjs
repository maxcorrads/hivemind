#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src/cli.ts");
const compiled = path.join(root, "dist/node/cli.js");
const args = process.argv.slice(2);

// A source checkout always runs src/ through tsx, so a stale dist/node build is
// never used silently; HIVEMIND_FROM_DIST=1 opts in to the compiled build there.
// An installed package ships no src/ and runs its compiled JavaScript in this
// process: no TypeScript loader and no second node startup.
const useCompiled = existsSync(compiled) && (!existsSync(source) || process.env.HIVEMIND_FROM_DIST === "1");

if (useCompiled) {
  const { runCli } = await import(pathToFileURL(compiled).href);
  runCli(args).catch((err) => {
    console.error(String(err?.message || err));
    process.exit(1);
  });
} else {
  const child = spawn(process.execPath, ["--import", "tsx", source, ...args], {
    stdio: "inherit",
    cwd: root,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
