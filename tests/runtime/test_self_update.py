import subprocess
from argparse import Namespace
from pathlib import Path

from harness_codex.runtime.self_update import build_parser, build_update_command, run_self_update


def test_build_update_command_defaults_to_force_target_and_ref(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, repo="https://github.com/omegafrog/harness-codex", ref="main")

    assert "curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh" in command
    assert "bash -s -- --force" in command
    assert f"--target {tmp_path}" in command
    assert "--ref main" in command


def test_build_update_command_supports_skip_venv(tmp_path: Path) -> None:
    command = build_update_command(tmp_path, ref="feature-x", skip_venv=True)

    assert "--ref feature-x" in command
    assert "--skip-venv" in command


def test_update_parser_accepts_branch_alias() -> None:
    args = build_parser().parse_args(["--branch", "codex/runtime-test", "--dry-run"])

    assert args.branch == "codex/runtime-test"
    assert args.ref is None
    assert args.dry_run is True


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
            ref="main",
            branch=None,
            skip_venv=True,
            dry_run=True,
        ),
        runner=runner,
    )

    assert called is False
    assert "Dry run. Command:" in output
    assert "Selected harness-codex ref: main" in output
    assert "--skip-venv" in output
    assert "may overwrite" in output


def test_run_self_update_uses_branch_alias_for_ref(tmp_path: Path) -> None:
    output = run_self_update(
        tmp_path,
        Namespace(
            repo="https://github.com/omegafrog/harness-codex",
            ref=None,
            branch="codex/runtime-test",
            skip_venv=True,
            dry_run=True,
        ),
    )

    assert "Selected harness-codex ref: codex/runtime-test" in output
    assert "https://raw.githubusercontent.com/omegafrog/harness-codex/codex/runtime-test/scripts/install-harness-codex.sh" in output
    assert "--ref codex/runtime-test" in output


def test_run_self_update_rejects_ref_and_branch_together(tmp_path: Path) -> None:
    try:
        run_self_update(
            tmp_path,
            Namespace(
                repo="https://github.com/omegafrog/harness-codex",
                ref="main",
                branch="codex/runtime-test",
                skip_venv=False,
                dry_run=True,
            ),
        )
    except ValueError as exc:
        assert "use either --ref or --branch" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_run_self_update_executes_installer_command(tmp_path: Path) -> None:
    calls = []

    def runner(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="installed", stderr="")

    output = run_self_update(
        tmp_path,
        Namespace(
            repo="https://github.com/omegafrog/harness-codex",
            ref="main",
            branch=None,
            skip_venv=True,
            dry_run=False,
        ),
        runner=runner,
    )

    assert calls
    command = calls[0][0][0]
    assert "--force" in command
    assert f"--target {tmp_path}" in command
    assert calls[0][1]["cwd"] == tmp_path
    assert calls[0][1]["shell"] is True
    assert "Selected harness-codex ref: main" in output
    assert output.endswith("harness-codex update completed.")


def test_run_self_update_reports_failed_installer(tmp_path: Path) -> None:
    def runner(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=1, stdout="", stderr="boom")

    try:
        run_self_update(
            tmp_path,
            Namespace(
                repo="https://github.com/omegafrog/harness-codex",
                ref="main",
                branch=None,
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
