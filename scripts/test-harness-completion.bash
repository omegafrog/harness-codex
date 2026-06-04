#!/usr/bin/env bash
set -euo pipefail

repo_root="$(mktemp -d)"
trap 'rm -rf "$repo_root"' EXIT

mkdir -p "$repo_root/docs/changes/active" "$repo_root/docs/use-cases/UC-001"
cat > "$repo_root/docs/changes/active/CHG-20260520-001.md" <<'CHANGESET'
# ChangeSet CHG-20260520-001

| UC ID | Name |
| --- | --- |
| `UC-001` | Sample use case |
CHANGESET

# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/harness-completion.bash"

run_completion() {
  COMP_WORDS=("$@")
  COMP_CWORD=$((${#COMP_WORDS[@]} - 1))
  COMPREPLY=()
  _harness
  printf '%s\n' "${COMPREPLY[@]}"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if ! grep -Fxq "$needle" <<< "$haystack"; then
    printf 'expected completion candidate not found: %s\n' "$needle" >&2
    printf 'actual candidates:\n%s\n' "$haystack" >&2
    exit 1
  fi
}

change_candidates_empty="$(run_completion harness --repo-root "$repo_root" event-storming "")"
assert_contains "$change_candidates_empty" "CHG-20260520-001"

change_candidates_prefix="$(run_completion harness --repo-root "$repo_root" event-storming CHG-)"
assert_contains "$change_candidates_prefix" "CHG-20260520-001"

uc_candidates="$(run_completion harness --repo-root "$repo_root" event-storming CHG-20260520-001 --uc UC-)"
assert_contains "$uc_candidates" "UC-001"

local_launcher_candidates_empty="$(run_completion ./harness --repo-root "$repo_root" event-storming "")"
assert_contains "$local_launcher_candidates_empty" "CHG-20260520-001"

local_launcher_candidates_prefix="$(run_completion ./harness --repo-root "$repo_root" event-storming CHG-)"
assert_contains "$local_launcher_candidates_prefix" "CHG-20260520-001"

printf 'completion smoke test passed\n'
