from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
    unresolved_placeholders,
)


def test_implementation_workflow_contains_only_internal_stage_execution() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )

    assert workflow.step_ids() == (
        "load-change-set",
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
        "classify-verification-result",
        "remediate-work-item",
        "complete-work-item-plan",
    )
    assert "update-project-wiki" not in workflow.step_ids()
    assert "validate-project-wiki" not in workflow.step_ids()
    assert "create-change-set-pr" not in workflow.step_ids()
    assert "complete-change-set" not in workflow.step_ids()


def test_implementation_workflow_materializes_selected_use_case_contract() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    change_set = ChangeSet(change_set_id="CHG-372", title="test")
    use_case = AffectedUseCase(
        uc_id="UC-372",
        name="workflow test",
        impact_type="update",
        slice_path=Path("docs/use-cases/UC-372"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-372.md"),
        use_case=use_case,
        planner_inputs=(Path("docs/use-cases/UC-372/use-case.md"),),
        executor_inputs=(Path("docs/use-cases/UC-372/e2e-goal.md"),),
        e2e_goal_path=Path("docs/use-cases/UC-372/e2e-goal.md"),
        work_item_id="UC-372",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-372/plan.md"),
    )

    materialized = materialize_workflow_for_scope(
        workflow,
        change_set,
        scope,
        run_id="run-372",
    )

    verification = materialized.step_by_id("verify-work-item")
    assert Path("docs/plans/active/UC-372/plan.md") in verification.inputs
    assert all("<RUN-ID>" not in str(path) for path in verification.outputs)
    assert unresolved_placeholders(materialized) == frozenset()
