"""Public command entrypoint without runtime-owned session orchestration."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

from harness_codex import canonical_cli
from harness_codex.runtime.dashboard_runtime_state import initialize_missing_canonical_states
from harness_codex.runtime.state_projection import refresh_canonical_runtime_state


def main(argv: Sequence[str] | None = None) -> int:
    """Run the public command surface without ChangeSet session orchestration."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    root = _repo_root_from_arguments(arguments)
    if any(argument in {"orchestrate", "resume"} for argument in arguments):
        initialize_missing_canonical_states(root)
    refresh_canonical_runtime_state(root)
    return canonical_cli.main(arguments)


def _repo_root_from_arguments(arguments: Sequence[str]) -> Path:
    values = list(arguments)
    for index, value in enumerate(values):
        if value == "--repo-root" and index + 1 < len(values):
            return Path(values[index + 1])
        if value.startswith("--repo-root="):
            return Path(value.split("=", maxsplit=1)[1])
    return Path(".")
