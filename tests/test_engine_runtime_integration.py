from __future__ import annotations

import sqlite3
from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)


class _Runner:
    def __init__(self, result: StepResult) -> None:
        self._result = result

    def run(self, step: Step, context: RunContext) -> StepResult:
        return self._result


def _context(tmp_path: Path, *, metadata: dict[str, object] | None = None) -> RunContext:
    return RunContext(
        run_id="run-test",
        workflow_name="workflow-test",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness" / "runs" / "run-test",
        metadata=metadata or {"change_set_id": "CHG-001", "active_work_item_id": "UC-001"},
    )


def _ledger_state(tmp_path: Path) -> str:
    path = tmp_path / ".harness" / "runs" / "run-test" / "state.sqlite3"
    with sqlite3.connect(path) as connection:
        return str(connection.execute("SELECT state FROM step_transactions").fetchone()[0])


def test_engine_records_executed_step_without_import_time_patch(tmp_path: Path) -> None:
    step = Step(id="record", kind=StepKind.RECORD, name="record")
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(_Runner(StepResult(step_id="record", status=StepStatus.SUCCEEDED)))

    result = engine.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert _ledger_state(tmp_path) == "COMMITTED"


def test_engine_records_skipped_work_item_step(tmp_path: Path) -> None:
    step = Step(
        id="plan-work-item",
        kind=StepKind.RECORD,
        name="plan",
        metadata={"scope": "work_item"},
    )
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(_Runner(StepResult(step_id="plan-work-item", status=StepStatus.SUCCEEDED)))

    result = engine.run(
        workflow,
        _context(tmp_path, metadata={"run_ready_work_item_completion_only": True}),
    )

    assert result.status is RunStatus.SUCCEEDED
    assert result.step_results[0].status is StepStatus.SKIPPED
    assert _ledger_state(tmp_path) == "SKIPPED"


def test_engine_routes_security_review_failure_to_implementation_repair(tmp_path: Path) -> None:
    step = Step(
        id="verify-work-item-security",
        kind=StepKind.VALIDATOR,
        name="security review",
    )
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(
        _Runner(
            StepResult(
                step_id="verify-work-item-security",
                status=StepStatus.FAILED,
                error="security review rejected",
            )
        )
    )

    result = engine.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.FAILED
    assert result.failure_kind is FailureKind.IMPLEMENTATION
    assert result.step_results[0].metadata["runtime_failure_class"] == "security_review_failure"
