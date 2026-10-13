#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ROOT="$ROOT"
OUTPUT="$ROOT/installer/dist/standalone-final"
BUILD=0
SKIP_HELPER=0
SKIP_DMG=0

usage() {
 cat <<'HELP'
Usage: bash scripts/package-macos.sh [--skip-helper | --build] [--skip-dmg] [--output DIR] [--source-root DIR]

Create a universal macOS 14+ SSH Browser Helper.app, helper ZIP, and separate
extension ZIP for Apple Silicon and Intel. Packaging never runs the app, native
host, or registration scripts. Existing output artifacts are never replaced.
By default, existing bin/ssh-browser-helper-darwin-{arm64,amd64} are required.
--skip-helper explicitly uses those existing binaries (the default behavior).
--build invokes scripts/build.sh without --run-tests; GO_BIN is passed through.
--source-root selects the helper, extension, and registration script source.
--skip-dmg disables the optional DMG (otherwise created when hdiutil is available).
Default output: installer/dist/standalone-final.
CODESIGN_IDENTITY selects a signing identity; the default is ad-hoc (-).
This is a developer, unnotarized distribution. Signing does not notarize it.
HELP
}

while [ "$#" -gt 0 ]; do
 case "$1" in
  --build) BUILD=1; shift;;
  --skip-helper) SKIP_HELPER=1; shift;;
  --skip-dmg) SKIP_DMG=1; shift;;
  --output|--source-root)
   [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "Missing value for $1" >&2; exit 2; }
   case "$1" in --output) OUTPUT="$2";; --source-root) SOURCE_ROOT="$2";; esac
   shift 2;;
  --help|-h) usage; exit 0;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
 esac
done

if [ "$BUILD" = 1 ] && [ "$SKIP_HELPER" = 1 ]; then
 echo '--build and --skip-helper cannot be combined.' >&2
 exit 2
fi

[ "$(uname -s)" = Darwin ] || { echo 'Packaging requires macOS with the Swift compiler and command line tools.' >&2; exit 1; }
for TOOL in swiftc xcrun node; do
 command -v "$TOOL" >/dev/null || { echo "Missing $TOOL. Install Apple command line tools before packaging." >&2; exit 1; }
done
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd)"
APP_NAME='SSH Browser Helper.app'
ZIP_NAME='SSH-Browser-Helper-macos-universal.zip'
EXTENSION_ZIP_NAME='SSH-Browser-Extension.zip'
DMG_NAME='SSH-Browser-Helper-macos-universal.dmg'
ARTIFACTS=("$APP_NAME" "$ZIP_NAME" "$EXTENSION_ZIP_NAME")
[ "$SKIP_DMG" = 1 ] || ARTIFACTS+=("$DMG_NAME")
check_outputs() {
 for ARTIFACT in "${ARTIFACTS[@]}"; do
  if [ -e "$OUTPUT/$ARTIFACT" ] || [ -L "$OUTPUT/$ARTIFACT" ]; then
   echo "Output already exists: $OUTPUT/$ARTIFACT" >&2
   echo 'Choose a new --output directory; existing artifacts are never replaced.' >&2
   exit 1
  fi
 done
}
check_outputs
if [ "$BUILD" = 1 ]; then
 # build.sh defaults to compilation only. Never forward --run-tests.
 GO_BIN="${GO_BIN:-go}" /bin/bash "$SOURCE_ROOT/scripts/build.sh"
fi

for ARCH in arm64 amd64; do
 HELPER="$SOURCE_ROOT/bin/ssh-browser-helper-darwin-$ARCH"
 if [ ! -f "$HELPER" ]; then
  echo "Missing prebuilt helper: $HELPER" >&2
  echo 'Compile both helpers first (no installer/helper execution):' >&2
  printf '  GO_BIN="/absolute/path/to/go" /bin/bash "%s/scripts/build.sh"\n' "$SOURCE_ROOT" >&2
  echo 'Then rerun package-macos.sh, or use --build with GO_BIN set.' >&2
  exit 1
 fi
 MACH_ARCH="$ARCH"
 [ "$ARCH" != amd64 ] || MACH_ARCH=x86_64
 /usr/bin/lipo "$HELPER" -verify_arch "$MACH_ARCH" || { echo "Helper has the wrong architecture: $HELPER" >&2; exit 1; }
done
for FILE in extension/manifest.json extension/ID.txt scripts/register-helper-macos.sh; do
 [ -f "$SOURCE_ROOT/$FILE" ] || { echo "Missing source file: $SOURCE_ROOT/$FILE" >&2; exit 1; }
done
EXTENSION_ID="$(cat "$SOURCE_ROOT/extension/ID.txt")"
if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
 echo 'extension/ID.txt must contain a 32-character Chrome extension ID (a-p).' >&2
 exit 1
