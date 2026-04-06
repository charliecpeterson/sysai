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

# cap — run a command and capture its output for `??` to analyse later.
# Stdout+stderr are shown normally via tee; the file is trimmed to 100 KB
# after the command finishes so sysai context stays reasonable.
cap () {
  local _out="$HOME/.sysai/last_output"
  "$@" 2>&1 | tee "$_out"
  if [ -f "$_out" ]; then
    local _n
    _n=$(wc -c < "$_out")
    [ "${_n// /}" -gt 102400 ] && \
      tail -c 102400 "$_out" > "$_out.tmp" && mv "$_out.tmp" "$_out"
  fi
}

# ?? — send the last captured output to sysai for analysis.
# Usage:  ??                      (default prompt: explain and highlight errors)
#         ?? why did this fail    (custom question)
_sysai_last () {
  local _out="$HOME/.sysai/last_output"
  if [ ! -s "$_out" ]; then
    printf 'sysai: nothing captured yet — run: cap <command>\n' >&2
    return 1
  fi
  cat "$_out" | "$SYSAI_BIN" ask "${@:-explain this output and highlight any errors}"
}
alias '??'='_sysai_last'

