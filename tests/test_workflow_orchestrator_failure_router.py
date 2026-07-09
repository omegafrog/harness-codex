from pathlib import Path

from harness_codex.runtime.models import StepKind
from harness_codex.runtime.workflows.loader import load_named_workflow


def test_prepare_plan_repair_uses_workflow_orchestrator_agent_without_extra_artifact_gate() -> None:
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=Path(".harness/workflows"),
    )

    step = workflow.step_by_id("prepare-plan-repair")

    assert step.kind is StepKind.AGENT
    assert step.agent_id == "workflow_orchestrator"
    assert step.skill_id == "harness-orchestrate-instruction"
    assert step.outputs == ()
    assert "review_gate" not in step.metadata
    assert step.metadata["runtime_role"] == "failure_router"
    assert step.metadata["loop_target"] == "plan-work-item"
    assert step.metadata["routing_contract"] == {
        "allowed_routes": ["plan-work-item", "blocked"],
        "required_evidence": [
            "runtime_failed_step_id",
            "runtime_failure_kind",
            "runtime_failure_error",
        ],
    }
