import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests, suiteOf } from "./test-suites.mjs";
import { selectHistoricalShard } from "./test-shards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const selected = args.filter(arg => arg.startsWith("--suite="));
if (selected.length > 1 || (selected.length && !["--suite=unit", "--suite=integration"].includes(selected[0]))) {
  throw new Error("Use --suite=unit or --suite=integration once");
}
const suite = selected[0]?.slice(8);

const shardArgs = args.filter(arg => arg.startsWith("--hivemind-shard="));
if (shardArgs.length > 1) throw new Error("Use --hivemind-shard=<index>/<count> once");
if (shardArgs.length && suite !== "integration") {
  throw new Error("--hivemind-shard is only valid with --suite=integration");
}

let files = (await discoverTests(root)).filter(file => !suite || suiteOf(file) === suite);
if (shardArgs.length) {
  const shardValue = shardArgs[0].slice("--hivemind-shard=".length);
  const shard = await selectHistoricalShard(root, files, shardValue);
  files = shard.files;
  console.log(
    `Historical integration shard ${shard.index}/${shard.count}: ${Math.round(shard.totalWeightMs)} weighted ms; ${files.length} files`,
  );
  console.log(
    "Shard plan:",
    shard.plan.map(item => `${item.index}=${Math.round(item.totalWeightMs)}ms/${item.files.length} files`).join(", "),
  );
}

if (!files.length) throw new Error(`No ${suite ?? "discovered"} tests`);
console.log(`Suite: ${suite ?? "all unit and integration"}; files: ${files.length}`);
const child = spawn(process.execPath,
  ["--import", "tsx", "--test", ...args.filter(arg =>
    !arg.startsWith("--suite=") && !arg.startsWith("--hivemind-shard=")), ...files],
  { cwd: root, stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.web.json") } });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
