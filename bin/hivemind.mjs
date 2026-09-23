#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiled = path.join(root, "dist/node/cli.js");
const args = process.argv.slice(2);

// Installed packages ship compiled JavaScript (npm run build:server): load it in
// this process, with no TypeScript loader and no second node startup.
// HIVEMIND_FROM_SOURCE=1 forces the tsx path in a checkout with a stale build.
if (existsSync(compiled) && process.env.HIVEMIND_FROM_SOURCE !== "1") {
  const { runCli } = await import(pathToFileURL(compiled).href);
  runCli(args).catch((err) => {
    console.error(String(err?.message || err));
    process.exit(1);
  });
} else {
  // Source checkout without a build: run the TypeScript CLI through tsx (a devDependency).
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), ...args], {
    stdio: "inherit",
    cwd: root,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
