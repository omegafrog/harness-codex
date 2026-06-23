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


def test_work_item_and_changeset_finalization_have_distinct_boundaries() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    work_item_workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    finalization_workflow = load_named_workflow(
        "changeset-finalization-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )

    assert work_item_workflow.name == "changeset-work-item-workflow"
    assert work_item_workflow.step_ids() == (
        "load-change-set",
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "verify-work-item",
        "verify-work-item-security",
        "classify-verification-result",
        "remediate-work-item",
        "complete-work-item-plan",
    )
    assert "create-change-set-pr" not in work_item_workflow.step_ids()
    assert "complete-change-set" not in work_item_workflow.step_ids()
    assert all(
        "run_on_final_work_item_only" not in step.metadata
        for step in work_item_workflow.steps
    )

    assert finalization_workflow.name == "changeset-finalization-workflow"
    assert finalization_workflow.step_ids() == (
        "verify-all-work-items-completed",
        "create-change-set-pr",
        "complete-change-set",
    )
    assert all(
        step.metadata["execution_boundary"] == "changeset_finalization"
        for step in finalization_workflow.steps
    )


def test_work_item_and_finalization_workflows_materialize_without_placeholders() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    work_item_workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    finalization_workflow = load_named_workflow(
        "changeset-finalization-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    change_set = ChangeSet(change_set_id="CHG-372", title="test")
    use_case = AffectedUseCase(
        uc_id="UC-372",
        name="workflow test",
        impact_type="source-code, user-feature",
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
        impact_type="source-code, user-feature",
        plan_path=Path("docs/plans/active/UC-372/plan.md"),
    )

    materialized_work_item = materialize_workflow_for_scope(
        work_item_workflow,
        change_set,
        scope,
        run_id="run-372",
    )
    materialized_finalization = materialize_workflow_for_scope(
        finalization_workflow,
        change_set,
        scope,
        run_id="run-372",
    )

    verification = materialized_work_item.step_by_id("verify-work-item")
    delivery = materialized_finalization.step_by_id("create-change-set-pr")
    assert Path("docs/plans/active/UC-372/plan.md") in verification.inputs
    assert all("<RUN-ID>" not in str(path) for path in verification.outputs)
    assert delivery.needs == ("verify-all-work-items-completed",)
    assert unresolved_placeholders(materialized_work_item) == frozenset()
    assert unresolved_placeholders(materialized_finalization) == frozenset()
