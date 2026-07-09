from pathlib import Path

from harness_codex.runtime.models import StepKind
from harness_codex.runtime.workflows.loader import load_named_workflow


def test_prepare_plan_repair_uses_workflow_orchestrator_agent() -> None:
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=Path(".harness/workflows"),
    )

    step = workflow.step_by_id("prepare-plan-repair")

    assert step.kind is StepKind.AGENT
    assert step.agent_id == "workflow_orchestrator"
    assert step.skill_id == "harness-orchestrate-instruction"
    assert step.metadata["runtime_role"] == "failure_router"
    assert step.metadata["loop_target"] == "plan-work-item"
    assert step.outputs == (
        Path(".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/orchestration/decision.md"),
    )
    assert step.metadata["routing_contract"]["allowed_routes"] == [
        "plan-work-item",
        "blocked",
    ]
    assert step.metadata["routing_contract"]["decision_output"] == (
        ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/orchestration/decision.md"
    )
    assert step.metadata["review_gate"] == {
        "output": ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/orchestration/decision.md",
        "status_label": "Route Status",
        "approved_status": "route-to-loop-target",
    }
