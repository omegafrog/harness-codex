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
    work_item_workflow = load_named_workflow("changeset-use-case-workflow", workflows_dir=repo_root / ".harness/workflows")
    finalization_workflow = load_named_workflow("changeset-finalization-workflow", workflows_dir=repo_root / ".harness/workflows")
    step_ids = work_item_workflow.step_ids()

    assert step_ids[:5] == (
        "load-change-set",
        "plan-work-item",
        "materialize-security-profile",
        "secure-work-item-plan",
        "review-work-item-plan",
    )
    assert "materialize-execution-scope" in step_ids
    assert step_ids.index("materialize-execution-scope") < step_ids.index("execute-work-item")
    assert step_ids.index("verify-work-item") < step_ids.index("collect-pre-security-token-metrics")
    assert step_ids.index("collect-pre-security-token-metrics") < step_ids.index("materialize-security-review-bundle")
    assert step_ids.index("verify-work-item-security") < step_ids.index("collect-work-item-token-metrics")
    assert step_ids.index("collect-work-item-token-metrics") < step_ids.index("classify-verification-result")
    assert step_ids[-2:] == ("remediate-work-item", "complete-work-item-plan")
    assert "update-project-wiki" not in step_ids
    assert "validate-project-wiki" not in step_ids
    assert "create-change-set-pr" not in step_ids
    assert "complete-change-set" not in step_ids
    assert all(step.metadata["execution_boundary"] == "work_item" for step in work_item_workflow.steps)

    assert finalization_workflow.step_ids() == (
        "verify-all-work-items-completed",
        "create-change-set-pr",
        "complete-change-set",
    )
    assert finalization_workflow.step_by_id("complete-change-set").needs == ("create-change-set-pr",)
    assert all(step.metadata["execution_boundary"] == "changeset_finalization" for step in finalization_workflow.steps)


def test_work_item_and_finalization_workflows_materialize_without_unresolved_placeholders() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    work_item_workflow = load_named_workflow("changeset-use-case-workflow", workflows_dir=repo_root / ".harness/workflows")
    finalization_workflow = load_named_workflow("changeset-finalization-workflow", workflows_dir=repo_root / ".harness/workflows")
    change_set = ChangeSet(change_set_id="CHG-372", title="test")
    use_case = AffectedUseCase(uc_id="UC-372", name="workflow test", impact_type="update", slice_path=Path("docs/use-cases/UC-372"))
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

    materialized_work_item = materialize_workflow_for_scope(work_item_workflow, change_set, scope, run_id="run-372")
    materialized_finalization = materialize_workflow_for_scope(finalization_workflow, change_set, scope, run_id="run-372")

    verification = materialized_work_item.step_by_id("verify-work-item")
    execution_scope = materialized_work_item.step_by_id("materialize-execution-scope")
    security_profile = materialized_work_item.step_by_id("materialize-security-profile")
    pre_security_metrics = materialized_work_item.step_by_id("collect-pre-security-token-metrics")
    final_metrics = materialized_work_item.step_by_id("collect-work-item-token-metrics")
    delivery = materialized_finalization.step_by_id("create-change-set-pr")
    assert Path("docs/plans/active/UC-372/plan.md") in verification.inputs
    assert Path("docs/plans/active/UC-372/plan.md") in execution_scope.inputs
    assert Path("docs/plans/active/UC-372/plan.md") in security_profile.inputs
    assert all("<RUN-ID>" not in str(path) for path in verification.outputs)
    assert all("<RUN-ID>" not in str(path) for path in pre_security_metrics.outputs)
    assert all("<RUN-ID>" not in str(path) for path in final_metrics.outputs)
    assert delivery.command == "python3 -m harness_codex.runtime.change_set_pr_delivery --change-set CHG-372 --run-id run-372"
    assert unresolved_placeholders(materialized_work_item) == frozenset()
    assert unresolved_placeholders(materialized_finalization) == frozenset()


def test_skipped_gate_steps_preserve_transitive_dependencies() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    change_set = ChangeSet(change_set_id="CHG-SKIP", title="test")
    use_case = AffectedUseCase(
        uc_id="UC-SKIP",
        name="workflow skip test",
        impact_type="source-code",
        slice_path=Path("docs/use-cases/UC-SKIP"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-SKIP.md"),
        use_case=use_case,
        planner_inputs=(),
        executor_inputs=(),
        e2e_goal_path=Path("docs/use-cases/UC-SKIP/e2e-goal.md"),
        work_item_id="UC-SKIP",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-SKIP/plan.md"),
        impact_type="source-code",
    )

    materialized = materialize_workflow_for_scope(
        workflow,
        change_set,
        scope,
        run_id="run-skip",
    )

    assert materialized.step_by_id("review-work-item-plan").needs == (
        "materialize-security-profile",
    )
    assert materialized.step_by_id("materialize-execution-scope").needs == (
        "review-work-item-plan",
    )
    assert materialized.step_by_id("classify-verification-result").needs == (
        "collect-work-item-token-metrics",
    )
