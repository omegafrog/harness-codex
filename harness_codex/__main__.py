"""Run the public harness command."""

from __future__ import annotations

import sys
from pathlib import Path

from harness_codex.canonical_cli import main as public_main
from harness_codex.runtime.reset import main as reset_main
from harness_codex.runtime.self_update import main as update_main


if len(sys.argv) > 1 and sys.argv[1] == "update":
    raise SystemExit(update_main(sys.argv[2:], repo_root=Path.cwd()))

if len(sys.argv) > 1 and sys.argv[1] == "reset":
    raise SystemExit(reset_main(sys.argv[2:], repo_root=Path.cwd()))

raise SystemExit(public_main())
