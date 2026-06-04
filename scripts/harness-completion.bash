# Bash completion for the harness CLI.
# Source this file from a harness-codex repository checkout:
#   source scripts/harness-completion.bash
#
# Registered commands:
#   harness ...
#   ./harness ...
#
# If Bash does not dispatch completion for ./harness in your environment,
# use `harness ...` via an alias or symlink, or enable default dispatch with:
#   HARNESS_ENABLE_DEFAULT_COMPLETION=1 source scripts/harness-completion.bash

_harness_compgen() {
  local candidates="$1"
  local cur="$2"
  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )
}

_harness_is_launcher() {
  local command_name="${COMP_WORDS[0]##*/}"
  [[ "$command_name" == "harness" ]]
}

_harness_repo_root() {
  local i word
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="${COMP_WORDS[i]}"
    if [[ "$word" == "--repo-root" && $((i + 1)) -lt ${#COMP_WORDS[@]} ]]; then
      printf '%s\n' "${COMP_WORDS[i + 1]}"
      return
    fi
  done

  local git_root
  git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || true
  if [[ -n "$git_root" ]]; then
    printf '%s\n' "$git_root"
  else
    printf '%s\n' "."
  fi
}

_harness_stem() {
  local name="${1##*/}"
  printf '%s\n' "${name%.md}"
}

_harness_change_ids() {
  local root file dir
  root="$(_harness_repo_root)"
  for dir in "$root/docs/changes/active" "$root/docs/changes/completed"; do
    for file in "$dir"/*.md; do
      [[ -f "$file" ]] && _harness_stem "$file"
    done
  done | sort -u
}

_harness_use_case_ids() {
  local root dir
  root="$(_harness_repo_root)"
  for dir in "$root/docs/use-cases"/*; do
    [[ -d "$dir" ]] && printf '%s\n' "${dir##*/}"
  done | sort -u
}

_harness_maintenance_ids() {
  local root dir
  root="$(_harness_repo_root)"
  for dir in "$root/docs/maintenance"/*; do
    [[ -d "$dir" ]] && printf '%s\n' "${dir##*/}"
  done | sort -u
}

_harness_work_item_ids() {
  {
    _harness_use_case_ids
    _harness_maintenance_ids
    local root dir
    root="$(_harness_repo_root)"
    for dir in "$root/docs/plans/active"/* "$root/docs/plans/completed"/*; do
      [[ -d "$dir" ]] && printf '%s\n' "${dir##*/}"
    done
  } | sort -u
}

_harness_change_file() {
  local root="$(_harness_repo_root)"
  local change_id="$1"
  local file
  for file in \
    "$root/docs/changes/active/$change_id.md" \
    "$root/docs/changes/completed/$change_id.md"; do
    [[ -f "$file" ]] && { printf '%s\n' "$file"; return; }
  done
}

_harness_ids_for_change() {
  local change_id="$1"
  local file
  file="$(_harness_change_file "$change_id")"
  if [[ -n "$file" ]]; then
    grep -Eho '\b(UC|MAINT)-[A-Za-z0-9._-]+' "$file" | sort -u
  fi
}

_harness_use_case_ids_for_change() {
  local change_id="$1"
  local ids
  ids="$(_harness_ids_for_change "$change_id" | grep '^UC-' || true)"
  if [[ -n "$ids" ]]; then
    printf '%s\n' "$ids"
  else
    _harness_use_case_ids
  fi
}

_harness_work_item_ids_for_change() {
  local change_id="$1"
  local ids
  ids="$(_harness_ids_for_change "$change_id")"
  if [[ -n "$ids" ]]; then
    printf '%s\n' "$ids"
  else
    _harness_work_item_ids
  fi
}

_harness_run_ids() {
  local root dir
  root="$(_harness_repo_root)"
  for dir in "$root/.harness/runs"/*; do
    [[ -d "$dir" ]] && printf '%s\n' "${dir##*/}"
  done | sort -u
}

