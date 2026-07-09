from __future__ import annotations

from pathlib import Path

import pytest

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
from harness_codex.runtime.workflow_orchestrator import WorkflowOrchestrator
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


def _workflow() -> Workflow:
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


def _decision_path(context: RunContext) -> Path:
    return (
        context.repo_root
        / ".harness"
        / "runs"
        / context.run_id
        / "work-items"
        / str(context.metadata["active_work_item_id"])
        / "orchestration"
        / "orchestration-decision.xml"
    )


def _write_decision(context: RunContext, *, target_step: str) -> None:
    write_handoff(
        _decision_path(context),
        "orchestration-decision",
        {
            "schema_version": 1,
            "status": "route",
            "target_step": target_step,
            "failed_step_id": str(context.metadata.get("runtime_failed_step_id") or ""),
            "failure_kind": str(context.metadata.get("runtime_failure_kind") or ""),
            "reason": f"route to {target_step}",
            "retry_allowed": True,
        },
    )


class _HappyPathRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        del context
        self.calls.append(step.id)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


class _XmlDecisionRunner:
    def __init__(self, *, target_step: str = "execute-work-item") -> None:
        self.calls: list[str] = []
        self.verify_calls = 0
        self.target_step = target_step

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
        if step.id == "workflow-orchestrator":
            _write_decision(context, target_step=self.target_step)
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


class _RemediationDecisionRunner:
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
                    error="implementation failed verification",
                    failure_kind=FailureKind.IMPLEMENTATION,
                )
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        if step.id == "workflow-orchestrator":
            _write_decision(context, target_step="prepare-plan-repair")
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        if step.id == "prepare-plan-repair":
            assert context.metadata["runtime_partial_repair"] is True
            assert context.metadata["runtime_resume_boundary_step_id"] == "execute-work-item"
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


def test_contaminated_orchestration_decision_xml_is_recovered(tmp_path: Path) -> None:
    path = tmp_path / "contaminated.xml"
    clean = tmp_path / "clean.xml"
    write_handoff(
        clean,
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
    path.write_text(
        "```xml\n" + clean.read_text(encoding="utf-8") + "\n```\nextra explanation",
        encoding="utf-8",
    )

    payload = read_handoff(path, expected_type="orchestration-decision")

    assert payload["target_step"] == "execute-work-item"


def test_runner_engine_executes_only_selected_step(tmp_path: Path) -> None:
    runner = _HappyPathRunner()
    engine = RunnerEngine(runner)

    result = engine.run_step(_workflow(), _context(tmp_path), "execute-work-item")

    assert result.status is StepStatus.SUCCEEDED
    assert runner.calls == ["execute-work-item"]


def test_workflow_orchestrator_owns_happy_path_progression(tmp_path: Path) -> None:
    runner = _HappyPathRunner()
    orchestrator = WorkflowOrchestrator(engine=RunnerEngine(runner))

    result = orchestrator.run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls == ["execute-work-item", "verify-work-item"]
    assert result.metadata["progress_owner"] == "workflow_orchestrator"
    assert result.metadata["engine_role"] == "single_step_execution"


def test_workflow_orchestrator_routes_unresolved_blocker_through_xml_decision(tmp_path: Path) -> None:
    runner = _XmlDecisionRunner()
    orchestrator = WorkflowOrchestrator(engine=RunnerEngine(runner))

    result = orchestrator.run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert runner.calls == [
        "execute-work-item",
        "verify-work-item",
        "workflow-orchestrator",
        "execute-work-item",
        "verify-work-item",
    ]
    assert result.step_results[1].metadata["route_decision"]["action"] == "handoff"


def test_workflow_orchestrator_rejects_route_to_downstream_step(tmp_path: Path) -> None:
    workflow = Workflow(
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
            Step(id="complete-work-item-plan", kind=StepKind.AGENT, name="complete", needs=("verify-work-item",)),
        ),
    )
    runner = _XmlDecisionRunner(target_step="complete-work-item-plan")
    orchestrator = WorkflowOrchestrator(engine=RunnerEngine(runner))

    result = orchestrator.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.metadata["orchestration_route_rejected"] == (
        "orchestrator cannot route to a step after the blocked/failed step"
    )
    assert "complete-work-item-plan" not in runner.calls


def test_workflow_orchestrator_selects_remediation_before_runtime_repairs(tmp_path: Path) -> None:
    workflow = Workflow(
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
                id="prepare-plan-repair",
                kind=StepKind.RECORD,
                name="prepare repair",
                metadata={"loop_target": "execute-work-item"},
            ),
        ),
    )
    runner = _RemediationDecisionRunner()
    orchestrator = WorkflowOrchestrator(engine=RunnerEngine(runner))

    result = orchestrator.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls == [
        "execute-work-item",
        "verify-work-item",
        "workflow-orchestrator",
        "prepare-plan-repair",
        "execute-work-item",
        "verify-work-item",
    ]
