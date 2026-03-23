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
