# Bash completion for harness.
# Install:
#   source completions/harness.bash
# or add that line to ~/.bashrc.

_harness_complete_changeset_ids() {
  local scope="${1:-all}"
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion change-set --repo-root . --prefix "$current_word" --scope "$scope" --format bash 2>/dev/null)
}

_harness_completion() {
  local command="${COMP_WORDS[1]:-}"
  local current_word="${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "harvest agent-context changes requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation run-change run-use-case run-work-item stages artifacts run-stage resume report dashboard ui-server" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "run-change" && $COMP_CWORD -eq 2 ]]; then
    _harness_complete_changeset_ids active
    return 0
  fi

  if [[ "$command" == "run-use-case" || "$command" == "run-work-item" || "$command" == "run-stage" ]]; then
    if [[ $COMP_CWORD -eq 2 ]]; then
      _harness_complete_changeset_ids active
      return 0
    fi
  fi

  if [[ "$command" =~ ^(ubiquitous-language-definition|use-case-definition|event-storming|ddd-architecture-definition|technical-decisions|plan-writing|implementation)$ && $COMP_CWORD -eq 2 ]]; then
    _harness_complete_changeset_ids active
    return 0
  fi

  if [[ "$command" == "changes" && ("${COMP_WORDS[2]:-}" == "show" || "${COMP_WORDS[2]:-}" == "contents") && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "changes" && "${COMP_WORDS[2]:-}" == "document-delta" && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids active
    return 0
  fi

  if [[ "$command" == "contracts" && "${COMP_WORDS[2]:-}" == "validate" && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "stages" && "${COMP_WORDS[2]:-}" == "list" && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "artifacts" && ("${COMP_WORDS[2]:-}" == "show" || "${COMP_WORDS[2]:-}" == "accept") && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "run-change" && $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=( $(compgen -W "--plan --preview --apply" -- "$current_word") )
    return 0
  fi

  COMPREPLY=()
}

complete -F _harness_completion harness
complete -F _harness_completion ./harness
