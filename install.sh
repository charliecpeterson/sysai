#!/usr/bin/env bash
# sysai installer
# Usage: curl -fsSL https://raw.githubusercontent.com/charliecpeterson/sysai/main/install.sh | bash

set -euo pipefail

REPO="charliecpeterson/sysai"
RELEASES="https://github.com/${REPO}/releases/latest/download"

# ── Detect OS ────────────────────────────────────────────────────────────────

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *)
    echo "error: unsupported OS: $(uname -s)"
    echo "sysai supports macOS and Linux."
    exit 1
    ;;
esac

# ── Detect arch ───────────────────────────────────────────────────────────────

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *)
    echo "error: unsupported architecture: $(uname -m)"
    echo "sysai supports x64 and arm64."
    exit 1
    ;;
esac

BINARY="sysai-${OS}-${ARCH}"
URL="${RELEASES}/${BINARY}"
CHECKSUM_URL="${RELEASES}/checksums.txt"

echo ""
echo "  sysai installer"
echo "  platform: ${OS}/${ARCH}"
echo ""

# ── Download ──────────────────────────────────────────────────────────────────

TMP=$(mktemp)
TMP_CHECKSUMS=$(mktemp)

cleanup() { rm -f "$TMP" "$TMP_CHECKSUMS"; }
trap cleanup EXIT

echo "  Downloading ${BINARY}..."
if ! curl -fsSL --progress-bar "$URL" -o "$TMP"; then
  echo ""
  echo "error: download failed. Check https://github.com/${REPO}/releases for available binaries."
  exit 1
fi

# ── Verify checksum ───────────────────────────────────────────────────────────

echo "  Verifying checksum..."
if ! curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUMS" 2>/dev/null; then
  echo "  ⚠ Warning: could not download checksums.txt — skipping verification."
  echo "    If this concerns you, download manually from https://github.com/${REPO}/releases"
else
  EXPECTED=$(grep "$BINARY" "$TMP_CHECKSUMS" | awk '{print $1}')
  if [ -z "$EXPECTED" ]; then
    echo "  ⚠ Warning: no checksum found for ${BINARY} in checksums.txt"
  else
    if command -v sha256sum &>/dev/null; then
      ACTUAL=$(sha256sum "$TMP" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
      ACTUAL=$(shasum -a 256 "$TMP" | awk '{print $1}')
    else
      echo "  ⚠ Warning: neither sha256sum nor shasum found — cannot verify checksum."
      ACTUAL=""
    fi

    if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "error: checksum mismatch — download may be corrupted."
      echo "  expected: $EXPECTED"
      echo "  got:      $ACTUAL"
      exit 1
    fi
    if [ -n "$ACTUAL" ]; then
      echo "  ✓ Checksum verified"
    fi
  fi
fi

# ── Run sysai install ─────────────────────────────────────────────────────────

chmod +x "$TMP"
"$TMP" install
