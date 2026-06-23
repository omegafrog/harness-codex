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


def test_work_item_workflow_excludes_changeset_finalization() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    work_item_workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    finalization_workflow = load_named_workflow(
        "changeset-finalization-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )

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
    assert "update-project-wiki" not in work_item_workflow.step_ids()
    assert "validate-project-wiki" not in work_item_workflow.step_ids()
    assert "create-change-set-pr" not in work_item_workflow.step_ids()
    assert "complete-change-set" not in work_item_workflow.step_ids()
    assert all(
        step.metadata["execution_boundary"] == "work_item"
        for step in work_item_workflow.steps
    )

    assert finalization_workflow.step_ids() == (
        "verify-all-work-items-completed",
        "create-change-set-pr",
        "complete-change-set",
    )
    assert finalization_workflow.step_by_id("complete-change-set").needs == (
        "create-change-set-pr",
    )
    assert all(
        step.metadata["execution_boundary"] == "changeset_finalization"
        for step in finalization_workflow.steps
    )


def test_work_item_and_finalization_workflows_materialize_without_unresolved_placeholders() -> None:
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
    assert delivery.command == (
        "python3 -m harness_codex.runtime.change_set_pr_delivery "
        "--change-set CHG-372 --run-id run-372"
    )
    assert unresolved_placeholders(materialized_work_item) == frozenset()
    assert unresolved_placeholders(materialized_finalization) == frozenset()
