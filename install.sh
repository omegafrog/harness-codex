#!/usr/bin/env bash
set -euo pipefail

HARNESS_REPO="${HARNESS_CODEX_REPO:-https://github.com/omegafrog/harness-codex}"
HARNESS_REF="${HARNESS_CODEX_REF:-main}"
DESCRIPTION="${HARNESS_CODEX_DESCRIPTION:-Existing project reverse-engineered by harness bootstrap}"

usage() {
  cat <<'USAGE'
Usage: install.sh /path/to/target-repository [--force]

Installs harness-codex runtime, then reverse-engineers documentation from the
existing codebase. Bootstrap never implements product code.

Environment:
  HARNESS_CODEX_REPO         Repository URL
  HARNESS_CODEX_REF          Branch, tag, or commit
  HARNESS_CODEX_DESCRIPTION  Target project description
USAGE
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

TARGET_DIR="$1"
shift

INSTALLER_ARGS=()
RUNTIME_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      INSTALLER_ARGS+=("--force")
      shift
      ;;
    --runtime-only)
      RUNTIME_ONLY=true
      shift
      ;;
    --skip-venv)
      INSTALLER_ARGS+=("--skip-venv")
      shift
      ;;
    *)
      echo "Unsupported option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Target repository does not exist: $TARGET_DIR" >&2
  exit 1
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SOURCE_DIR="$TMP_DIR/harness-codex"
echo "Harness source를 가져오는 중: $HARNESS_REPO@$HARNESS_REF"
git init -q "$SOURCE_DIR"
git -C "$SOURCE_DIR" remote add origin "$HARNESS_REPO"
git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$HARNESS_REF"
git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD

HARNESS_CODEX_REPO="$HARNESS_REPO" HARNESS_CODEX_REF="$HARNESS_REF" \
  bash "$SOURCE_DIR/scripts/install-harness-codex.sh" \
  --runtime \
  --target "$TARGET_DIR" \
  "${INSTALLER_ARGS[@]}"

if [[ "$RUNTIME_ONLY" == "true" ]]; then
  echo "harness-codex runtime updated: $TARGET_DIR"
  exit 0
fi

echo "Reverse-engineering workflow documentation from existing codebase"
"$TARGET_DIR/harness" init --description "$DESCRIPTION" --no-llm

echo "harness-codex installed: $TARGET_DIR"
