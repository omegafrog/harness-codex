from __future__ import annotations

import sqlite3
from collections import deque
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
from harness_codex.runtime.workflow_routing import BlockCode, WorkflowRoutingPolicy
from harness_codex.runtime.xml_handoff import write_handoff


class _Runner:
    def __init__(self, result: StepResult) -> None:
        self._result = result

    def run(self, step: Step, context: RunContext) -> StepResult:
        return self._result


class _StepSequenceRunner:
    def __init__(self, results_by_step_id: dict[str, list[StepResult]]) -> None:
        self._results_by_step_id = {
            step_id: deque(results)
            for step_id, results in results_by_step_id.items()
        }
        self.calls: list[tuple[str, int]] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        retry_count = int(context.metadata.get("runtime_retry_count") or 0)
        self.calls.append((step.id, retry_count))
        results = self._results_by_step_id.get(step.id)
        if not results:
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        return results.popleft()


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


def _workflow_with_execute_and_verify() -> Workflow:
    return Workflow(
        name="workflow-test",
        mode=RunMode.APPLY,
        steps=(
            Step(id="execute-work-item", kind=StepKind.AGENT, name="execute"),
            Step(
                id="verify-work-item",
                kind=StepKind.VALIDATOR,
                name="verify",
                needs=("execute-work-item",),
            ),
        ),
    )


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


def test_engine_routes_failed_verification_back_to_execute_work_item(tmp_path: Path) -> None:
    runner = _StepSequenceRunner(
        {
            "execute-work-item": [
                StepResult(step_id="execute-work-item", status=StepStatus.SUCCEEDED),
                StepResult(step_id="execute-work-item", status=StepStatus.SUCCEEDED),
            ],
            "verify-work-item": [
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.FAILED,
                    error="tests failed",
                    metadata={"block_code": BlockCode.TEST_FAILED.value},
                ),
                StepResult(step_id="verify-work-item", status=StepStatus.SUCCEEDED),
            ],
        }
    )
    engine = RunnerEngine(runner)

    result = engine.run(_workflow_with_execute_and_verify(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert [step_id for step_id, _ in runner.calls] == [
        "execute-work-item",
        "verify-work-item",
        "execute-work-item",
        "verify-work-item",
    ]
    failed_verify = result.step_results[1]
    assert failed_verify.metadata["route_decision"]["action"] == "route"
    assert failed_verify.metadata["route_decision"]["target_step"] == "execute-work-item"
    assert result.metadata["route_decisions"][0]["target_step"] == "execute-work-item"


def test_engine_stops_when_routing_retry_budget_is_exceeded(tmp_path: Path) -> None:
    runner = _StepSequenceRunner(
        {
            "execute-work-item": [
                StepResult(step_id="execute-work-item", status=StepStatus.SUCCEEDED),
                StepResult(step_id="execute-work-item", status=StepStatus.SUCCEEDED),
            ],
            "verify-work-item": [
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.FAILED,
                    error="tests failed",
                    metadata={"block_code": BlockCode.TEST_FAILED},
                ),
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.FAILED,
                    error="tests still failed",
                    metadata={"block_code": BlockCode.TEST_FAILED},
                ),
            ],
        }
    )
    engine = RunnerEngine(
        runner,
        workflow_routing_policy=WorkflowRoutingPolicy(retry_budget=1),
    )

    result = engine.run(_workflow_with_execute_and_verify(), _context(tmp_path))

    assert result.status is RunStatus.FAILED
    assert result.retry_count == 1
    assert result.step_results[-1].metadata["route_decision"]["action"] == "stop_fatal"
    assert result.metadata["route_decisions"][-1]["action"] == "stop_fatal"


def test_engine_pauses_when_route_policy_requires_user_decision(tmp_path: Path) -> None:
    step = Step(id="promote-design-delta", kind=StepKind.RECORD, name="promote")
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(
        _Runner(
            StepResult(
                step_id="promote-design-delta",
                status=StepStatus.BLOCKED,
                error="canonical conflict requires a product decision",
                metadata={"block_code": BlockCode.USER_DECISION_REQUIRED},
            )
        )
    )

    result = engine.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.step_results[0].metadata["route_decision"]["action"] == "pause"
    assert result.metadata["route_decisions"][0]["action"] == "pause"


def test_engine_routes_security_review_failure_to_implementation_repair(tmp_path: Path) -> None:
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
    assert result.step_results[0].metadata["runtime_failure_class"] == "security_review_failure"
    assert (
        result.step_results[0].metadata["security_review_verdict_path"]
        == ".harness/runs/run-test/work-items/UC-001/security/security-review.xml"
    )


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
