#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON="$ROOT_DIR/venv/bin/python3"

if [ ! -x "$PYTHON" ]; then
  echo "Missing repository venv: run 'python3 -m venv venv' first." >&2
  exit 1
fi

exec "$PYTHON" -m mkdocs build --strict --config-file "$ROOT_DIR/mkdocs.yml"
