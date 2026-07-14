#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HARNESS_CODEX_TARGET:-$PWD}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET_DIR="$2"; shift 2 ;;
    --target=*) TARGET_DIR="${1#*=}"; shift ;;
    --force|--runtime|--skip-venv) shift ;;
    --skills-only) echo "skills-only mode is no longer separate; Codex skills and utility source install together."; shift ;;
    --ref) shift 2 ;;
    --ref=*) shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
REQUIRED_PATHS=(harness_codex completions .codex harness)
for path in "${REQUIRED_PATHS[@]}"; do
  if [[ ! -e "$SOURCE_DIR/$path" ]]; then
    echo "설치 source에 필수 파일이 없습니다: $SOURCE_DIR/$path" >&2
    exit 1
  fi
done

for path in "${REQUIRED_PATHS[@]}"; do
  rm -rf "$TARGET_DIR/$path"
  cp -a "$SOURCE_DIR/$path" "$TARGET_DIR/$path"
done
rm -rf "$TARGET_DIR/.harness/runtime" "$TARGET_DIR/.harness/workflows"

if [[ ! -x "$TARGET_DIR/harness" || ! -d "$TARGET_DIR/harness_codex" || ! -d "$TARGET_DIR/completions" || ! -f "$TARGET_DIR/.codex/workflow/token-estimation.md" ]]; then
  echo "harness 설치 검증에 실패했습니다." >&2
  exit 1
fi

if [[ -x "$TARGET_DIR/venv/bin/python3" ]]; then
  PYTHON_BIN="$TARGET_DIR/venv/bin/python3"
else
  PYTHON_BIN="$(command -v python3)"
fi

(cd "$TARGET_DIR" && PYTHONPATH="$TARGET_DIR" "$PYTHON_BIN" -c 'import harness_codex')
echo "harness runtime·skills 설치 완료"
