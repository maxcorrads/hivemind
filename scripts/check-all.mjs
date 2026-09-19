import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Check failed: ${command} ${args.join(" ")}`);
}
// Installation is explicit: npm ci && npx playwright install chromium.
run("zsh", ["--version"]);
for (const task of ["lint", "typecheck", "test:unit", "test:integration", "build", "test:coverage", "test:browser"]) run("npm", ["run", task]);
const dir = mkdtempSync(path.join(os.tmpdir(), "hive-package-check-"));
try {
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dir], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error("npm pack failed");
  const file = packed.stdout.trim().split("\n").at(-1);
  if (!file || path.basename(file) !== file) throw new Error("Invalid package filename");
  run("bash", ["scripts/smoke-package.sh", path.join(dir, file)]);
  run("npm", ["audit", "--omit=dev", "--audit-level=high"]);
} finally { rmSync(dir, { recursive: true, force: true }); }
