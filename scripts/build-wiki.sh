#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON="$ROOT_DIR/venv/bin/python3"

if [ ! -x "$PYTHON" ]; then
  echo "저장소 root venv가 없습니다. 먼저 'python3 -m venv venv'를 실행하세요." >&2
  exit 1
fi

exec "$PYTHON" -m mkdocs build --strict --config-file "$ROOT_DIR/mkdocs.yml"
