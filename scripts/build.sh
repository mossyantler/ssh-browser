#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GO_BIN="${GO_BIN:-go}"
mkdir -p "$ROOT/bin"
cd "$ROOT/helper"
"$GO_BIN" vet ./...
# Compile tests, but never execute unsigned native test binaries by default.
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
"$GO_BIN" test -c -o "$TEST_DIR/helper-unit.test" .
if [ "${1:-}" = --run-tests ]; then
 echo 'Native test execution explicitly requested. Respect macOS Gatekeeper; do not bypass it.'
 "$GO_BIN" test ./...
fi
for ARCH in arm64 amd64; do
 GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=0 "$GO_BIN" build -trimpath -ldflags='-s -w' -o "$ROOT/bin/ssh-browser-helper-darwin-$ARCH" .
 if [ "$(uname -s)" = Darwin ]; then /usr/bin/codesign --force --sign - "$ROOT/bin/ssh-browser-helper-darwin-$ARCH" >/dev/null; fi
done
echo 'Built macOS arm64 and Intel helpers.'
