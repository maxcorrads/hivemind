import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests, suiteOf } from "./test-suites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const selected = args.filter(arg => arg.startsWith("--suite="));
if (selected.length > 1 || (selected.length && !["--suite=unit", "--suite=integration"].includes(selected[0]))) {
  throw new Error("Use --suite=unit or --suite=integration once");
}
const suite = selected[0]?.slice(8);
const files = (await discoverTests(root)).filter(file => !suite || suiteOf(file) === suite);
if (!files.length) throw new Error(`No ${suite ?? "discovered"} tests`);
console.log(`Suite: ${suite ?? "all unit and integration"}; files: ${files.length}`);
const child = spawn(process.execPath,
  ["--import", "tsx", "--test", ...args.filter(arg => !arg.startsWith("--suite=")), ...files],
  { cwd: root, stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.web.json") } });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
