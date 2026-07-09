from __future__ import annotations

from pathlib import Path

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
from harness_codex.runtime.workflow_routing import BlockCode, RouteAction
from harness_codex.runtime.workflow_routing_patch import apply_workflow_routing_patch


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
        metadata=metadata or {"workflow_kind": "maintenance"},
    )


def test_terminal_failed_result_gets_orchestrator_route_decision(tmp_path: Path) -> None:
    apply_workflow_routing_patch()
    step = Step(id="verify-maintenance-result", kind=StepKind.VALIDATOR, name="verify")
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(
        _Runner(
            StepResult(
                step_id="verify-maintenance-result",
                status=StepStatus.FAILED,
                error="tests failed",
                metadata={"block_code": BlockCode.TEST_FAILED.value},
            )
        )
    )

    result = engine.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    decision = result.metadata["orchestrator_route_decision"]
    assert decision["action"] == RouteAction.ROUTE.value
    assert decision["target_step"] == "implement-maintenance"
    assert decision["block_code"] == BlockCode.TEST_FAILED.value


def test_terminal_unsafe_block_becomes_fatal_stop_metadata(tmp_path: Path) -> None:
    apply_workflow_routing_patch()
    step = Step(id="classify-diff", kind=StepKind.DECISION, name="classify diff")
    workflow = Workflow(name="workflow-test", mode=RunMode.APPLY, steps=(step,))
    engine = RunnerEngine(
        _Runner(
            StepResult(
                step_id="classify-diff",
                status=StepStatus.BLOCKED,
                error="unrelated dirty working tree",
                metadata={
                    "block_code": BlockCode.REPO_DIRTY_UNRELATED.value,
                    "unsafe_to_retry": True,
                },
            )
        )
    )

    result = engine.run(workflow, _context(tmp_path))

    assert result.status is RunStatus.FAILED
    assert result.metadata["fatal_stop"] is True
    decision = result.metadata["orchestrator_route_decision"]
    assert decision["action"] == RouteAction.STOP_FATAL.value
    assert decision["block_code"] == BlockCode.REPO_DIRTY_UNRELATED.value
