# Bash completion for harness.

_harness_completion() {
  local current="${COMP_WORDS[COMP_CWORD]}"
  local commands="help init agent-context changes contracts completion run requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation evolution stages artifacts resume report dashboard ui-server update reset"
  local stages="requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$current") )
    return 0
  fi

  if [[ "$command" == "help" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$current") )
    return 0
  fi

  if [[ "$command" == "changes" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "list active show contents delete continue document-delta" -- "$current") )
    return 0
  fi

  if [[ " $stages " == *" ${COMP_WORDS[1]:-} "* && "$current" == --* ]]; then
    COMPREPLY=( $(compgen -W "--uc --title --idea --force --plan --preview --apply" -- "$current") )
    return 0
  fi

  if [[ "${COMP_WORDS[1]:-}" == "run" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "app wiki" -- "$current") )
    return 0
  fi

  COMPREPLY=()
}

complete -F _harness_completion harness
complete -F _harness_completion ./harness
