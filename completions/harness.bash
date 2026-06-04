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

_harness_complete_use_case_ids() {
  local change_set_id="$1"
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion use-case "$change_set_id" --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_complete_use_case_dirs() {
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion use-case-directory --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_complete_work_item_ids() {
  local change_set_id="$1"
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion work-item "$change_set_id" --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_complete_run_ids() {
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion run --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_complete_stage_ids() {
  local change_set_id="$1"
  local current_word="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(python3 -m harness_codex.runtime.shell_completion stage "$change_set_id" --repo-root . --prefix "$current_word" --format bash 2>/dev/null)
}

_harness_completion() {
  local command="${COMP_WORDS[1]:-}"
  local subcommand="${COMP_WORDS[2]:-}"
  local current_word="${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "help init update reset agent-context changes contracts requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation ultrawork evolution stages artifacts resume report dashboard ui-server" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "help" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "help init agent-context changes contracts requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation ultrawork evolution stages artifacts resume report dashboard ui-server update reset" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "changes" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "list active show contents delete document-delta" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "changes" && ("$subcommand" == "show" || "$subcommand" == "contents") && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "changes" && ("$subcommand" == "delete" || "$subcommand" == "document-delta") && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids active
    return 0
  fi

  if [[ "$command" == "contracts" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "validate" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "contracts" && "$subcommand" == "validate" && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "agent-context" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "init" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "evolution" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "propose accept reject" -- "$current_word") )
    return 0
  fi

  if [[ "$command" =~ ^(requirements-definition|ubiquitous-language-definition|use-case-definition|event-storming|ddd-architecture-definition|technical-decisions|plan-writing|implementation)$ && $COMP_CWORD -eq 2 ]]; then
    _harness_complete_changeset_ids active
    return 0
  fi

  if [[ "$command" =~ ^(requirements-definition|ubiquitous-language-definition|use-case-definition|event-storming|ddd-architecture-definition|technical-decisions|plan-writing|implementation)$ && $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=( $(compgen -W "--plan --preview --apply" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "stages" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "list" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "stages" && "$subcommand" == "list" && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "artifacts" && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "show accept" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "artifacts" && ("$subcommand" == "show" || "$subcommand" == "accept") && $COMP_CWORD -eq 3 ]]; then
    _harness_complete_changeset_ids all
    return 0
  fi

  if [[ "$command" == "artifacts" && ("$subcommand" == "show" || "$subcommand" == "accept") && $COMP_CWORD -eq 4 ]]; then
    _harness_complete_stage_ids "${COMP_WORDS[3]}"
    return 0
  fi

  if [[ "$command" == "ultrawork" && "$current_word" == --* ]]; then
    COMPREPLY=( $(compgen -W "--title --change-set-id --related-issue --uc --force --plan --preview --apply" -- "$current_word") )
    return 0
  fi

  if [[ ("$command" == "resume" || "$command" == "report") && $COMP_CWORD -eq 2 ]]; then
    _harness_complete_run_ids
    return 0
  fi

  if [[ "$command" == "update" && "$current_word" == --* ]]; then
    COMPREPLY=( $(compgen -W "--repo --ref --skip-venv --dry-run" -- "$current_word") )
    return 0
  fi

  if [[ "$command" == "reset" && "$current_word" == --* ]]; then
    COMPREPLY=( $(compgen -W "--runs --workflow-artifacts --all --apply" -- "$current_word") )
    return 0
  fi

  COMPREPLY=()
}

complete -F _harness_completion harness
complete -F _harness_completion ./harness
