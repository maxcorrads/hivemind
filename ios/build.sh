#!/bin/bash
# Builds the iOS/iPadOS app "Hivemind" unsigned: generates the Xcode project
# from ios/project.yml with the XcodeGen pinned in macos/Tools, builds it for
# devices and for the Simulator, and packages both into ios/dist/. Nothing
# here signs, installs, boots a Simulator or runs the app.
#
# Usage: ios/build.sh [--device-only | --simulator-only] [--debug] [--no-package] [--skip-generate]
#   --device-only     build only for devices (generic/platform=iOS)
#   --simulator-only  build only for the Simulator (generic/platform=iOS Simulator)
#   --debug           Debug configuration instead of Release
#   --no-package      leave the builds in ios/build/, write nothing to ios/dist/
#   --skip-generate   reuse ios/Hivemind.xcodeproj as it is
#
# Output (version from package.json):
#   ios/dist/Hivemind-iOS-<version>-unsigned.ipa   Payload/Hivemind.app, zipped;
#                                                  sign it yourself to install it
#   ios/dist/Hivemind-iOS-Simulator-<version>.zip  Hivemind.app for the Simulator
#
# The app icon (ios/Sources/Assets.xcassets/AppIcon.appiconset) is rendered
# from web/public/icon.svg by ios/scripts/render-icon.swift. It is committed;
# when icon.svg or the script changed since it was rendered, this script
# renders it again first (commit the result).
#
# The unit tests (ios/Tests) need a booted Simulator, so this script never
# runs them; CI does, with xcodebuild test (docs/ios.md#tests).
#
# Helpers that produce something set a global instead of printing it: macOS
# bash 3.2 turns `set -e` off inside $(...), so a failing step there would go
# unnoticed (as in macos/build.sh).
set -euo pipefail

build_device=1
build_simulator=1
configuration="Release"
package=1
generate=1
for arg in "$@"; do
  case "$arg" in
    --device-only) build_simulator=0 ;;
    --simulator-only) build_device=0 ;;
    --debug) configuration="Debug" ;;
    --no-package) package=0 ;;
    --skip-generate) generate=0 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build.sh: unknown option $arg (see --help)" >&2; exit 64 ;;
  esac
done
if [ "$build_device" = 0 ] && [ "$build_simulator" = 0 ]; then
  echo "build.sh: --device-only and --simulator-only exclude each other" >&2
  exit 64
fi

IOS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$IOS")"
BUILD="$IOS/build"
DERIVED="$BUILD/DerivedData"
DIST="$IOS/dist"
PROJECT="$IOS/Hivemind.xcodeproj"
SCHEME="Hivemind"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "build.sh: $*" >&2; exit 1; }

VERSION="$(plutil -extract version raw -o - "$REPO/package.json")"
[ -n "$VERSION" ] || die "no version in package.json"
# A build number that only grows: the commit count, or 1 outside git.
BUILD_NUMBER="$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 1)"

