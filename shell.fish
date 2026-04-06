# sysai shell integration — managed by sysai, do not edit manually
# Sourced via: source ~/.sysai/shell.fish

set -gx SYSAI_BIN "$HOME/.sysai/bin/sysai"

function _sysai_ask
    $SYSAI_BIN ask $argv
end

abbr -a '?' '_sysai_ask'

# cap — run a command and capture stdout+stderr for `??` to analyse later.
# Output is shown normally via tee; file is trimmed to 100 KB afterwards.
function cap
    set -l _out "$HOME/.sysai/last_output"
    $argv 2>&1 | tee "$_out"
    if test -f "$_out"
        set -l _n (wc -c < "$_out" | string trim)
        if test "$_n" -gt 102400
            tail -c 102400 "$_out" > "$_out.tmp"; and mv "$_out.tmp" "$_out"
        end
    end
end

# ?? — send last captured output to sysai.
# Usage:  ??                      (default prompt)
#         ?? why did this fail    (custom question)
function _sysai_last
    set -l _out "$HOME/.sysai/last_output"
    if not test -s "$_out"
        echo 'sysai: nothing captured yet — run: cap <command>' >&2
        return 1
    end
    cat "$_out" | $SYSAI_BIN ask $argv
end

abbr -a '??' '_sysai_last'
