from pathlib import Path

from harness_codex.runtime.changes import ChangeSetResolver
from harness_codex.runtime.changes.models import (
    AffectedWorkItem,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.changes.work_item_documents import (
    missing_required_documents,
    scaffold_work_item_documents,
)
from harness_codex.runtime.models import RunMode, Step, StepKind, Workflow
from harness_codex.runtime.workflows import materialize_workflow_for_scope


def test_scaffold_bug_fix_documents_are_type_specific_and_non_destructive(
    tmp_path: Path,
) -> None:
    work_item = AffectedWorkItem(
        work_item_id="BUG-042",
        work_item_type=WorkItemType.BUG_FIX,
        name="Duplicate queue admission after reconnect",
        impact_type="fix",
        slice_path=Path("docs/maintenance/BUG-042"),
    )

    created = scaffold_work_item_documents(tmp_path, work_item)

    expected = {
        Path("docs/maintenance/BUG-042/brief.md"),
        Path("docs/maintenance/BUG-042/architecture-impact.md"),
        Path("docs/maintenance/BUG-042/verification-goal.md"),
        Path("docs/maintenance/BUG-042/links.md"),
        Path("docs/maintenance/BUG-042/reproduction.md"),
        Path("docs/maintenance/BUG-042/regression-goal.md"),
    }
    assert set(created) == expected
    assert not missing_required_documents(tmp_path, work_item)

    reproduction = tmp_path / "docs/maintenance/BUG-042/reproduction.md"
    reproduction.write_text("# Authored reproduction\n", encoding="utf-8")
    assert scaffold_work_item_documents(tmp_path, work_item) == ()
    assert reproduction.read_text(encoding="utf-8") == "# Authored reproduction\n"


def test_resolver_uses_bug_fix_contract_without_use_case_paths(tmp_path: Path) -> None:
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_set_path.parent.mkdir(parents=True)
    change_set_path.write_text(
        """# ChangeSet CHG-001

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-001`|
|Status|active|

## 5. Affected Work Items
|Work Item ID|Type|Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|---|
|`BUG-042`|bug_fix|Duplicate queue admission after reconnect|fix|`docs/maintenance/BUG-042/`|planned|
""",
        encoding="utf-8",
    )
    work_item = AffectedWorkItem(
        work_item_id="BUG-042",
        work_item_type=WorkItemType.BUG_FIX,
        name="Duplicate queue admission after reconnect",
        impact_type="fix",
        slice_path=Path("docs/maintenance/BUG-042"),
    )
    scaffold_work_item_documents(tmp_path, work_item)

    resolver = ChangeSetResolver(tmp_path)
    scopes = resolver.resolve_work_item_scopes(resolver.load(change_set_path))

    assert isinstance(scopes, tuple)
    scope = scopes[0]
    assert scope.work_item_type == WorkItemType.BUG_FIX
    assert scope.verification_goal_path == Path("docs/maintenance/BUG-042/verification-goal.md")
    assert Path("docs/maintenance/BUG-042/reproduction.md") in scope.planner_inputs
    assert Path("docs/maintenance/BUG-042/regression-goal.md") in scope.planner_inputs
    assert not any("docs/use-cases" in str(path) for path in scope.planner_inputs)


def test_materializer_uses_scope_owned_inputs_for_non_uc_work_item() -> None:
    workflow = Workflow(
        name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="plan-work-item",
                kind=StepKind.AGENT,
                name="Plan <WORK-ITEM-ID>",
                agent_id="implementation_planner",
                inputs=(
                    Path("docs/use-cases/<UC-ID>"),
                    Path("docs/maintenance/<MAINT-ID>"),
                ),
                metadata={"stage": "plan", "scope": "work_item"},
            ),
            Step(
                id="verify-work-item",
                kind=StepKind.VALIDATOR,
                name="Verify <WORK-ITEM-ID>",
                command="echo verify",
                inputs=(
                    Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
                    Path("docs/maintenance/<MAINT-ID>/verification-goal.md"),
                ),
                metadata={"stage": "verification", "scope": "work_item"},
            ),
        ),
    )
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="Typed work-item documents",
        path=Path("docs/changes/active/CHG-001.md"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(
            Path("docs/changes/active/CHG-001.md"),
            Path("docs/maintenance/BUG-042/reproduction.md"),
            Path("docs/maintenance/BUG-042/regression-goal.md"),
        ),
        executor_inputs=(
            Path("docs/plans/active/BUG-042/plan.md"),
            Path("docs/maintenance/BUG-042/verification-goal.md"),
        ),
        e2e_goal_path=None,
        work_item_id="BUG-042",
        work_item_type=WorkItemType.BUG_FIX,
        plan_path=Path("docs/plans/active/BUG-042/plan.md"),
        verification_goal_path=Path("docs/maintenance/BUG-042/verification-goal.md"),
    )

    materialized = materialize_workflow_for_scope(workflow, change_set, scope)

    assert materialized.steps[0].inputs == scope.planner_inputs
    assert materialized.steps[1].inputs == scope.executor_inputs
    assert not any(str(path) in {"docs/use-cases", "docs/maintenance"} for step in materialized.steps for path in step.inputs)


