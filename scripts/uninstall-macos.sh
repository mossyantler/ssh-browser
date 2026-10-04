#!/bin/bash
set -euo pipefail
BROWSER=chrome
if [ "$#" -gt 0 ]; then
 [ "$1" = --browser ] && [ "$#" = 2 ] || { echo 'Usage: uninstall-macos.sh [--browser chrome|chromium]' >&2; exit 2; }
 BROWSER="$2"
fi
case "$BROWSER" in
 chrome) PROFILE="$HOME/Library/Application Support/Google/Chrome";;
 chromium) PROFILE="$HOME/Library/Application Support/Chromium";;
 *) echo 'Unsupported browser' >&2; exit 2;;
esac
DEST="$HOME/Library/Application Support/SSH Browser"
echo 'First disconnect SSH Browser and disable/remove its Chrome extension.'
rm -f "$PROFILE/NativeMessagingHosts/com.sshbrowser.helper.json"
if [ -f "$DEST/.installed-by-ssh-browser" ] && [ "$(cat "$DEST/.installed-by-ssh-browser")" = ssh-browser-v1 ]; then
 rm -f "$DEST/bin/ssh-browser-helper" "$DEST/.installed-by-ssh-browser"
 rmdir "$DEST/bin" "$DEST" 2>/dev/null || true
fi
echo 'Removed registered helper. SSH keys, config and known_hosts were not touched.'
