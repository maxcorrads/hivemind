#!/bin/bash
# Builds "Hivemind.app" (the UI) and "Hivemind Server.app" (menu-bar server
# with its own Node.js) into macos/dist/, for Apple Silicon (arm64) only and
# ad-hoc signed. Nothing here starts a server or opens an app: the only
# thing run from the bundle is `node bin/hivemind.mjs --help`.
#
# Usage: macos/build.sh [--ui-only | --server-only] [--skip-node]
#   --ui-only      build only Hivemind.app
#   --server-only  build only Hivemind Server.app
#   --skip-node    leave Node.js out of the server app (faster Swift
#                  iteration; that bundle cannot run a server)
#
# Downloads (Node.js releases) are cached in macos/.cache and verified
# against the checksums pinned below, so reruns are offline and identical.
#
# Helpers that produce something set a global (NODE_TARBALL, NODE_DIR,
# SERVER_PACKAGE, APP) instead of printing it: macOS bash 3.2 turns
# `set -e` off inside $(...), so a failing step there would go unnoticed.
set -euo pipefail

# Node.js 24 LTS. Bump both together; the checksum comes from
# https://nodejs.org/dist/<version>/SHASUMS256.txt and is pinned here so a
# swapped download (or SHASUMS file) fails the build instead of shipping.
NODE_VERSION="v24.21.0"
NODE_SHA256_ARM64="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"

# Apple Silicon only: no Intel slice is built, bundled or run.
ARCH="arm64"

# The UI app's floor is the Swift deployment target; the server app's is
# Node.js 24's own (it refuses to run below 13.5).
UI_MIN_MACOS="13.0"
SERVER_MIN_MACOS="13.5"

build_ui=1
build_server=1
bundle_node=1
for arg in "$@"; do
  case "$arg" in
    --ui-only) build_server=0 ;;
    --server-only) build_ui=0 ;;
    --skip-node) bundle_node=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build.sh: unknown option $arg (see --help)" >&2; exit 64 ;;
  esac
done
if [ "$build_ui" = 0 ] && [ "$build_server" = 0 ]; then
  echo "build.sh: --ui-only and --server-only exclude each other" >&2
  exit 64
fi

MACOS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$MACOS")"
CACHE="$MACOS/.cache"
DIST="$MACOS/dist"
STAGE="$CACHE/stage"
mkdir -p "$CACHE" "$DIST"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "build.sh: $*" >&2; exit 1; }

VERSION="$(plutil -extract version raw -o - "$REPO/package.json")"
[ -n "$VERSION" ] || die "no version in package.json"

# The apps find each other by these (BundleID in HivemindKit/Identity.swift),
# so the plists take them from there rather than a second copy.
bundle_id() {
  sed -n "s/.*static let $1 = \"\([^\"]*\)\".*/\1/p" "$MACOS/Sources/HivemindKit/Identity.swift"
}
UI_BUNDLE_ID="$(bundle_id ui)"
SERVER_BUNDLE_ID="$(bundle_id server)"
SERVER_URL_SCHEME="$(bundle_id serverURLScheme)"
[ -n "$UI_BUNDLE_ID" ] && [ -n "$SERVER_BUNDLE_ID" ] && [ -n "$SERVER_URL_SCHEME" ] \
  || die "no BundleID in Identity.swift"

# --- Swift executables ------------------------------------------------------

step "Swift: $ARCH release build"
products=()
[ "$build_ui" = 1 ] && products+=(Hivemind)
[ "$build_server" = 1 ] && products+=(HivemindServer)
for product in "${products[@]}"; do
  swift build --quiet --package-path "$MACOS" -c release --arch "$ARCH" --product "$product"
done
BIN_DIR="$(swift build --package-path "$MACOS" -c release --arch "$ARCH" --show-bin-path)"
[ -d "$BIN_DIR" ] || die "no Swift build folder at $BIN_DIR"

# --- App icon ---------------------------------------------------------------

ICON_SVG="$REPO/web/public/icon.svg"
ICON_KEY="$(shasum -a 256 "$ICON_SVG" "$MACOS/scripts/render-icon.swift" | shasum -a 256 | cut -c1-16)"
ICNS="$CACHE/AppIcon-$ICON_KEY.icns"
if [ ! -f "$ICNS" ]; then
  step "Icon: rendering $ICON_SVG"
  iconset="$CACHE/AppIcon.iconset"
  rm -rf "$iconset"
  swift "$MACOS/scripts/render-icon.swift" "$ICON_SVG" "$iconset"
  iconutil -c icns -o "$CACHE/AppIcon.tmp.icns" "$iconset"
  mv "$CACHE/AppIcon.tmp.icns" "$ICNS"
  rm -rf "$iconset"
fi

# --- Node.js ----------------------------------------------------------------

