"""Run the public harness command."""

from __future__ import annotations

from harness_codex.bootstrap import configure_runtime
from harness_codex.entrypoint import main

configure_runtime()

raise SystemExit(main())
