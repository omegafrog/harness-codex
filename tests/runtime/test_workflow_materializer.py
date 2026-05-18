from pathlib import Path

import pytest

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.models import RunMode, Step, StepKind, Workflow
from harness_codex.runtime.workflows import (
    WorkflowMaterializationError,
    materialize_workflow_for_scope,
    unresolved_placeholders,
)


def test_materialize_workflow_for_use_case_scope_replaces_paths_and_metadata() -> None:
    workflow = Workflow(
        name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="plan-<WORK-ITEM-ID>",
                kind=StepKind.AGENT,
                name="Plan <UC-ID>",
                agent_id="implementation_planner",
                inputs=(Path("docs/changes/active/<CHG-ID>.md"),),
                outputs=(Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),),
                metadata={"uc": "<UC-ID>", "items": ["<WORK-ITEM-ID>"]},
            ),
        ),
    )
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="ChangeSet-first runtime",
        path=Path("docs/changes/active/CHG-001.md"),
    )
    use_case = AffectedUseCase(
        uc_id="UC-001",
        name="결제 승인",
        impact_type="update",
        slice_path=Path("docs/use-cases/UC-001"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=use_case,
        planner_inputs=(),
        executor_inputs=(),
        e2e_goal_path=Path("docs/use-cases/UC-001/e2e-goal.md"),
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
    )

    materialized = materialize_workflow_for_scope(workflow, change_set, scope)

    assert materialized.metadata["materialized"] is True
    assert materialized.metadata["change_set_id"] == "CHG-001"
    assert materialized.metadata["work_item_id"] == "UC-001"
    step = materialized.steps[0]
    assert step.id == "plan-UC-001"
    assert step.name == "Plan UC-001"
    assert step.inputs == (Path("docs/changes/active/CHG-001.md"),)
    assert step.outputs == (Path("docs/plans/active/UC-001/plan.md"),)
    assert step.metadata["uc"] == "UC-001"
    assert step.metadata["items"] == ["UC-001"]
    assert unresolved_placeholders(materialized) == frozenset()


def test_materialize_workflow_blocks_unresolved_placeholders() -> None:
    workflow = Workflow(
        name="workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="plan",
                kind=StepKind.AGENT,
                name="Plan <UNKNOWN-ID>",
                agent_id="implementation_planner",
            ),
        ),
    )
    change_set = ChangeSet(change_set_id="CHG-001", title="title")
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
    )

    with pytest.raises(WorkflowMaterializationError) as exc:
        materialize_workflow_for_scope(workflow, change_set, scope)

    assert "<UNKNOWN-ID>" in str(exc.value)
