"""Run the public harness command."""

from __future__ import annotations

from harness_codex.bootstrap import configure_runtime

configure_runtime()

from harness_codex.canonical_cli import main as public_main

raise SystemExit(public_main())