# The app's bundle id is written twice, in project.yml (where Xcode needs it)
# and in HivemindKit (where Swift code and tests read it); they must agree.
KIT_BUNDLE_ID="$(sed -n 's/.*static let ios = "\([^"]*\)".*/\1/p' "$REPO/macos/Sources/HivemindKit/Identity.swift")"
SPEC_BUNDLE_ID="$(sed -n 's/^ *PRODUCT_BUNDLE_IDENTIFIER: *\(com\.[A-Za-z0-9.]*\.ios\) *$/\1/p' "$IOS/project.yml")"
[ -n "$KIT_BUNDLE_ID" ] || die "no BundleID.ios in Identity.swift"
[ "$KIT_BUNDLE_ID" = "$SPEC_BUNDLE_ID" ] \
  || die "bundle id differs: Identity.swift has '$KIT_BUNDLE_ID', project.yml '$SPEC_BUNDLE_ID'"

# The icon set is rendered from icon.svg; render-icon.sha256 records the
# icon.svg and render-icon.swift it was rendered from.
ICON_SVG="$REPO/web/public/icon.svg"
ICON_SCRIPT="$IOS/scripts/render-icon.swift"
ICON_SET="$IOS/Sources/Assets.xcassets/AppIcon.appiconset"
ICON_STAMP="$IOS/scripts/render-icon.sha256"
ICON_KEY="$(cat "$ICON_SVG" "$ICON_SCRIPT" | shasum -a 256 | cut -d' ' -f1)"
if [ "$(cat "$ICON_STAMP" 2>/dev/null)" != "$ICON_KEY" ] \
  || [ ! -f "$ICON_SET/AppIcon.png" ] || [ ! -f "$ICON_SET/AppIcon-Dark.png" ] || [ ! -f "$ICON_SET/AppIcon-Tinted.png" ]; then
  step "Icon: rendering $ICON_SVG (commit ios/Sources/Assets.xcassets and ios/scripts/render-icon.sha256)"
  swift "$ICON_SCRIPT" "$ICON_SVG" "$ICON_SET"
  echo "$ICON_KEY" > "$ICON_STAMP"
fi

if [ "$generate" = 1 ]; then
  step "XcodeGen (pinned in macos/Tools)"
  swift run --package-path "$REPO/macos/Tools" --configuration release xcodegen \
    generate --spec "$IOS/project.yml" --project "$IOS" --quiet
fi
[ -d "$PROJECT" ] || die "no $PROJECT: run without --skip-generate"

# Unsigned: CODE_SIGNING_ALLOWED=NO also skips the entitlements step, so no
# team or certificate is needed. arm64 only, like the macOS apps.
xcode_build() {
  local destination="$1"
  xcodebuild build \
    -project "$PROJECT" -scheme "$SCHEME" -configuration "$configuration" \
    -destination "$destination" -derivedDataPath "$DERIVED" \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    -quiet
}

# Checks a built app: bundle id, version, arm64 only, and the compiled icon.
APP=""
check_app() {
  local platform="$1"
  APP="$DERIVED/Build/Products/$configuration-$platform/Hivemind.app"
  [ -d "$APP" ] || die "no $APP"
  local id version archs
  id="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist")"
  version="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")"
  archs="$(lipo -archs "$APP/Hivemind")"
  [ "$id" = "$KIT_BUNDLE_ID" ] || die "$APP has bundle id $id"
  [ "$version" = "$VERSION" ] || die "$APP has version $version, not $VERSION"
  [ "$archs" = "arm64" ] || die "$APP is $archs, not arm64 only"
  local icon
  [ -f "$APP/Assets.car" ] || die "$APP has no Assets.car (the app icon)"
  icon="$(plutil -extract CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName raw -o - "$APP/Info.plist" 2>/dev/null || true)"
  [ "$icon" = "AppIcon" ] || die "$APP has no AppIcon in CFBundleIcons"
}

mkdir -p "$BUILD"
[ "$package" = 1 ] && mkdir -p "$DIST"

if [ "$build_device" = 1 ]; then
  step "xcodebuild: $configuration, generic/platform=iOS, unsigned"
  xcode_build "generic/platform=iOS"
  check_app iphoneos
  if [ "$package" = 1 ]; then
    ipa="$DIST/Hivemind-iOS-$VERSION-unsigned.ipa"
    step "Packaging $(basename "$ipa")"
    rm -rf "$BUILD/Payload" "$ipa"
    mkdir -p "$BUILD/Payload"
    ditto "$APP" "$BUILD/Payload/Hivemind.app"
    (cd "$BUILD" && ditto -c -k --norsrc --keepParent Payload "$ipa")
    rm -rf "$BUILD/Payload"
  fi
fi

if [ "$build_simulator" = 1 ]; then
  step "xcodebuild: $configuration, generic/platform=iOS Simulator"
  xcode_build "generic/platform=iOS Simulator"
  check_app iphonesimulator
  if [ "$package" = 1 ]; then
    zip="$DIST/Hivemind-iOS-Simulator-$VERSION.zip"
    step "Packaging $(basename "$zip")"
    rm -f "$zip"
    ditto -c -k --norsrc --keepParent "$APP" "$zip"
  fi
fi

step "Done"
[ "$package" = 1 ] && ls -l "$DIST" || ls -d "$DERIVED/Build/Products"/*/Hivemind.app