fi

mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
WORK="$(mktemp -d "$OUTPUT/.package-macos.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$APP_NAME"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/scripts" "$WORK/module-cache"
node "$ROOT/scripts/package-extension.mjs" --source-root "$SOURCE_ROOT" --output "$WORK/$EXTENSION_ZIP_NAME"
/bin/cp "$ROOT/installer/Info.plist" "$CONTENTS/Info.plist"
# Both architectures must compile the same frozen source, even if another worker
# updates the checkout while packaging is in progress.
/bin/cp "$ROOT/installer/Installer.swift" "$WORK/Helper.swift"
/usr/bin/plutil -lint "$CONTENTS/Info.plist"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
for ARCH in arm64 x86_64; do
 swiftc -swift-version 5 -O -sdk "$SDK" -target "$ARCH-apple-macosx14.0" \
  -module-cache-path "$WORK/module-cache" -framework AppKit \
  "$WORK/Helper.swift" -o "$WORK/launcher-$ARCH"
done
/usr/bin/lipo -create "$WORK/launcher-arm64" "$WORK/launcher-x86_64" -output "$CONTENTS/MacOS/SSH Browser Helper"
/usr/bin/lipo -create "$SOURCE_ROOT/bin/ssh-browser-helper-darwin-arm64" \
 "$SOURCE_ROOT/bin/ssh-browser-helper-darwin-amd64" -output "$CONTENTS/MacOS/ssh-browser-native-host"
chmod 755 "$CONTENTS/MacOS/SSH Browser Helper" "$CONTENTS/MacOS/ssh-browser-native-host"
/usr/bin/install -m 755 "$SOURCE_ROOT/scripts/register-helper-macos.sh" "$RESOURCES/scripts/register-helper-macos.sh"
/bin/cp "$SOURCE_ROOT/extension/ID.txt" "$RESOURCES/extension-id.txt"

IDENTITY="${CODESIGN_IDENTITY:--}"
SIGN_OPTIONS=(--force --sign "$IDENTITY" --timestamp=none)
if [ "$IDENTITY" != - ]; then
 SIGN_OPTIONS+=(--options runtime)
fi
# Sign the nested universal native host first, then seal the whole app.
/usr/bin/codesign "${SIGN_OPTIONS[@]}" "$CONTENTS/MacOS/ssh-browser-native-host"
/usr/bin/codesign "${SIGN_OPTIONS[@]}" "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
for ARCH in arm64 x86_64; do
 /usr/bin/lipo "$CONTENTS/MacOS/SSH Browser Helper" -verify_arch "$ARCH"
 /usr/bin/lipo "$CONTENTS/MacOS/ssh-browser-native-host" -verify_arch "$ARCH"
done
/usr/bin/ditto -c -k --keepParent --norsrc "$APP" "$WORK/$ZIP_NAME"

DMG_CREATED=0
if [ "$SKIP_DMG" = 0 ] && command -v hdiutil >/dev/null; then
 mkdir -p "$WORK/dmg-source"
 /usr/bin/ditto --norsrc "$APP" "$WORK/dmg-source/$APP_NAME"
 ln -s /Applications "$WORK/dmg-source/Applications"
 if hdiutil create -volname 'SSH Browser Helper' -srcfolder "$WORK/dmg-source" \
   -format UDZO "$WORK/$DMG_NAME"; then
  DMG_CREATED=1
 else
  echo 'Warning: optional DMG creation failed; preserving the app and ZIP artifacts.' >&2
 fi
fi

check_outputs
/bin/mv -n "$APP" "$OUTPUT/$APP_NAME"
/bin/mv -n "$WORK/$ZIP_NAME" "$OUTPUT/$ZIP_NAME"
/bin/mv -n "$WORK/$EXTENSION_ZIP_NAME" "$OUTPUT/$EXTENSION_ZIP_NAME"
if [ "$DMG_CREATED" = 1 ]; then
 /bin/mv -n "$WORK/$DMG_NAME" "$OUTPUT/$DMG_NAME"
 printf 'DMG: %s/%s\n' "$OUTPUT" "$DMG_NAME"
fi
printf 'App: %s/%s\nHelper ZIP: %s/%s\nExtension ZIP: %s/%s\n' \
 "$OUTPUT" "$APP_NAME" "$OUTPUT" "$ZIP_NAME" "$OUTPUT" "$EXTENSION_ZIP_NAME"
echo 'Developer distribution: signed, but NOT notarized. macOS security policy may restrict opening it.'
echo 'No installation, browser registration, app/native-host execution, or Gatekeeper changes were performed.'
