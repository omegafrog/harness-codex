import subprocess
from argparse import Namespace
from pathlib import Path

from harness_codex import __version__
from harness_codex.runtime.self_update import build_update_command, run_self_update


def test_build_update_command_defaults_to_origin_main_download_ref(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex")

    assert "curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh" in command
    assert "bash -s -- --force" in command
    assert f"--target {tmp_path}" in command
    assert "--ref main" in command


def test_build_update_command_normalizes_origin_ref_for_github_download(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, ref="origin/feature-x", skip_venv=True)

    assert "origin/feature-x" not in command
    assert "--ref feature-x" in command
    assert "--skip-venv" in command


def test_run_self_update_dry_run_does_not_call_runner(tmp_path: Path) -> None:
    called = False

    def runner(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("runner should not be called")

    output = run_self_update(
        tmp_path,
        Namespace(
            repo="https://github.com/omegafrog/harness-codex",
            ref="origin/main",
            skip_venv=True,
            dry_run=True,
        ),
        runner=runner,
    )

    assert called is False
    assert "Update source: https://github.com/omegafrog/harness-codex@origin/main" in output
    assert "download ref: main" in output
    assert "Dry run. Command:" in output
    assert "--skip-venv" in output
    assert "preserves workflow-generated artifacts" in output
    assert f"Installed runtime version: {__version__}" in output


def test_run_self_update_executes_installer_command(tmp_path: Path) -> None:
    calls = []
    runtime_package = tmp_path / "harness_codex"
    runtime_package.mkdir()
    (runtime_package / "__init__.py").write_text('__version__ = "0.1.0"\n', encoding="utf-8")

    def runner(*args, **kwargs):
        calls.append((args, kwargs))
        (runtime_package / "__init__.py").write_text('__version__ = "0.1.1"\n', encoding="utf-8")
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="installed", stderr="")

    output = run_self_update(
        tmp_path,
        Namespace(
            repo="https://github.com/omegafrog/harness-codex",
            ref="origin/main",
            skip_venv=True,
            dry_run=False,
        ),
        runner=runner,
    )

    assert calls
    command = calls[0][0][0]
    assert "--force" in command
    assert f"--target {tmp_path}" in command
    assert "--ref main" in command
    assert calls[0][1]["cwd"] == tmp_path
    assert calls[0][1]["shell"] is True
    assert "Runtime version: 0.1.0 -> 0.1.1" in output
    assert output.endswith("harness-codex update completed.")


def test_run_self_update_reports_failed_installer(tmp_path: Path) -> None:
    def runner(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=1, stdout="", stderr="boom")

    try:
        run_self_update(
            tmp_path,
            Namespace(
                repo="https://github.com/omegafrog/harness-codex",
                ref="origin/main",
                skip_venv=False,
                dry_run=False,
            ),
            runner=runner,
        )
    except ValueError as exc:
        assert "harness update failed" in str(exc)
        assert "boom" in str(exc)
    else:
        raise AssertionError("expected ValueError")
