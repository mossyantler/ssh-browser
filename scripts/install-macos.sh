#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSER=chrome
ID=""
usage() { echo 'Usage: install-macos.sh [--browser chrome|chromium|aside|all] [--extension-id ID] [--payload-dir PATH]' >&2; }
while [ $# -gt 0 ]; do
 case "$1" in
  --browser|--extension-id|--payload-dir)
   [ $# -ge 2 ] || { usage; exit 2; }
   case "$1" in --browser) BROWSER="$2";; --extension-id) ID="$2";; --payload-dir) ROOT="$2";; esac
   shift 2;;
  *) usage; exit 2;;
 esac
done
case "$BROWSER" in chrome|chromium|aside) BROWSERS=("$BROWSER");; all) BROWSERS=(chrome chromium aside);; *) usage; exit 2;; esac
[ "$(uname -s)" = Darwin ] || { echo 'This installer supports macOS only.' >&2; exit 2; }
[ -n "${HOME:-}" ] && [[ "$HOME" = /* ]] || { echo 'HOME must be an absolute path.' >&2; exit 2; }
if [ -z "$ID" ]; then ID="$(cat "$ROOT/extension/ID.txt")"; fi
[[ "$ID" =~ ^[a-p]{32}$ ]] || { echo 'Invalid Chrome extension ID' >&2; exit 2; }
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo 'Unsupported CPU architecture' >&2; exit 2;; esac
SOURCE="$ROOT/bin/ssh-browser-helper-darwin-$ARCH"
[ -f "$SOURCE" ] || { echo 'Bundled helper missing. Developers: run scripts/build.sh before packaging.' >&2; exit 1; }
DEST="$HOME/Library/Application Support/SSH Browser"
BIN="$DEST/bin/ssh-browser-helper"
MARKER="$DEST/.installed-by-ssh-browser"
# Pure bash JSON escaping: no Python, Node, Go or developer tools at install time.
json_escape() {
 local value="$1" char encoded i octal
 value="${value//\\/\\\\}"
 value="${value//\"/\\\"}"
 for ((i=1; i<32; i++)); do
  printf -v octal '%03o' "$i"
  printf -v char '%b' "\\$octal"
  printf -v encoded '\\u%04x' "$i"
  value="${value//"$char"/$encoded}"
 done
 printf '%s' "$value"
}
profile() {
 case "$1" in chrome) printf '%s' "$HOME/Library/Application Support/Google/Chrome";; chromium) printf '%s' "$HOME/Library/Application Support/Chromium";; aside) printf '%s' "$HOME/Library/Application Support/Aside";; esac
}
# Never follow an existing installation's symlink when replacing our payload.
for entry in "$DEST" "$DEST/bin" "$BIN" "$MARKER"; do
 [ ! -L "$entry" ] || { echo "Refusing symlink destination: $entry" >&2; exit 1; }
done
for entry in "$BIN" "$MARKER"; do
 [ ! -e "$entry" ] || [ -f "$entry" ] || { echo "Expected a file at destination: $entry" >&2; exit 1; }
done
for entry in "$DEST" "$DEST/bin"; do
 [ ! -e "$entry" ] || [ -d "$entry" ] || { echo "Expected a folder at destination: $entry" >&2; exit 1; }
done
mkdir -m 700 -p "$DEST/bin"
STAGE="$(mktemp -d "$DEST/.install.XXXXXX")"
COMMIT_STARTED=0
SUCCESS=0
HELPER_TOUCHED=0
MARKER_TOUCHED=0
MANIFEST_COUNT=0
MANIFEST_TOUCHED=0
MANIFEST_STAGES=()
MANIFEST_FILES=()
# Restore via a sibling temporary file and rename, never a partial copy over a live file.
restore_file() {
 local backup="$1" file="$2" temporary="$3"
 if [ -f "$backup" ]; then
  cp -p "$backup" "$temporary" && mv -f "$temporary" "$file"
 else
  rm -f "$file"
 fi
}
cleanup() {
 local status=$? i browser restore_failed=0
 set +e
 if [ "$COMMIT_STARTED" = 1 ] && [ "$SUCCESS" != 1 ]; then
  echo 'Installation failed; restoring previous helper and registrations.' >&2
  if [ "$HELPER_TOUCHED" = 1 ]; then
   restore_file "$STAGE/previous-helper" "$BIN" "$STAGE/restore-helper" || restore_failed=1
  fi
  if [ "$MARKER_TOUCHED" = 1 ]; then
   restore_file "$STAGE/.installed-by-ssh-browser.previous" "$MARKER" "$STAGE/restore-marker" || restore_failed=1
  fi
  for ((i=0; i<MANIFEST_TOUCHED; i++)); do
   browser="${BROWSERS[$i]}"
   restore_file "$STAGE/$browser.previous" "${MANIFEST_FILES[$i]}" "${MANIFEST_STAGES[$i]}/restore-$browser" || restore_failed=1
  done
 fi
 if [ "$restore_failed" = 1 ]; then
  echo "Could not fully restore previous files. Recovery backups kept at: $STAGE" >&2
 else
  rm -rf "$STAGE"
 fi
 for ((i=0; i<MANIFEST_COUNT; i++)); do
  rm -rf "${MANIFEST_STAGES[$i]}"
 done
 exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
install -m 755 "$SOURCE" "$STAGE/helper"
printf '%s\n' ssh-browser-v1 > "$STAGE/marker"
chmod 600 "$STAGE/marker"
ESCAPED="$(json_escape "$BIN")"
# Stage all manifests before replacing shared files. Unrelated browser settings stay intact.
for browser in "${BROWSERS[@]}"; do
 dir="$(profile "$browser")/NativeMessagingHosts"
 mkdir -p "$dir"
 file="$dir/com.sshbrowser.helper.json"
 [ ! -L "$file" ] || { echo "Refusing symlink manifest: $file" >&2; exit 1; }
 [ ! -e "$file" ] || [ -f "$file" ] || { echo "Expected a file at manifest path: $file" >&2; exit 1; }
 if [ -f "$file" ]; then cp -p "$file" "$STAGE/$browser.previous"; fi
 # Use the manifest's filesystem so its commit and rollback are atomic renames.
 MANIFEST_FILES[$MANIFEST_COUNT]="$file"
 MANIFEST_STAGES[$MANIFEST_COUNT]="$(mktemp -d "$dir/.ssh-browser-install.XXXXXX")"
 manifest_stage="${MANIFEST_STAGES[$MANIFEST_COUNT]}"
 MANIFEST_COUNT=$((MANIFEST_COUNT + 1))
 printf '{"name":"com.sshbrowser.helper","description":"SSH Browser macOS helper","path":"%s","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' "$ESCAPED" "$ID" > "$manifest_stage/$browser.json"
 chmod 600 "$manifest_stage/$browser.json"
done
# Snapshot owned files before committing, so any failed update can roll back.
if [ -f "$BIN" ]; then cp -p "$BIN" "$STAGE/previous-helper"; fi
if [ -f "$MARKER" ]; then cp -p "$MARKER" "$STAGE/.installed-by-ssh-browser.previous"; fi
COMMIT_STARTED=1
HELPER_TOUCHED=1
mv -f "$STAGE/helper" "$BIN"
MARKER_TOUCHED=1
mv -f "$STAGE/marker" "$MARKER"
for ((i=0; i<MANIFEST_COUNT; i++)); do
 browser="${BROWSERS[$i]}"
 MANIFEST_TOUCHED=$((i + 1))
 mv -f "${MANIFEST_STAGES[$i]}/$browser.json" "${MANIFEST_FILES[$i]}"
 echo "Registered helper for $browser. Extension ID: $ID"
done
SUCCESS=1
echo "Helper installed at: $BIN"
echo 'Next: restart the selected browsers so SSH Browser can reconnect to the helper.'
