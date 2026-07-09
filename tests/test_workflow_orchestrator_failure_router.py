from pathlib import Path

import pytest

from harness_codex.runtime.workflows.loader import load_named_workflow


def test_failure_router_is_not_a_static_execution_workflow_step() -> None:
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=Path(".harness/workflows"),
    )

    with pytest.raises(KeyError):
        workflow.step_by_id("prepare-plan-repair")

    assert all(
        step.metadata.get("runtime_role") != "failure_router"
        for step in workflow.steps
    )
    assert all("loop_target" not in step.metadata for step in workflow.steps)
