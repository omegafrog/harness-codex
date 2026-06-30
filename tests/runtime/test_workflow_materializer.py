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


def test_materialize_workflow_for_maintenance_scope_removes_uc_only_inputs() -> None:
    workflow = Workflow(
        name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="plan-<WORK-ITEM-ID>",
                kind=StepKind.AGENT,
                name="Plan selected work item",
                inputs=(
                    Path("docs/changes/active/<CHG-ID>.md"),
                    Path("docs/use-cases/<UC-ID>/use-case.md"),
                    Path("docs/maintenance/<MAINT-ID>/scope.md"),
                ),
                metadata={
                    "stage": "plan",
                    "inputs_resolved_by": "work_item_document_contract",
                },
            ),
        ),
    )
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="typed work items",
        path=Path("docs/changes/active/CHG-001.md"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(
            Path("docs/maintenance/MAINT-001/scope.md"),
            Path("docs/maintenance/MAINT-001/architecture-impact.md"),
        ),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        plan_path=Path("docs/plans/active/MAINT-001/plan.md"),
        verification_goal_path=Path("docs/maintenance/MAINT-001/verification-goal.md"),
    )

    materialized = materialize_workflow_for_scope(workflow, change_set, scope)

    step = materialized.steps[0]
    assert Path("docs/use-cases/<UC-ID>/use-case.md") not in step.inputs
    assert Path("docs/use-cases//use-case.md") not in step.inputs
    assert Path("docs/maintenance/MAINT-001/scope.md") in step.inputs
    assert Path("docs/maintenance/MAINT-001/architecture-impact.md") in step.inputs
    assert step.id == "plan-MAINT-001"
    assert unresolved_placeholders(materialized) == frozenset()


def test_materialize_workflow_keeps_use_case_and_maintenance_inputs_separate_in_mixed_changeset() -> None:
    workflow = Workflow(
        name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="plan-<WORK-ITEM-ID>",
                kind=StepKind.AGENT,
                name="Plan selected work item",
                inputs=(
                    Path("docs/use-cases/<UC-ID>/use-case.md"),
                    Path("docs/maintenance/<MAINT-ID>/scope.md"),
                ),
                metadata={"stage": "plan"},
            ),
        ),
    )
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="mixed work items",
        path=Path("docs/changes/active/CHG-001.md"),
    )
    use_case = AffectedUseCase(
        uc_id="UC-001",
        name="승인",
        impact_type="source-code",
        slice_path=Path("docs/use-cases/UC-001"),
    )
    use_case_scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=use_case,
        planner_inputs=(Path("docs/use-cases/UC-001/e2e-goal.md"),),
        executor_inputs=(),
        e2e_goal_path=Path("docs/use-cases/UC-001/e2e-goal.md"),
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
    )
    maintenance_scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(Path("docs/maintenance/MAINT-001/verification-goal.md"),),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        plan_path=Path("docs/plans/active/MAINT-001/plan.md"),
        verification_goal_path=Path("docs/maintenance/MAINT-001/verification-goal.md"),
    )

    use_case_workflow = materialize_workflow_for_scope(workflow, change_set, use_case_scope)
    maintenance_workflow = materialize_workflow_for_scope(workflow, change_set, maintenance_scope)

    use_case_inputs = use_case_workflow.steps[0].inputs
    maintenance_inputs = maintenance_workflow.steps[0].inputs
    assert Path("docs/use-cases/UC-001/use-case.md") in use_case_inputs
    assert Path("docs/maintenance/MAINT-001/scope.md") not in use_case_inputs
    assert Path("docs/maintenance/MAINT-001/scope.md") in maintenance_inputs
    assert Path("docs/use-cases/UC-001/use-case.md") not in maintenance_inputs
    assert unresolved_placeholders(use_case_workflow) == frozenset()
    assert unresolved_placeholders(maintenance_workflow) == frozenset()


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


def test_materialize_workflow_blocks_git_step_with_contract_input_expansion() -> None:
    workflow = Workflow(
        name="workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="complete-work-item-plan",
                kind=StepKind.GIT,
                name="Complete",
                inputs=(Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),),
                outputs=(Path("docs/plans/completed/<WORK-ITEM-ID>/plan.md"),),
                metadata={
                    "stage": "implementation",
                    "inputs_resolved_by": "work_item_document_contract",
                },
            ),
        ),
    )
    change_set = ChangeSet(change_set_id="CHG-001", title="title")
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(Path("docs/maintenance/BUG-001/brief.md"),),
        executor_inputs=(Path("docs/plans/active/BUG-001/plan.md"),),
        e2e_goal_path=None,
        work_item_id="BUG-001",
        work_item_type=WorkItemType.BUG_FIX,
    )

    with pytest.raises(WorkflowMaterializationError) as exc:
        materialize_workflow_for_scope(workflow, change_set, scope)

    assert "cannot combine git moves" in str(exc.value)


def test_materialize_workflow_blocks_git_step_without_single_move_shape() -> None:
    workflow = Workflow(
        name="workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="bad-git-step",
                kind=StepKind.GIT,
                name="Bad git step",
                inputs=(Path("one.md"), Path("two.md")),
                outputs=(Path("done.md"),),
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
        work_item_id="BUG-001",
        work_item_type=WorkItemType.BUG_FIX,
    )

    with pytest.raises(WorkflowMaterializationError) as exc:
        materialize_workflow_for_scope(workflow, change_set, scope)

    assert "exactly one input and one output" in str(exc.value)