def test_materializer_preserves_shared_plan_and_gate_inputs() -> None:
    workflow = Workflow(
        name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="review-work-item-plan",
                kind=StepKind.AGENT,
                name="Review <WORK-ITEM-ID>",
                agent_id="artifact_reviewer",
                inputs=(
                    Path("docs/changes/active/<CHG-ID>.md"),
                    Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),
                    Path(".codex/test-gate.yaml"),
                ),
                metadata={"stage": "review", "scope": "work_item"},
            ),
        ),
    )
    change_set = ChangeSet(change_set_id="CHG-001", title="Typed work-item documents")
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(Path("docs/maintenance/BUG-042/reproduction.md"),),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="BUG-042",
        work_item_type=WorkItemType.BUG_FIX,
        plan_path=Path("docs/plans/active/BUG-042/plan.md"),
    )

    materialized = materialize_workflow_for_scope(workflow, change_set, scope)

    assert materialized.steps[0].inputs == (
        Path("docs/changes/active/CHG-001.md"),
        Path("docs/plans/active/BUG-042/plan.md"),
        Path(".codex/test-gate.yaml"),
        Path("docs/maintenance/BUG-042/reproduction.md"),
    )


def test_materializer_does_not_expand_git_completion_inputs() -> None:
    workflow = Workflow(
        name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="complete-work-item-plan",
                kind=StepKind.GIT,
                name="Complete <WORK-ITEM-ID>",
                inputs=(Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),),
                outputs=(Path("docs/plans/completed/<WORK-ITEM-ID>/plan.md"),),
                metadata={"stage": "review", "scope": "work_item"},
            ),
        ),
    )
    change_set = ChangeSet(change_set_id="CHG-001", title="Typed work-item documents")
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(
            Path("docs/changes/active/CHG-001.md"),
            Path("docs/maintenance/BUG-042/reproduction.md"),
        ),
        executor_inputs=(Path("docs/plans/active/BUG-042/plan.md"),),
        e2e_goal_path=None,
        work_item_id="BUG-042",
        work_item_type=WorkItemType.BUG_FIX,
        plan_path=Path("docs/plans/active/BUG-042/plan.md"),
    )

    materialized = materialize_workflow_for_scope(workflow, change_set, scope)

    step = materialized.step_by_id("complete-work-item-plan")
    assert step.inputs == (Path("docs/plans/active/BUG-042/plan.md"),)
    assert step.outputs == (Path("docs/plans/completed/BUG-042/plan.md"),)


def test_refactoring_contract_uses_preservation_document(tmp_path: Path) -> None:
    work_item = AffectedWorkItem(
        work_item_id="REF-007",
        work_item_type=WorkItemType.REFACTORING,
        name="Split dispatcher and broker responsibilities",
        impact_type="refactor",
        slice_path=Path("docs/maintenance/REF-007"),
    )

    scaffold_work_item_documents(tmp_path, work_item)

    contract = tmp_path / "docs/maintenance/REF-007/refactoring-contract.md"
    assert contract.is_file()
    assert "Preserved public behavior and invariants" in contract.read_text(encoding="utf-8")
