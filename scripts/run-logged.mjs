import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import { createRedactor } from "./redact-log.mjs";

const [file, command, ...args] = process.argv.slice(2);
if (!file || !command) throw new Error("Usage: run-logged.mjs OUTPUT COMMAND [ARG...]");
await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const output = createWriteStream(file, { flags: "w", mode: 0o600 });
const saved = finished(output);
const secrets = Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(name)).map(([, value]) => value);
const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
let bytes = 0, truncated = false;
const streams = [child.stdout, child.stderr].map(source => {
  const safe = source.pipe(createRedactor(secrets));
  safe.on("data", chunk => {
    // Only sanitized bytes ever reach console or retained logs.
    process.stdout.write(chunk);
    if (bytes + chunk.length <= 4 * 1024 * 1024) { output.write(chunk); bytes += chunk.length; }
    else if (!truncated) { truncated = true; output.write("[LOG SIZE LIMIT REACHED]\n"); }
  });
  return finished(safe);
});
const code = await new Promise(resolve => {
  child.on("error", () => resolve(1));
  child.on("close", status => resolve(status ?? 1));
});
await Promise.all(streams);
output.end(); await saved;
process.exitCode = code;
