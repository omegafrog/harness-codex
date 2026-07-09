from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)
from harness_codex.runtime.selected_step_runtime import SelectedStepRuntimeExecutor


class _RecordingRunner:
    def __init__(self) -> None:
        self.seen: list[tuple[str, tuple[str, ...]]] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.seen.append((step.id, tuple(step.needs)))
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-test",
        workflow_name="orchestrated-selected-step",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness" / "runs" / "run-test",
    )


def test_selected_step_runtime_executes_one_orchestrator_selected_step(tmp_path: Path) -> None:
    runner = _RecordingRunner()
    executor = SelectedStepRuntimeExecutor(RunnerEngine(runner))
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="execute",
        needs=("plan-work-item",),
    )

    result = executor.execute_selected_step(step, _context(tmp_path))

    assert result.status is StepStatus.SUCCEEDED
    assert result.step_id == "execute-work-item"
    assert runner.seen == [("execute-work-item", ())]


def test_selected_step_runtime_returns_decision_blocker_without_delegate(tmp_path: Path) -> None:
    runner = _RecordingRunner()
    executor = SelectedStepRuntimeExecutor(RunnerEngine(runner))

    result = executor.execute_selected_step(
        Step(id="route-failure", kind=StepKind.DECISION, name="route"),
        _context(tmp_path),
    )

    assert result.status is StepStatus.BLOCKED
    assert result.failure_kind is FailureKind.ENVIRONMENT_BLOCKER
    assert result.metadata == {
        "runtime_contract": "decision-step-not-executed",
        "orchestration_owner": "orchestration-agent",
    }
    assert runner.seen == []
