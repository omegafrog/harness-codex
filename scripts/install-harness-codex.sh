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
for path in harness_codex completions .codex harness; do
  rm -rf "$TARGET_DIR/$path"
  cp -a "$SOURCE_DIR/$path" "$TARGET_DIR/$path"
done
rm -rf "$TARGET_DIR/.harness/runtime" "$TARGET_DIR/.harness/workflows"
echo "installed: Codex skills and harness utility source"
