#!/usr/bin/env bash
set -euo pipefail

package_path="${1:?usage: smoke-package.sh path/to/package.tgz}"
package_path="$(cd "$(dirname "$package_path")" && pwd)/$(basename "$package_path")"
workdir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

install_root="$workdir/install"
home_root="$workdir/home"
mkdir -p "$install_root" "$home_root"

npm install --ignore-scripts --no-audit --no-fund --prefix "$install_root" "$package_path"

hivemind="$install_root/node_modules/.bin/hivemind"
if [[ ! -x "$hivemind" ]]; then
  echo "Packaged hivemind binary is missing" >&2
  exit 1
fi

"$hivemind" --help | grep -q "hivemind"

# The installed package runs compiled JavaScript: no TypeScript sources and no
# tsx loader, and the printed MCP launcher uses plain node on dist/node/cli.js.
package_root="$install_root/node_modules/hivemind"
if [[ ! -f "$package_root/dist/node/cli.js" || -e "$package_root/src" || -e "$install_root/node_modules/tsx" ]]; then
  echo "Packaged hivemind must ship dist/node/cli.js without src/ or a tsx dependency" >&2
  exit 1
fi
"$hivemind" mcp-config 2>/dev/null | grep -q "dist/node/cli.js"

# Every local Markdown page the packaged README links (e.g. docs/adaptive-routing.md) ships with it.
if [[ ! -f "$package_root/docs/adaptive-routing.md" ]]; then
  echo "Packaged hivemind is missing docs/adaptive-routing.md linked from the README" >&2
  exit 1
fi
missing_docs=""
while IFS= read -r doc; do
  [[ -f "$package_root/$doc" ]] || missing_docs+=" $doc"
done < <(grep -oE '\]\((\./)?[A-Za-z0-9_./-]+\.md' "$package_root/README.md" | sed -E 's/^\]\((\.\/)?//' | sort -u)
if [[ -n "$missing_docs" ]]; then
  echo "Packaged README links docs missing from the package:$missing_docs" >&2
  exit 1
fi

# One MCP process per agent: the compiled server must answer initialize over stdio.
PACKAGE_ROOT="$package_root" HIVEMIND_HOME="$home_root" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
const child = spawn(process.execPath, [path.join(process.env.PACKAGE_ROOT, "dist/node/cli.js"), "mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HIVEMIND_URL: "http://127.0.0.1:1" },
});
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("MCP initialize timed out")), 10000);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const line = buffer.split("\n").find((entry) => entry.includes('"id":1'));
    if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n");
});
child.kill();
assert.equal(reply.result?.serverInfo?.name, "hivemind");
console.log("Compiled MCP server answered initialize");
NODE

port=17420
server_log="$workdir/server.log"
HIVEMIND_HOME="$home_root" "$hivemind" serve --port "$port" >"$server_log" 2>&1 &
server_pid=$!

healthy=0
for _ in {1..40}; do
  if curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then
    healthy=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [[ "$healthy" -ne 1 ]]; then
  echo "Packaged server did not become healthy" >&2
  cat "$server_log" >&2 || true
  exit 1
fi

HIVEMIND_HOME="$home_root" HIVEMIND_URL="http://127.0.0.1:$port" "$hivemind" doctor | grep -q "^ok "
curl --fail --silent "http://127.0.0.1:$port/" | grep -qi "<!doctype html>"

# Check the installed package, not the source worktree. A SPA fallback must
# not disguise a missing JS/CSS asset as a successful HTTP 200 response.
HIVEMIND_URL="http://127.0.0.1:$port" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
const origin = process.env.HIVEMIND_URL;
const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
const html = await page.text();
const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map((match) => match[1]))];
assert.ok(assets.some((asset) => asset.endsWith(".js")), "Packaged HTML has no built JS entry");
for (const asset of assets) {
  const response = await fetch(new URL(asset, origin), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, asset);
  const expected = asset.endsWith(".css") ? /text\/css/ : /(?:text|application)\/javascript/;
  assert.match(response.headers.get("content-type") ?? "", expected, asset);
  const body = await response.text();
  assert.ok(body.length > 0, `Empty asset: ${asset}`);
  assert.doesNotMatch(body, /^\s*<!doctype html>/i, `SPA fallback returned for ${asset}`);
}
console.log(`Installed UI assets verified: ${assets.length}`);
NODE

echo "Package smoke test passed"
