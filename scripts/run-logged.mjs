import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import path from "node:path";
import { createRedactor } from "./redact-log.mjs";

const [file, command, ...args] = process.argv.slice(2);
if (!file || !command) throw new Error("Usage: run-logged.mjs OUTPUT COMMAND [ARG...]");
await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const output = createWriteStream(file, { flags: "w", mode: 0o600 });
await once(output, "open");
const secrets = Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(name)).map(([, value]) => value);
const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
const forwards = ["SIGINT", "SIGTERM"].map(signal => {
  const forward = () => child.kill(signal);
  process.on(signal, forward);
  return () => process.off(signal, forward);
});
let bytes = 0, truncated = false;
async function retain(chunk) {
  // Both output streams have at most one chunk waiting for downstream drain.
  // Only sanitized bytes ever reach console or retained logs.
  if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
  if (!truncated && bytes + chunk.length <= 4 * 1024 * 1024) {
    bytes += chunk.length;
    if (!output.write(chunk)) await once(output, "drain");
  } else if (!truncated) {
    truncated = true;
    if (!output.write("[LOG SIZE LIMIT REACHED]\n")) await once(output, "drain");
  }
}
const outputError = new Promise((_, reject) => output.once("error", reject));
outputError.catch(() => undefined);
const streams = [child.stdout, child.stderr].map(async source => {
  for await (const chunk of source.pipe(createRedactor(secrets))) await retain(chunk);
});
const code = new Promise(resolve => {
  child.on("error", () => resolve(1));
  child.on("close", status => resolve(status ?? 1));
});
try {
  const [status] = await Promise.race([Promise.all([code, ...streams]), outputError]);
  output.end(); await finished(output);
  process.exitCode = status;
} catch (error) {
  child.kill("SIGTERM"); output.destroy(); throw error;
} finally { for (const off of forwards) off(); }
