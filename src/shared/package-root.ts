import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** True when this code runs from the esbuild output in dist/node rather than TypeScript source via tsx. */
export const runningCompiled = import.meta.url.endsWith(".js");

/** Relative path of the compiled CLI inside the package (built by `npm run build:server`). */
export const COMPILED_CLI = "dist/node/cli.js";

let cachedRoot: string | undefined;

/**
 * Directory holding Hivemind's package.json. Walks up instead of assuming a
 * fixed depth, so the same code works from src/ (tsx) and from bundled chunks
 * under dist/node/.
 */
export function packageRoot(from = here): string {
  if (from === here && cachedRoot) return cachedRoot;
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) {
      if (from === here) cachedRoot = dir;
      return dir;
    }
    if (path.dirname(dir) === dir) throw new Error(`Hivemind package root not found above ${from}`);
  }
}

/** Node argv that re-launches this CLI the same way it is running now: compiled JS, or source through tsx. */
export function cliLaunchArgs(args: string[], compiled = runningCompiled, root = packageRoot()): string[] {
  return compiled
    ? [path.join(root, COMPILED_CLI), ...args]
    : ["--import", import.meta.resolve("tsx"), path.join(root, "src/cli.ts"), ...args];
}
