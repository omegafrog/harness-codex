"""Executable-startup migration helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence


def migrate_runtime_artifacts(arguments: Sequence[str]) -> None:
    """Migrate retired state formats before serving any command or dashboard."""

    from harness_codex.runtime.dashboard_legacy_migration import migrate_legacy_dashboard_sessions
    from harness_codex.runtime.state_projection import migrate_legacy_runtime_state

    root = _repo_root_from_arguments(arguments)
    migrate_legacy_dashboard_sessions(root)
    migrate_legacy_runtime_state(root)


def _repo_root_from_arguments(arguments: Sequence[str]) -> Path:
    values = list(arguments)
    for index, value in enumerate(values):
        if value == "--repo-root" and index + 1 < len(values):
            return Path(values[index + 1])
        if value.startswith("--repo-root="):
            return Path(value.split("=", maxsplit=1)[1])
    return Path(".")
