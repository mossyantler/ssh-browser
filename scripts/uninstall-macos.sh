#!/bin/bash
set -euo pipefail
BROWSER=chrome
if [ "$#" -gt 0 ]; then
 [ "$1" = --browser ] && [ "$#" = 2 ] || { echo 'Usage: uninstall-macos.sh [--browser chrome|chromium|aside|all]' >&2; exit 2; }
 BROWSER="$2"
fi
case "$BROWSER" in chrome|chromium|aside) BROWSERS=("$BROWSER");; all) BROWSERS=(chrome chromium aside);; *) echo 'Unsupported browser' >&2; exit 2;; esac
[ -n "${HOME:-}" ] && [[ "$HOME" = /* ]] || { echo 'HOME must be an absolute path.' >&2; exit 2; }
profile() {
 case "$1" in chrome) printf '%s' "$HOME/Library/Application Support/Google/Chrome";; chromium) printf '%s' "$HOME/Library/Application Support/Chromium";; aside) printf '%s' "$HOME/Library/Application Support/Aside";; esac
}
DEST="$HOME/Library/Application Support/SSH Browser"
echo 'Disconnect SSH Browser in the selected browsers before removing its helper registration.'
for browser in "${BROWSERS[@]}"; do
 rm -f "$(profile "$browser")/NativeMessagingHosts/com.sshbrowser.helper.json"
 echo "Removed helper registration for $browser."
done
# All supported registrations share one helper. Keep it until the last is removed.
for browser in chrome chromium aside; do
 file="$(profile "$browser")/NativeMessagingHosts/com.sshbrowser.helper.json"
 if [ -e "$file" ] || [ -L "$file" ]; then
  echo "Shared helper kept: $browser is still registered."
  exit 0
 fi
done
if [ ! -L "$DEST" ] && [ ! -L "$DEST/.installed-by-ssh-browser" ] && [ -f "$DEST/.installed-by-ssh-browser" ] && [ "$(cat "$DEST/.installed-by-ssh-browser")" = ssh-browser-v1 ]; then
 # Preserve the ownership marker if the helper path has become foreign or unsafe.
 if [ -L "$DEST/bin" ] || [ -L "$DEST/bin/ssh-browser-helper" ] || { [ -e "$DEST/bin/ssh-browser-helper" ] && [ ! -f "$DEST/bin/ssh-browser-helper" ]; }; then
  echo 'Shared helper path is not a regular installer-owned file; kept helper and marker.'
  exit 0
 fi
 rm -f "$DEST/bin/ssh-browser-helper"
 rmdir "$DEST/bin" 2>/dev/null || true
 rm -f "$DEST/.installed-by-ssh-browser"
 rmdir "$DEST" 2>/dev/null || true
fi
echo 'Helper unregistration complete.'
