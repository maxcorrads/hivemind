#!/usr/bin/env node
// Compiles the Node side (CLI, server, MCP, client, shared) from src/ into
// dist/node/ so an installed package runs plain JavaScript without tsx.
// One ESM entry (cli.js) plus lazily loaded chunks for `serve`, `mcp` and
// `bots`, so every command only parses the code it needs. npm packages and
// node: builtins (including node:sqlite) stay external imports. The bundle is
// not minified, so stack traces stay readable without shipping source maps.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist/node");

await rm(outdir, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.13",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]",
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});
const scripts = Object.entries(result.metafile.outputs).filter(([file]) => file.endsWith(".js"));
const bytes = scripts.reduce((sum, [, output]) => sum + output.bytes, 0);
console.log(`dist/node: ${scripts.length} JavaScript files, ${(bytes / 1024).toFixed(0)} KiB`);
