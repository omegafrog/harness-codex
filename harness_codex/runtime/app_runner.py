"""Run the repository-local application launcher contract."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Sequence


APP_RUN_SCRIPT = Path("scripts/run-app.sh")


def run_app(repo_root: Path | str, args: Sequence[str] = ()) -> int:
    """Execute the versioned application launcher from the repository root."""

    root = Path(repo_root).resolve()
    script = root / APP_RUN_SCRIPT
    if not script.is_file():
        raise ValueError(
            f"app run script not found: {APP_RUN_SCRIPT}. "
            "Create it during implementation and keep local infrastructure "
            "such as compose.yaml under version control."
        )
    try:
        completed = subprocess.run(
            ["bash", str(script), *args],
            cwd=root,
            check=False,
        )
    except KeyboardInterrupt:
        return 130
    return completed.returncode
