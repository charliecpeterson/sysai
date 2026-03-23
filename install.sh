#!/usr/bin/env bash
# install.sh — set up sysai shell integration
#
# Adds the ? function to your shell rc file and links the sysai binary.
# Run with: bash bin/install.sh

set -euo pipefail

SYSAI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSAI_HOME="$HOME/.sysai"
SYSAI_BIN_DIR="$SYSAI_HOME/bin"
SYSAI_BIN="$SYSAI_BIN_DIR/sysai"
CONFIG_FILE="$SYSAI_HOME/config"

# Create ~/.sysai directory structure
mkdir -p "$SYSAI_BIN_DIR" "$SYSAI_HOME/history"
chmod 700 "$SYSAI_HOME"

# ── colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
info()    { echo -e "${CYAN}sysai:${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }

# ── detect shell rc file ──────────────────────────────────────────────────────
detect_rc() {
  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"
  case "$shell_name" in
    zsh)   echo "$HOME/.zshrc" ;;
    bash)  echo "$HOME/.bashrc" ;;
    fish)  echo "$HOME/.config/fish/config.fish" ;;
    *)     echo "$HOME/.bashrc" ;;
  esac
}

RC_FILE="$(detect_rc)"
SHELL_NAME="$(basename "${SHELL:-bash}")"

echo ""
echo "  sysai — terminal-native sysadmin AI assistant"
echo "  ───────────────────────────────────────────────"
echo ""

# ── Authentication ────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  echo "  Which AI provider?"
  echo ""
  echo "    1) Anthropic  (Claude)"
  echo "    2) OpenAI     (GPT-4o etc.)"
  echo "    3) llama.cpp  (local / OpenAI-compatible endpoint)"
  echo ""
  echo -n "  Choose [1/2/3]: "
  read -r provider_choice

  case "$provider_choice" in
    1)
      echo "SYSAI_PROVIDER=anthropic" > "$CONFIG_FILE"
      echo -n "  Anthropic API key: "
      read -r api_key
      [ -n "$api_key" ] && echo "ANTHROPIC_API_KEY=$api_key" >> "$CONFIG_FILE"
      echo -n "  Model (Enter for claude-sonnet-4-6): "
      read -r model
      [ -n "$model" ] && echo "SYSAI_MODEL=$model" >> "$CONFIG_FILE"
      ;;
    2)
      echo "SYSAI_PROVIDER=openai" > "$CONFIG_FILE"
      echo -n "  OpenAI API key: "
      read -r api_key
      [ -n "$api_key" ] && echo "OPENAI_API_KEY=$api_key" >> "$CONFIG_FILE"
      echo -n "  Model (Enter for gpt-4o): "
      read -r model
      [ -n "$model" ] && echo "SYSAI_MODEL=$model" >> "$CONFIG_FILE"
      ;;
    3)
      echo "SYSAI_PROVIDER=llamacpp" > "$CONFIG_FILE"
      echo -n "  Base URL (e.g. http://localhost:8080/v1): "
      read -r base_url
      [ -n "$base_url" ] && echo "SYSAI_BASE_URL=$base_url" >> "$CONFIG_FILE"
      echo -n "  API key (Enter to skip): "
      read -r api_key
      [ -n "$api_key" ] && echo "SYSAI_API_KEY=$api_key" >> "$CONFIG_FILE"
      echo -n "  Model name: "
      read -r model
      [ -n "$model" ] && echo "SYSAI_MODEL=$model" >> "$CONFIG_FILE"
      ;;
    *)
      warn "No provider configured. Edit ~/.sysai manually."
      ;;
  esac

  [ -f "$CONFIG_FILE" ] && chmod 600 "$CONFIG_FILE" && success "Config saved to ~/.sysai"
else
  success "~/.sysai config already exists"
fi

# ── link or build the binary ──────────────────────────────────────────────────
OS="$(uname -s | tr A-Z a-z)"
ARCH="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/;s/arm64/arm64/')"
PREBUILT="$SYSAI_DIR/dist/sysai-${OS}-${ARCH}"

if [ -f "$PREBUILT" ]; then
  cp "$PREBUILT" "$SYSAI_BIN"
  chmod +x "$SYSAI_BIN"
  success "Installed binary to ~/.sysai/bin/sysai"
else
  # No prebuilt binary — link the Node.js source directly
  ln -sf "$SYSAI_DIR/main.js" "$SYSAI_BIN"
  chmod +x "$SYSAI_DIR/main.js"
  # Also ensure it's on PATH via ~/.local/bin
  mkdir -p "$HOME/.local/bin"
  ln -sf "$SYSAI_BIN" "$HOME/.local/bin/sysai"
  success "Linked sysai to ~/.sysai/bin/sysai (node.js mode — run 'npm run build' to compile)"
fi

# ── write managed shell.bash ──────────────────────────────────────────────────
SHELL_INTEGRATION="$SYSAI_HOME/shell.bash"
SOURCE_LINE='[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash'

cat > "$SHELL_INTEGRATION" <<'SHELL_BASH'
# sysai shell integration — managed by sysai, do not edit manually
# Sourced via: [ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash

SYSAI_BIN="$HOME/.sysai/bin/sysai"

? () {
  if [ -t 0 ]; then
    "$SYSAI_BIN" ask "$@"
  else
    cat | "$SYSAI_BIN" ask "$@"
  fi
}

ai-pane () { "$SYSAI_BIN" repl; }
SHELL_BASH
chmod 644 "$SHELL_INTEGRATION"
success "Wrote shell integration to ~/.sysai/shell.bash"

# ── inject one-liner into RC file ─────────────────────────────────────────────

# Migration: remove old inline block if present
if grep -q "# sysai shell integration" "$RC_FILE" 2>/dev/null; then
  sed -i.bak '/# sysai shell integration/,/# END_SYSAI/d' "$RC_FILE"
  rm -f "${RC_FILE}.bak"
  info "Removed old inline shell integration from $RC_FILE"
fi

if [ "$SHELL_NAME" = "fish" ]; then
  warn "Fish shell detected. Automatic install not supported yet."
  warn "Add the ? function to your fish config manually (see README)."
elif grep -qF "source ~/.sysai/shell.bash" "$RC_FILE" 2>/dev/null; then
  success "Shell integration already sourced in $RC_FILE"
else
  echo "" >> "$RC_FILE"
  echo "$SOURCE_LINE" >> "$RC_FILE"
  success "Added source line to $RC_FILE"
fi

# ── npm install ───────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
(cd "$SYSAI_DIR" && npm install --silent)
success "Dependencies installed"

# ── done ─────────────────────────────────────────────────────────────────────
echo ""
echo "  Done! Reload your shell then test with:"
echo ""
echo -e "    ${CYAN}source $RC_FILE${NC}"
echo -e "    ${CYAN}? hello${NC}"
echo ""
echo "  Optional: open the tmux AI pane with:"
echo -e "    ${CYAN}ai-pane${NC}"
echo ""
