from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.local_step_runner import LocalStepRunner
from harness_codex.runtime.models import FailureKind, RunContext, RunMode, Step, StepKind, StepResult, StepStatus


class _Delegate:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.seen.append(step.id)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-test",
        workflow_name="workflow-test",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness" / "runs" / "run-test",
    )


def test_local_step_runner_blocks_decision_steps_without_delegate(tmp_path: Path) -> None:
    delegate = _Delegate()
    runner = LocalStepRunner(delegate)

    result = runner.run(Step(id="route", kind=StepKind.DECISION, name="route"), _context(tmp_path))

    assert result.status is StepStatus.BLOCKED
    assert result.failure_kind is FailureKind.ENVIRONMENT_BLOCKER
    assert result.metadata == {
        "runtime_contract": "decision-step-not-executed",
        "orchestration_owner": "orchestration-agent",
    }
    assert delegate.seen == []


def test_local_step_runner_delegates_local_execution_steps(tmp_path: Path) -> None:
    delegate = _Delegate()
    runner = LocalStepRunner(delegate)

    result = runner.run(Step(id="record", kind=StepKind.RECORD, name="record"), _context(tmp_path))

    assert result.status is StepStatus.SUCCEEDED
    assert delegate.seen == ["record"]
