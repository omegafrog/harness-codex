from __future__ import annotations

import sys
from pathlib import Path

from harness_codex.runtime import BasicStepRunner, FailureKind, RunContext, RunMode, Step, StepKind, StepStatus


def _context(tmp_path: Path, *, approved: bool | None = None) -> RunContext:
    metadata = {} if approved is None else {"delivery_approved": approved}
    return RunContext(
        run_id="run-delivery",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-delivery",
        metadata=metadata,
    )


def _delivery_step(command: str) -> Step:
    return Step(
        id="create-change-set-pr",
        kind=StepKind.GIT,
        name="ChangeSet PR 전달",
        command=command,
        metadata={"approval_env": "HARNESS_DELIVERY_APPROVED"},
    )


def test_delivery_command_blocks_without_explicit_approval(tmp_path: Path) -> None:
    step_dir = tmp_path / "step"
    step_dir.mkdir()

    result = BasicStepRunner()._run_command(
        _delivery_step(f'{sys.executable} -c "raise SystemExit(0)"'),
        _context(tmp_path),
        step_dir,
    )

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.ENVIRONMENT_BLOCKER
    assert result.metadata["delivery_approved"] is False
    assert "explicit delivery approval" in (result.error or "")


def test_approved_delivery_command_receives_affirmative_environment(tmp_path: Path) -> None:
    step_dir = tmp_path / "step"
    step_dir.mkdir()
    command = (
        f'{sys.executable} -c "import os; '
        'raise SystemExit(0 if os.environ.get(\'HARNESS_DELIVERY_APPROVED\') == \'1\' else 1)"'
    )

    result = BasicStepRunner()._run_command(
        _delivery_step(command),
        _context(tmp_path, approved=True),
        step_dir,
    )

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["delivery_approved"] is True


def test_delivery_blocked_exit_code_is_not_reclassified_as_implementation_failure(tmp_path: Path) -> None:
    step_dir = tmp_path / "step"
    step_dir.mkdir()
    command = f'{sys.executable} -c "import sys; print(\'BLOCKED: push unavailable\', file=sys.stderr); raise SystemExit(2)"'

    result = BasicStepRunner()._run_command(
        _delivery_step(command),
        _context(tmp_path, approved=True),
        step_dir,
    )

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.ENVIRONMENT_BLOCKER
    assert result.error == "push unavailable"