_harness_stage_ids() {
  local change_id="$1"
  local root file
  root="$(_harness_repo_root)"
  printf '%s\n' \
    requirements \
    use_cases \
    change_set \
    plan-work-item \
    execute-work-item \
    verify-work-item \
    classify-verification-result \
    complete-work-item-plan

  if [[ -n "$change_id" ]]; then
    for file in "$root/.harness/stages/$change_id"/*.md; do
      [[ -f "$file" ]] && _harness_stem "$file"
    done
  fi
}

_harness_non_option_words_before_cursor() {
  local i word skip_next=0
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="${COMP_WORDS[i]}"
    if (( skip_next )); then
      skip_next=0
      continue
    fi
    case "$word" in
      --repo-root|--idea|--description|--title|--change-set-id|--related-issue|--uc|--host|--port|--session-id)
        skip_next=1
        ;;
      --*)
        ;;
      *)
        printf '%s\n' "$word"
        ;;
    esac
  done
}

_harness_options_for_command() {
  local cmd="$1" sub="$2"
  case "$cmd" in
    agent-context)
      [[ "$sub" == "init" ]] && printf '%s\n' "--description --force" || true
      ;;
    requirements-definition)
      printf '%s\n' "--title --idea --plan --preview --apply"
      ;;
    ubiquitous-language-definition|use-case-definition)
      printf '%s\n' "--plan --preview --apply"
      ;;
    event-storming|ddd-architecture-definition|technical-decisions|plan-writing|implementation)
      printf '%s\n' "--uc --plan --preview --apply"
      ;;
    ultrawork)
      printf '%s\n' "--title --change-set-id --related-issue --uc --force --plan --preview --apply"
      ;;
    evolution)
      [[ "$sub" == "propose" ]] && printf '%s\n' "--change-set --work-item --run-id" || true
      ;;
    ui-server) printf '%s\n' "--host --port" ;;
  esac
}

_harness() {
  _harness_is_launcher || return 124

  local cur prev commands global_options
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="init update agent-context changes contracts requirements-definition ubiquitous-language-definition use-case-definition event-storming ddd-architecture-definition technical-decisions plan-writing implementation ultrawork evolution stages artifacts resume report dashboard ui-server"
  global_options="--repo-root"

  case "$prev" in
    --repo-root)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
    --uc)
      _harness_compgen "$(_harness_use_case_ids)" "$cur"
      return 0
      ;;
    --change-set-id)
      _harness_compgen "$(_harness_change_ids)" "$cur"
      return 0
      ;;
    --title|--related-issue|--idea|--description|--host|--port|--session-id)
      return 0
      ;;
  esac

  local -a words
  mapfile -t words < <(_harness_non_option_words_before_cursor)
  local cmd="${words[0]:-}"
  local sub="${words[1]:-}"

  if [[ "$cur" == --* ]]; then
    _harness_compgen "$global_options $(_harness_options_for_command "$cmd" "$sub")" "$cur"
    return 0
  fi

  if [[ -z "$cmd" ]]; then
    _harness_compgen "$commands $global_options" "$cur"
    return 0
  fi

  case "$cmd" in
    changes)
      case "$sub" in
        "") _harness_compgen "list active show contents delete document-delta" "$cur" ;;
        show)
          [[ ${#words[@]} -le 2 ]] && _harness_compgen "$(_harness_change_ids)" "$cur"
          ;;
        delete)
          [[ ${#words[@]} -le 2 ]] && _harness_compgen "$(_harness_change_ids)" "$cur"
          ;;
      esac
      ;;
    agent-context)
      [[ -z "$sub" ]] && _harness_compgen "init" "$cur"
      ;;
    evolution)
      [[ -z "$sub" ]] && _harness_compgen "propose accept reject" "$cur"
      ;;
    requirements-definition|ubiquitous-language-definition|use-case-definition)
      if [[ ${#words[@]} -le 1 ]]; then
        _harness_compgen "$(_harness_change_ids)" "$cur"
      else
        _harness_compgen "--plan --preview --apply" "$cur"
      fi
      ;;
    event-storming|ddd-architecture-definition|technical-decisions|plan-writing|implementation)
      if [[ ${#words[@]} -le 1 ]]; then
        _harness_compgen "$(_harness_change_ids)" "$cur"
      elif [[ "$prev" == "--uc" ]]; then
        _harness_compgen "$(_harness_use_case_ids_for_change "${words[1]}")" "$cur"
      else
        _harness_compgen "--uc --plan --preview --apply" "$cur"
      fi
      ;;
    stages)
      if [[ -z "$sub" ]]; then
        _harness_compgen "list" "$cur"
      elif [[ "$sub" == "list" && ${#words[@]} -le 2 ]]; then
        _harness_compgen "$(_harness_change_ids)" "$cur"
      fi
      ;;
    artifacts)
      if [[ -z "$sub" ]]; then
        _harness_compgen "show accept" "$cur"
      elif [[ "$sub" == "show" || "$sub" == "accept" ]]; then
        if [[ ${#words[@]} -le 2 ]]; then
          _harness_compgen "$(_harness_change_ids)" "$cur"
        elif [[ ${#words[@]} -le 3 ]]; then
          _harness_compgen "$(_harness_stage_ids "${words[2]}")" "$cur"
        fi
      fi
      ;;
    resume|report)
      [[ ${#words[@]} -le 1 ]] && _harness_compgen "$(_harness_run_ids)" "$cur"
      ;;
  esac

  return 0
}

complete -o bashdefault -o default -F _harness harness ./harness

if [[ "${HARNESS_ENABLE_DEFAULT_COMPLETION:-}" == "1" ]]; then
  complete -o bashdefault -o default -D -F _harness
fi
