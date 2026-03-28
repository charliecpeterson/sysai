# sysai shell integration — managed by sysai, do not edit manually
# Sourced via: source ~/.sysai/shell.fish

set -gx SYSAI_BIN "$HOME/.sysai/bin/sysai"

function _sysai_ask
    $SYSAI_BIN ask $argv
end

abbr -a '?' '_sysai_ask'
