# sysai shell integration — managed by sysai, do not edit manually
# Sourced via: [ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash

SYSAI_BIN="$HOME/.sysai/bin/sysai"

# Use a helper function + alias pattern so that bash expands the alias
# before pathname expansion — otherwise bare `?` glob-expands to any
# single-character filename in the current directory before the function
# is ever looked up.
_sysai_ask () {
  "$SYSAI_BIN" ask "$@"
}
alias '?'='_sysai_ask'

