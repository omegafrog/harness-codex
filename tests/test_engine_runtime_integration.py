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
from harness_codex.runtime.xml_handoff import write_handoff


class _Runner:
    def __init__(self, result: StepResult) -> None:
        self._result = result

    def run(self, step: Step, context: RunContext) -> StepResult:
        return self._result


class _RecordingRunner:
    def __init__(self, results: dict[str, StepResult]) -> None:
        self._results = results
        self.seen: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.seen.append(step.id)
        return self._results.get(
            step.id,
            StepResult(step_id=step.id, status=StepStatus.SUCCEEDED),
        )


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


def test_engine_returns_security_review_failure_without_routing_repair(tmp_path: Path) -> None:
    verdict_path = (
        tmp_path
        / ".harness"
        / "runs"
        / "run-test"
        / "work-items"
        / "UC-001"
        / "security"
        / "security-review.xml"
    )
    write_handoff(
        verdict_path,
        "gate-verdict",
        {
            "schema_version": 1,
            "gate_id": "security-review",
            "status": "rejected",
            "source_path": ".harness/runs/run-test/work-items/UC-001/security/security-review.md",
        },
    )
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
    assert result.retry_count == 0
    assert result.step_results[0].metadata["runtime_failure_class"] == "security_review_failure"
    assert (
        result.step_results[0].metadata["security_review_verdict_path"]
        == ".harness/runs/run-test/work-items/UC-001/security/security-review.xml"
    )


def test_engine_does_not_execute_remediation_or_loop_target_on_failure(tmp_path: Path) -> None:
    workflow = Workflow(
        name="workflow-test",
        mode=RunMode.APPLY,
        steps=(
            Step(id="execute-work-item", kind=StepKind.AGENT, name="execute"),
            Step(
                id="prepare-plan-repair",
                kind=StepKind.AGENT,
                name="repair",
                needs=("execute-work-item",),
                metadata={"runtime_role": "failure_router", "loop_target": "plan-work-item"},
            ),
            Step(
                id="plan-work-item",
                kind=StepKind.AGENT,
                name="plan",
                needs=("prepare-plan-repair",),
            ),
        ),
    )
    runner = _RecordingRunner(
        {
            "execute-work-item": StepResult(
                step_id="execute-work-item",
                status=StepStatus.FAILED,
                error="implementation failed",
                failure_kind=FailureKind.IMPLEMENTATION,
            )
        }
    )

    result = RunnerEngine(runner).run(workflow, _context(tmp_path))

    assert result.status is RunStatus.FAILED
    assert result.failed_step_id == "execute-work-item"
    assert result.retry_count == 0
    assert runner.seen == ["execute-work-item"]
    assert [item.step_id for item in result.step_results] == ["execute-work-item"]


def test_engine_blocks_security_review_failure_without_xml_verdict(tmp_path: Path) -> None:
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

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.ENVIRONMENT_BLOCKER
    assert "canonical security review XML is missing or invalid" in str(result.blocker)
