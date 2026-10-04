#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSER=chrome
ID="$(cat "$ROOT/extension/ID.txt")"
while [ $# -gt 0 ]; do
 case "$1" in
  --browser) BROWSER="$2"; shift 2;;
  --extension-id) ID="$2"; shift 2;;
  *) echo "Usage: $0 [--browser chrome|chromium] [--extension-id ID]" >&2; exit 2;;
 esac
done
[[ "$ID" =~ ^[a-p]{32}$ ]] || { echo 'Invalid Chrome extension ID' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'This installer supports macOS only.' >&2; exit 2; }
case "$BROWSER" in
 chrome) PROFILE="$HOME/Library/Application Support/Google/Chrome";;
 chromium) PROFILE="$HOME/Library/Application Support/Chromium";;
 *) echo 'Unsupported browser' >&2; exit 2;;
esac
case "$(uname -m)" in
 arm64) ARCH=arm64;;
 x86_64) ARCH=amd64;;
 *) echo 'Unsupported CPU architecture' >&2; exit 2;;
esac
SOURCE="$ROOT/bin/ssh-browser-helper-darwin-$ARCH"
[ -f "$SOURCE" ] || { echo 'Helper binary missing; build first.' >&2; exit 1; }
DEST="$HOME/Library/Application Support/SSH Browser"
MANIFEST_DIR="$PROFILE/NativeMessagingHosts"
mkdir -p "$DEST/bin" "$MANIFEST_DIR"
chmod 700 "$DEST" "$DEST/bin"
install -m 755 "$SOURCE" "$DEST/bin/ssh-browser-helper"
printf '%s\n' 'ssh-browser-v1' > "$DEST/.installed-by-ssh-browser"
# Escape a user-specific path as a JSON string. Reject newlines first.
BIN="$DEST/bin/ssh-browser-helper"
[[ ! "$BIN" =~ [[:cntrl:]] ]] || { echo 'Unsupported control character in home path' >&2; exit 2; }
ESCAPED="$(printf '%s' "$BIN" | sed 's/\\/\\\\/g; s/"/\\"/g')"
TEMP="$(mktemp "$MANIFEST_DIR/.ssh-browser.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT
cat > "$TEMP" <<JSON
{"name":"com.sshbrowser.helper","description":"SSH Browser macOS helper","path":"$ESCAPED","type":"stdio","allowed_origins":["chrome-extension://$ID/"]}
JSON
# JSON generation uses only a validated ID and an escaped, control-free path.
# The install regression test parses this file as JSON; plutil -lint expects plist input.
chmod 600 "$TEMP"
mv "$TEMP" "$MANIFEST_DIR/com.sshbrowser.helper.json"
echo "Installed helper for $BROWSER. Extension ID: $ID"
echo 'No SSH credentials or configuration were modified.'
