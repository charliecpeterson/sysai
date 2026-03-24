#!/usr/bin/env bash
# build.sh — compile sysai to self-contained binaries
#
# Requires bun: https://bun.sh (curl -fsSL https://bun.sh/install | bash)
# Output: dist/sysai-<os>-<arch>

set -euo pipefail

DIST="$(dirname "$0")/dist"
mkdir -p "$DIST"

if ! command -v bun &>/dev/null; then
  echo "error: bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "Building sysai binaries..."

targets=(
  "bun-linux-x64    sysai-linux-x64"
  "bun-linux-arm64  sysai-linux-arm64"
  "bun-darwin-arm64 sysai-darwin-arm64"
  "bun-darwin-x64   sysai-darwin-x64"
)

for entry in "${targets[@]}"; do
  target=$(echo "$entry" | awk '{print $1}')
  outname=$(echo "$entry" | awk '{print $2}')
  echo "  → $outname"
  bun build --compile --minify --target="$target" main.js --outfile "$DIST/$outname" 2>/dev/null
done

echo ""
echo "Built:"
ls -lh "$DIST"/sysai-* 2>/dev/null | awk '{print "  " $5 "  " $9}'
echo ""
echo "Install locally:   node main.js install"
echo "Deploy to remote:  scp dist/sysai-linux-x64 <host>:/tmp/sysai && ssh <host> '/tmp/sysai install'"
