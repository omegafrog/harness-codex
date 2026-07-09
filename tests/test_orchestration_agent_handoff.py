from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-test",
        workflow_name="workflow-test",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness" / "runs" / "run-test",
        metadata={"change_set_id": "CHG-001", "active_work_item_id": "UC-001"},
    )


def _handoff_workflow() -> Workflow:
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
            Step(
                id="orchestrate-blocker",
                kind=StepKind.AGENT,
                name="orchestrate blocker",
                needs=("verify-work-item",),
                agent_id="workflow_orchestrator",
                skill_id="harness-workflow-orchestrator",
                outputs=(
                    Path(
                        ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/orchestration/orchestration-decision.xml"
                    ),
                ),
                metadata={
                    "runtime_handoff_only": True,
                    "orchestration_decision_path": ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/orchestration/orchestration-decision.xml",
                },
            ),
        ),
    )


class _HappyPathRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        del context
        self.calls.append(step.id)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


class _XmlHandoffRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.verify_calls = 0

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.calls.append(step.id)
        if step.id == "verify-work-item":
            self.verify_calls += 1
            if self.verify_calls == 1:
                return StepResult(
                    step_id=step.id,
                    status=StepStatus.FAILED,
                    error="tests failed",
                    metadata={"block_code": "PROJECT_SPECIFIC_TEST_BLOCK"},
                )
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        if step.id == "orchestrate-blocker":
            path = (
                context.repo_root
                / ".harness"
                / "runs"
                / context.run_id
                / "work-items"
                / str(context.metadata["active_work_item_id"])
                / "orchestration"
                / "orchestration-decision.xml"
            )
            write_handoff(
                path,
                "orchestration-decision",
                {
                    "schema_version": 1,
                    "status": "route",
                    "target_step": "execute-work-item",
                    "failed_step_id": str(context.metadata.get("runtime_failed_step_id") or ""),
                    "failure_kind": str(context.metadata.get("runtime_failure_kind") or ""),
                    "reason": "retry implementation after failed verification",
                    "retry_allowed": True,
                },
            )
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_orchestration_decision_xml_contract_requires_route_target(tmp_path: Path) -> None:
    path = tmp_path / "decision.xml"

    write_handoff(
        path,
        "orchestration-decision",
        {
            "schema_version": 1,
            "status": "route",
            "target_step": "execute-work-item",
            "failed_step_id": "verify-work-item",
            "failure_kind": "implementation",
            "reason": "verification failed",
            "retry_allowed": True,
        },
    )

    assert read_handoff(path, expected_type="orchestration-decision")["target_step"] == "execute-work-item"

    with pytest.raises(ValueError, match="target_step is required"):
        write_handoff(
            tmp_path / "invalid.xml",
            "orchestration-decision",
            {
                "schema_version": 1,
                "status": "route",
                "target_step": "",
                "failed_step_id": "verify-work-item",
                "failure_kind": "implementation",
                "reason": "verification failed",
                "retry_allowed": True,
            },
        )


def test_runtime_handoff_only_agent_is_skipped_on_happy_path(tmp_path: Path) -> None:
    runner = _HappyPathRunner()
    engine = RunnerEngine(runner)

    result = engine.run(_handoff_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls == ["execute-work-item", "verify-work-item"]


def test_engine_routes_unresolved_blocker_through_xml_orchestration_agent(tmp_path: Path) -> None:
    runner = _XmlHandoffRunner()
    engine = RunnerEngine(runner)

    result = engine.run(_handoff_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert runner.calls == [
        "execute-work-item",
        "verify-work-item",
        "orchestrate-blocker",
        "execute-work-item",
        "verify-work-item",
    ]
    assert result.step_results[1].metadata["route_decision"]["action"] == "handoff"
