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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      INSTALLER_ARGS+=("--force")
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

INSTALLER_URL="$HARNESS_REPO/raw/$HARNESS_REF/scripts/install-harness-codex.sh"
echo "Downloading harness installer from $INSTALLER_URL"
curl -fsSL "$INSTALLER_URL" -o "$TMP_DIR/install-harness-codex.sh"

HARNESS_CODEX_REPO="$HARNESS_REPO" HARNESS_CODEX_REF="$HARNESS_REF" \
  bash "$TMP_DIR/install-harness-codex.sh" \
  --runtime \
  --target "$TARGET_DIR" \
  "${INSTALLER_ARGS[@]}"

echo "Reverse-engineering workflow documentation from existing codebase"
"$TARGET_DIR/harness" init --description "$DESCRIPTION"

echo "harness-codex installed: $TARGET_DIR"