# Sets NODE_TARBALL to a verified release tarball, downloading it once.
node_tarball() {
  local arch="$1" expected="$2"
  local name="node-$NODE_VERSION-darwin-$arch.tar.gz"
  local file="$CACHE/node/$name"
  mkdir -p "$CACHE/node"
  if [ ! -f "$file" ] || [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" != "$expected" ]; then
    echo "downloading $name" >&2
    curl -fsSL --retry 3 -o "$file.part" "https://nodejs.org/dist/$NODE_VERSION/$name"
    mv "$file.part" "$file"
  fi
  local actual
  actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || { rm -f "$file"; die "$name: sha256 $actual, pinned $expected"; }
  # The list is cached too. A cached copy that does not list the pinned sum
  # (an interrupted or older download) is fetched again once before failing.
  local sums="$CACHE/node/SHASUMS256-$NODE_VERSION.txt"
  [ -f "$sums" ] || fetch_shasums "$sums"
  if [ "$(listed_sha "$sums" "$name")" != "$expected" ]; then
    echo "SHASUMS256.txt does not list the pinned sum for $name; downloading it again" >&2
    fetch_shasums "$sums"
  fi
  local listed
  listed="$(listed_sha "$sums" "$name")"
  [ "$listed" = "$expected" ] || die "$name: SHASUMS256.txt lists '$listed', pinned $expected"
  NODE_TARBALL="$file"
}

# Downloads next to the target and moves it into place, so an interrupted
# download never leaves a truncated list behind.
fetch_shasums() {
  local sums="$1"
  curl -fsSL --retry 3 -o "$sums.part" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  mv "$sums.part" "$sums"
}

listed_sha() { awk -v n="$2" '$2 == n { print $1 }' "$1"; }

# Sets NODE_DIR to the folder with the arm64 node binary and its LICENSE,
# extracting it once.
arm64_node() {
  local out="$CACHE/node/$NODE_VERSION-$ARCH"
  if [ ! -x "$out/node" ]; then
    step "Node.js $NODE_VERSION: fetch, verify, extract ($ARCH)"
    node_tarball "$ARCH" "$NODE_SHA256_ARM64"
    local work="$CACHE/node/work"
    rm -rf "$work" && mkdir -p "$work"
    tar -xzf "$NODE_TARBALL" -C "$work" --strip-components 1
    rm -rf "$out.tmp" && mkdir -p "$out.tmp"
    cp "$work/bin/node" "$out.tmp/node"
    cp "$work/LICENSE" "$out.tmp/LICENSE"
    rm -rf "$out" && mv "$out.tmp" "$out"
    rm -rf "$work"
  fi
  NODE_DIR="$out"
}

# --- Server package -----------------------------------------------------------

# npm pack runs the package's prepack (npm run build: vite + esbuild) and
# yields exactly what npm would publish: bin/, dist/, docs. Production
# dependencies come from the repo's lockfile (npm never packs it), without
# install scripts. Sets SERVER_PACKAGE.
server_package() {
  local out="$STAGE/server-package"
  step "Server package: npm pack + production dependencies"
  rm -rf "$STAGE/pack" "$out" && mkdir -p "$STAGE/pack"
  (cd "$REPO" && npm pack --silent --pack-destination "$STAGE/pack")
  local tgz
  tgz="$(ls "$STAGE/pack"/*.tgz)"
  [ -f "$tgz" ] || die "npm pack produced no tarball"
  mkdir -p "$out"
  tar -xzf "$tgz" -C "$out" --strip-components 1
  cp "$REPO/package-lock.json" "$out/package-lock.json"
  (cd "$out" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  [ -f "$out/bin/hivemind.mjs" ] || die "packed server has no bin/hivemind.mjs"
  rm -rf "$STAGE/pack"
  SERVER_PACKAGE="$out"
}

# --- Bundles ----------------------------------------------------------------

write_plist() {
  local file="$1" name="$2" id="$3" executable="$4" min_macos="$5" extra="$6"
  cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>$executable</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>$min_macos</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Apple Silicon only: never offered to run under Rosetta. -->
  <key>LSArchitecturePriority</key><array><string>$ARCH</string></array>
  <key>LSRequiresNativeExecution</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>Apache License 2.0</string>
  <!-- Plain http only to the loopback server; everything else keeps ATS. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
$extra
</dict>
</plist>
PLIST
  plutil -lint -s "$file"
}

# Builds a bundle in the stage folder (sets APP); publish swaps it into
# dist/ in one move.
assemble() {
  local name="$1" id="$2" product="$3" executable="$4" min_macos="$5" extra="$6"
  local app="$STAGE/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$BIN_DIR/$product" "$app/Contents/MacOS/$executable"
  cp "$ICNS" "$app/Contents/Resources/AppIcon.icns"
  printf 'APPL????' > "$app/Contents/PkgInfo"
  write_plist "$app/Contents/Info.plist" "$name" "$id" "$executable" "$min_macos" "$extra"
  APP="$app"
}

# Ad-hoc signature: enough for Apple Silicon to run an unsigned build. Inner
# code first, then the bundle, which seals everything else as resources.
sign() {
  local app="$1"
  if [ -d "$app/Contents/Helpers" ]; then
    find "$app/Contents/Helpers" -type f -perm -u+x -print0 | xargs -0 codesign --force --sign - --timestamp=none
  fi
  find "$app/Contents/Resources" -type f \( -name '*.node' -o -name '*.dylib' \) -print0 \
    | xargs -0 codesign --force --sign - --timestamp=none
  codesign --force --sign - --timestamp=none "$app"
  codesign --verify --strict "$app"
}

publish() {
  local app="$1" target
  target="$DIST/$(basename "$1")"
  local archs
  archs="$(lipo -archs "$app/Contents/MacOS/"*)"
  [ "$archs" = "$ARCH" ] || die "$(basename "$app") executable is '$archs', not $ARCH only"
  rm -rf "$target"
  mv "$app" "$target"
  echo "built $target"
}

rm -rf "$STAGE" && mkdir -p "$STAGE"

if [ "$build_ui" = 1 ]; then
  step "Hivemind.app"
  assemble "Hivemind" "$UI_BUNDLE_ID" Hivemind Hivemind "$UI_MIN_MACOS" \
    '  <key>NSSupportsAutomaticTermination</key><false/>'
  sign "$APP"
  publish "$APP"
fi

if [ "$build_server" = 1 ]; then
  server_package
  NODE_DIR=""
  if [ "$bundle_node" = 1 ]; then arm64_node; fi

  step "Hivemind Server.app"
  # Menu-bar only; never auto- or sudden-terminated while it owns a child.
  # hivemind-server://start is how Hivemind.app asks a running copy to start
  # its server (HivemindKit/ServerAppURLCommand.swift). Agents in the terminal
  # broker's tmux sessions count as this app's for macOS privacy prompts, so
  # it says why it may reach protected folders. The opt-in remote gateway
  # (docs/remote-access.md) listens on private addresses and advertises
  # _hivemind._tcp; macOS 15+ local network privacy needs both keys for that.
  assemble "Hivemind Server" "$SERVER_BUNDLE_ID" HivemindServer "Hivemind Server" "$SERVER_MIN_MACOS" \
    "  <key>LSUIElement</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSLocalNetworkUsageDescription</key><string>With Remote Access turned on, Hivemind Server lets the iPhones and iPads you paired reach Hivemind over your local network.</string>
  <key>NSBonjourServices</key><array><string>_hivemind._tcp</string></array>
  <key>NSDocumentsFolderUsageDescription</key><string>Agents you launch from Hivemind run in terminal sessions of Hivemind Server and may work on projects in your Documents folder.</string>
  <key>NSDesktopFolderUsageDescription</key><string>Agents you launch from Hivemind run in terminal sessions of Hivemind Server and may work on projects on your Desktop.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Agents you launch from Hivemind run in terminal sessions of Hivemind Server and may work on projects in your Downloads folder.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>Agents you launch from Hivemind run in terminal sessions of Hivemind Server and may work on projects on removable volumes.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Agents you launch from Hivemind run in terminal sessions of Hivemind Server and may work on projects on network volumes.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$SERVER_BUNDLE_ID</string>
      <key>CFBundleURLSchemes</key><array><string>$SERVER_URL_SCHEME</string></array>
    </dict>
  </array>"
  app="$APP"
  mv "$SERVER_PACKAGE" "$app/Contents/Resources/server"
  if [ -n "$NODE_DIR" ]; then
    mkdir -p "$app/Contents/Helpers" "$app/Contents/Resources/node"
    cp "$NODE_DIR/node" "$app/Contents/Helpers/node"
    cp "$NODE_DIR/LICENSE" "$app/Contents/Resources/node/LICENSE"
  fi
  sign "$app"
  if [ -n "$NODE_DIR" ]; then
    step "Check: bundled node runs the CLI (--help only)"
    node="$app/Contents/Helpers/node"
    [ "$(lipo -archs "$node")" = "$ARCH" ] || die "bundled node is $(lipo -archs "$node"), not $ARCH only"
    check_home="$(mktemp -d "$STAGE/check-home.XXXXXX")"
    if [ "$(uname -m)" = "$ARCH" ]; then
      help="$(HIVEMIND_HOME="$check_home" "$node" "$app/Contents/Resources/server/bin/hivemind.mjs" --help)" \
        || die "bundled CLI --help failed"
      [[ "$help" == hivemind* ]] || die "bundled CLI --help printed something else"
      HIVEMIND_HOME="$check_home" "$node" -e 'require("node:sqlite")' || die "bundled node has no node:sqlite"
      node_version="$("$node" --version)" || die "bundled node --version failed"
      echo "ok: node $node_version runs bin/hivemind.mjs --help"
    else
      echo "skip run: this Mac is $(uname -m), the bundle is $ARCH only"
    fi
    rm -rf "$check_home"
  fi
  publish "$app"
fi

rm -rf "$STAGE"
step "Done: $DIST (version $VERSION)"
