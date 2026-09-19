import { readdir } from "node:fs/promises";
import path from "node:path";

// Mixed files default to integration. A new test is NEVER omitted for lacking
// an entry here; these exceptions only classify existing pure-function tests.
const pure = new Set([
  "src/server/names.test.ts", "src/server/telegram-rate-limit.test.ts",
  "src/mcp/wait-loop.test.ts", "src/mcp/wait-retry-budget.test.ts",
  "src/shared/join-args.test.ts", "src/shared/launch-models.test.ts",
  "src/shared/mime.test.ts", "src/shared/project.test.ts", "src/shared/read-client.test.ts",
  "src/shared/realtime-client.test.ts", "src/shared/search-query.test.ts",
  "web/channel-state.test.ts", "web/pane-window.test.ts",
]);
export function suiteOf(file) {
  return /\.unit\.test\.(?:tsx?|mjs)$/.test(file) || pure.has(file) ? "unit" : "integration";
}
export async function discoverTests(root) {
  async function collect(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const file = relative + "/" + entry.name;
      if (entry.isDirectory()) files.push(...await collect(file));
      else if (entry.isFile() && /\.test\.(?:tsx?|mjs)$/.test(entry.name)) files.push(file);
    }
    return files;
  }
  const files = (await Promise.all(["src", "web", "scripts"].map(collect))).flat().sort();
  if (!files.length) throw new Error("No test files discovered");
  return files;
}
