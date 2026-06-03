# Bash completion for harness.
# Install:
#   source completions/harness.bash
# or add that line to ~/.bashrc.

_harness_complete_run_change_ids() {
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion run-change --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_completion() {
  local command="${COMP_WORDS[1]:-}"
  local current_word="${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "harvest agent-context changes run-change ultrawork run-use-case run-work-item stages artifacts run-stage resume report dashboard ui-server" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "run-change" && $COMP_CWORD -eq 2 ]]; then
    _harness_complete_run_change_ids
    return 0
  fi

  if [[ "$command" == "run-change" && $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=( $(compgen -W "--plan --preview --apply" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "ultrawork" && "$current_word" == --* ]]; then
    COMPREPLY=( $(compgen -W "--title --change-set-id --related-issue --uc --force --plan --preview --apply" -- "$current_word") )
    return 0
  fi

  COMPREPLY=()
}

complete -F _harness_completion harness
complete -F _harness_completion ./harness
