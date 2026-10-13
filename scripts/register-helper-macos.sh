#!/bin/bash
set -euo pipefail
APP=""
BROWSER=chrome
ID=""
usage() { echo 'Usage: register-helper-macos.sh --app PATH [--browser chrome|chromium|aside|all] [--extension-id ID]' >&2; }
while [ $# -gt 0 ]; do
 case "$1" in
  --app|--browser|--extension-id)
   [ $# -ge 2 ] && [ -n "$2" ] || { usage; exit 2; }
   case "$1" in --app) APP="$2";; --browser) BROWSER="$2";; --extension-id) ID="$2";; esac
   shift 2;;
  *) usage; exit 2;;
 esac
done
[ -n "${HOME:-}" ] && [[ "$HOME" = /* ]] || { echo 'HOME must be an absolute path.' >&2; exit 2; }
case "$BROWSER" in chrome|chromium|aside) BROWSERS=("$BROWSER");; all) BROWSERS=(chrome chromium aside);; *) usage; exit 2;; esac
APP="${APP%/}"
[[ "$APP" = /*.app ]] && [ -d "$APP" ] || { echo 'Expected an absolute path to an existing Helper.app bundle.' >&2; exit 2; }
APP="$(cd "$APP" && pwd -P)"
HOST="$APP/Contents/MacOS/ssh-browser-native-host"
[ -f "$APP/Contents/Info.plist" ] && [ -f "$HOST" ] && [ -x "$HOST" ] || { echo "Invalid helper app: Info.plist or executable native host missing at $APP" >&2; exit 2; }
if [ -z "$ID" ]; then
 [ -f "$APP/Contents/Resources/extension-id.txt" ] || { echo "Extension ID resource missing at $APP/Contents/Resources/extension-id.txt" >&2; exit 2; }
 ID="$(cat "$APP/Contents/Resources/extension-id.txt")"
fi
[[ "$ID" =~ ^[a-p]{32}$ ]] || { echo 'Invalid Chrome extension ID: expected 32 letters a-p.' >&2; exit 2; }
profile() {
 case "$1" in chrome) printf '%s' "$HOME/Library/Application Support/Google/Chrome";; chromium) printf '%s' "$HOME/Library/Application Support/Chromium";; aside) printf '%s' "$HOME/Library/Application Support/Aside";; esac
}
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
# Preflight every selected path before writing any registration. Refuse directory
# and symlink targets rather than letting mv place a manifest inside a directory.
for browser in "${BROWSERS[@]}"; do
 dir="$(profile "$browser")/NativeMessagingHosts"
 parents=("$HOME/Library" "$HOME/Library/Application Support")
 if [ "$browser" = chrome ]; then parents+=("$HOME/Library/Application Support/Google"); fi
 parents+=("$(profile "$browser")" "$dir")
 for parent in "${parents[@]}"; do
  [ ! -L "$parent" ] || { echo "Refusing symlink registration directory: $parent" >&2; exit 1; }
  [ ! -e "$parent" ] || [ -d "$parent" ] || { echo "Expected a registration directory: $parent" >&2; exit 1; }
 done
 target="$dir/com.sshbrowser.helper.json"
 [ ! -L "$target" ] || { echo "Refusing symlink manifest: $target" >&2; exit 1; }
 [ ! -e "$target" ] || [ -f "$target" ] || { echo "Expected a manifest file: $target" >&2; exit 1; }
done
TEMP=""
trap '[ -z "$TEMP" ] || rm -f "$TEMP"' EXIT
ESCAPED="$(json_escape "$HOST")"
for browser in "${BROWSERS[@]}"; do
 dir="$(profile "$browser")/NativeMessagingHosts"
 mkdir -p "$dir"
 TEMP="$(mktemp "$dir/.ssh-browser.XXXXXX")"
 printf '{"name":"com.sshbrowser.helper","description":"SSH Browser native helper","path":"%s","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' "$ESCAPED" "$ID" > "$TEMP"
 chmod 600 "$TEMP"
 mv -f "$TEMP" "$dir/com.sshbrowser.helper.json"
 TEMP=""
 echo "Registered $browser Native Messaging: $HOST"
done
