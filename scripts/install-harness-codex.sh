#!/usr/bin/env bash
set -euo pipefail

HARNESS_REPO="${HARNESS_CODEX_REPO:-https://github.com/omegafrog/harness-codex}"
HARNESS_REF="${HARNESS_CODEX_REF:-main}"
TARGET_DIR="${HARNESS_CODEX_TARGET:-$PWD}"
FORCE=0
SKIP_VENV=0

usage() {
  cat <<'USAGE'
Install harness-codex runtime files into the current project.

Usage:
  bash scripts/install-harness-codex.sh [--force] [--skip-venv] [--ref <git-ref>] [--target <dir>]

Environment:
  HARNESS_CODEX_REPO    GitHub repository URL. Default: https://github.com/omegafrog/harness-codex
  HARNESS_CODEX_REF     Branch, tag, or commit to download. Default: main
  HARNESS_CODEX_TARGET  Target project directory. Default: current directory

Examples:
  curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash
  curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --force
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --skip-venv)
      SKIP_VENV=1
      shift
      ;;
    --ref)
      HARNESS_REF="${2:?--ref requires a value}"
      shift 2
      ;;
    --target)
      TARGET_DIR="${2:?--target requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_command curl
need_command tar
need_command python3

mkdir -p "$TARGET_DIR"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PRESERVE_DIR="$TMP_DIR/preserved"

# Files below are produced or edited by project workflows and must survive
# `harness update`, even though update refreshes .harness/ and .codex/ with --force.
PRESERVED_PATHS=(
  ".harness/runs"
  ".harness/sessions"
  ".harness/state"
  ".harness/checkpoints"
  ".harness/ui/grill-me-runs"
  "docs/changes"
  "docs/use-cases"
  "docs/maintenance"
  "docs/plans"
  "docs/design/요구사항.md"
  "docs/design/유스케이스.md"
  "context.md"
  ".codex/repository-settings.md"
  ".codex/stack-profile.yaml"
  ".codex/test-gate.yaml"
  "AGENTS.md"
)

backup_preserved_paths() {
  local rel src dst
  for rel in "${PRESERVED_PATHS[@]}"; do
    src="$TARGET_DIR/$rel"
    if [[ -e "$src" ]]; then
      dst="$PRESERVE_DIR/$rel"
      mkdir -p "$(dirname "$dst")"
      cp -a "$src" "$dst"
      echo "preserved: $rel"
    fi
  done
}

restore_paths() {
  local rel src dst
  for rel in "${PRESERVED_PATHS[@]}"; do
    src="$PRESERVE_DIR/$rel"
    if [[ -e "$src" ]]; then
      dst="$TARGET_DIR/$rel"
      rm -rf "$dst"
      mkdir -p "$(dirname "$dst")"
      cp -a "$src" "$dst"
      echo "restored: $rel"
    fi
  done
}

ARCHIVE_URL="$HARNESS_REPO/archive/${HARNESS_REF}.tar.gz"
echo "Downloading harness-codex from $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/harness-codex.tar.gz"
tar -xzf "$TMP_DIR/harness-codex.tar.gz" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'harness-codex-*' | head -n 1)"

if [[ -z "${SRC_DIR:-}" || ! -d "$SRC_DIR" ]]; then
  echo "Failed to locate extracted harness-codex source directory" >&2
  exit 1
fi

backup_preserved_paths

copy_dir() {
  local src="$1"
  local dst="$2"
  if [[ -e "$dst" && "$FORCE" -ne 1 ]]; then
    echo "skip existing: ${dst#$TARGET_DIR/}"
    return
  fi
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
  echo "installed: ${dst#$TARGET_DIR/}"
}

copy_file_if_missing() {
  local dst="$1"
  local content="$2"
  if [[ -e "$dst" ]]; then
    echo "skip existing: ${dst#$TARGET_DIR/}"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  printf '%s\n' "$content" > "$dst"
  echo "created: ${dst#$TARGET_DIR/}"
}

create_launcher() {
  local dst="$TARGET_DIR/harness"
  if [[ -e "$dst" && "$FORCE" -ne 1 ]]; then
    echo "skip existing: harness"
    return
  fi
  cat > "$dst" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$ROOT_DIR/venv/bin/python3" ]]; then
  PYTHON_BIN="$ROOT_DIR/venv/bin/python3"
else
  PYTHON_BIN="$(command -v python3)"
fi

cd "$ROOT_DIR"
PYTHONPATH="$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}" exec "$PYTHON_BIN" -m harness_codex "$@"
LAUNCHER
  chmod +x "$dst"
  echo "created: harness"
}

copy_dir "$SRC_DIR/harness_codex" "$TARGET_DIR/harness_codex"
copy_dir "$SRC_DIR/.harness" "$TARGET_DIR/.harness"
copy_dir "$SRC_DIR/.codex" "$TARGET_DIR/.codex"

mkdir -p "$TARGET_DIR/tests"
copy_dir "$SRC_DIR/tests/runtime" "$TARGET_DIR/tests/runtime"
create_launcher

mkdir -p \
  "$TARGET_DIR/docs/design" \
  "$TARGET_DIR/docs/changes/active" \
  "$TARGET_DIR/docs/changes/completed" \
  "$TARGET_DIR/docs/use-cases" \
  "$TARGET_DIR/docs/maintenance" \
  "$TARGET_DIR/docs/plans/active" \
  "$TARGET_DIR/docs/plans/completed"

copy_file_if_missing "$TARGET_DIR/ARCHITECTURE.md" '# Architecture

TBD
'

copy_file_if_missing "$TARGET_DIR/docs/design/요구사항.md" '# 요구사항

TBD
'

copy_file_if_missing "$TARGET_DIR/docs/design/유스케이스.md" '# 유스케이스

TBD
'

copy_file_if_missing "$TARGET_DIR/.codex/repository-settings.md" '# Repository Settings

## Test Command
./venv/bin/python3 -m pytest -q -s tests/runtime
'

copy_file_if_missing "$TARGET_DIR/.codex/test-gate.yaml" 'required:
  - name: runtime
    command: ./venv/bin/python3 -m pytest -q -s tests/runtime
'

restore_preserved_paths() { restore_paths "$@"; }
restore_preserved_paths

if [[ "$SKIP_VENV" -ne 1 ]]; then
  if [[ ! -d "$TARGET_DIR/venv" ]]; then
    echo "Creating Python venv"
    python3 -m venv "$TARGET_DIR/venv"
  else
    echo "skip existing: venv"
  fi
  "$TARGET_DIR/venv/bin/python3" -m pip install -U pip pytest pyyaml
else
  echo "Skipping venv setup"
fi

echo "Running harness CLI smoke test"
(
  cd "$TARGET_DIR"
  ./harness --help >/dev/null
)

cat <<EOF

harness-codex installed successfully.

Next commands:
  cd "$TARGET_DIR"
  ./harness agent-context init --description "New project managed by harness-codex runtime"
  ./harness changes create-from-design --title "initial runtime setup" --change-set-id CHG-$(date +%Y%m%d)-001
  ./harness run-change CHG-$(date +%Y%m%d)-001 --plan

EOF
