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
