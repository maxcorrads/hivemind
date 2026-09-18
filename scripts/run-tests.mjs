import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

export function discoverTests(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...discoverTests(full));
    else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

export function run(suite) {
  if (!['server', 'ui'].includes(suite)) throw new Error('Expected suite: server or ui');
  const files = discoverTests(suite === 'ui' ? 'web' : 'src');
  if (files.length === 0) {
    console.error(`No ${suite} test files present`);
    return suite === 'ui' ? 0 : 1;
  }
  console.error(`Running ${files.length} ${suite} test files`);
  const require = createRequire(import.meta.url);
  const args = [require.resolve('tsx/cli')];
  if (suite === 'ui') args.push('--tsconfig', 'tsconfig.web.json');
  args.push('--test', ...files);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv[2] ?? 'server');
}
