#compdef harness
# Zsh wrapper for the harness Bash completion.
# Source this file from a harness-codex repository checkout:
#   source scripts/harness-completion.zsh

autoload -Uz bashcompinit
bashcompinit

local completion_file="${0:A:h}/harness-completion.bash"
if [[ -f "$completion_file" ]]; then
  source "$completion_file"
else
  print -u2 "harness completion not found: $completion_file"
fi
