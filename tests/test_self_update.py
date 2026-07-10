from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from harness_codex.runtime.self_update import run_self_update


class _Runner:
    def __init__(self) -> None:
        self.commands: list[object] = []

    def __call__(self, command, **kwargs) -> subprocess.CompletedProcess[str]:
        self.commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="installed", stderr="")


def _completion_installer(repo_root: Path):
    return ()


def test_self_update_does_not_run_repository_patch_installer(tmp_path: Path) -> None:
    args = argparse.Namespace(
        repo="https://github.com/omegafrog/harness-codex",
        ref="origin/main",
        skip_venv=True,
        dry_run=False,
    )
    runner = _Runner()

    output = run_self_update(
        tmp_path,
        args,
        runner=runner,
        completion_installer=_completion_installer,
    )

    assert "harness-codex update completed" in output
    assert len(runner.commands) == 1
    command_text = " ".join(runner.commands[0]) if isinstance(runner.commands[0], list) else str(runner.commands[0])
    assert "repository_patches" not in command_text
    assert "patch" not in output.lower()
