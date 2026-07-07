from __future__ import annotations

import subprocess
import sys


def _run(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", code],
        text=True,
        capture_output=True,
        check=False,
    )


def test_importing_cli_does_not_install_changeset_boundary() -> None:
    completed = _run(
        "import harness_codex.cli as cli; "
        "assert not getattr(cli, '_changeset_execution_boundary_installed', False)"
    )

    assert completed.returncode == 0, completed.stderr


def test_explicit_bootstrap_installs_changeset_boundary() -> None:
    completed = _run(
        "from harness_codex.bootstrap import configure_runtime; "
        "configure_runtime(); "
        "import harness_codex.cli as cli; "
        "assert getattr(cli, '_changeset_execution_boundary_installed', False)"
    )

    assert completed.returncode == 0, completed.stderr
