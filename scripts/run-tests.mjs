import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "web"].map((dir) => path.join(root, dir));
const suffixes = [".test.ts", ".test.tsx"];

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(fullPath)));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = (await Promise.all(roots.map(collect))).flat().sort();
if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...testFiles],
  {
    cwd: root,
    stdio: "inherit",
    // Runtime JSX transformation must match Vite; both typechecks remain separate.
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.web.json") },
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
