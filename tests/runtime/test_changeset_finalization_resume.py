from __future__ import annotations

from pathlib import Path

import harness_codex.runtime.changeset_orchestrator as orchestrator
from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.models import RunResult, RunStatus


class _FinalizationOnlyEngine:
    calls: list[tuple[str, str, str]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=(),
            mode=context.mode,
        )


def test_completed_work_items_are_not_reexecuted_when_retrying_finalization(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_set, scopes = _completed_change_set_and_scopes(tmp_path)
    _FinalizationOnlyEngine.calls = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _FinalizationOnlyEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-finalization-retry",
    )

    assert result.status is RunStatus.SUCCEEDED
    assert _FinalizationOnlyEngine.calls == [
        (
            "changeset_finalization",
            "changeset-finalization-workflow",
            "MAINT-371-B",
        )
    ]
    assert state.completed_work_items == ("UC-371-A", "MAINT-371-B")
    assert state.decision_results["changeset_finalization"]["status"] == "succeeded"
    assert (tmp_path / ".harness/runs/run-finalization-retry/finalization/workflow.json").is_file()


def _completed_change_set_and_scopes(
    repo_root: Path,
) -> tuple[ChangeSet, tuple[PlanningInputScope, ...]]:
    use_case = AffectedUseCase(
        uc_id="UC-371-A",
        name="first user flow",
        impact_type="source-code, user-feature",
        slice_path=Path("docs/use-cases/UC-371-A"),
    )
    change_set = ChangeSet(
        change_set_id="CHG-371",
        title="finalization retry",
        path=Path("docs/changes/active/CHG-371.md"),
        affected_use_cases=(use_case,),
        affected_work_items=(
            AffectedWorkItem(
                work_item_id="UC-371-A",
                work_item_type=WorkItemType.USE_CASE,
                name="first user flow",
                impact_type="source-code, user-feature",
                slice_path=Path("docs/use-cases/UC-371-A"),
            ),
            AffectedWorkItem(
                work_item_id="MAINT-371-B",
                work_item_type=WorkItemType.MAINTENANCE,
                name="maintenance task",
                impact_type="source-code",
                slice_path=Path("docs/maintenance/MAINT-371-B"),
            ),
        ),
    )
    scopes = (
        PlanningInputScope(
            change_set_path=change_set.path,
            use_case=use_case,
            planner_inputs=(),
            executor_inputs=(),
            e2e_goal_path=Path("docs/use-cases/UC-371-A/e2e-goal.md"),
            work_item_id="UC-371-A",
            work_item_type=WorkItemType.USE_CASE,
            impact_type="source-code, user-feature",
            plan_path=Path("docs/plans/active/UC-371-A/plan.md"),
            verification_goal_path=Path("docs/use-cases/UC-371-A/e2e-goal.md"),
        ),
        PlanningInputScope(
            change_set_path=change_set.path,
            use_case=None,
            planner_inputs=(),
            executor_inputs=(),
            e2e_goal_path=None,
            work_item_id="MAINT-371-B",
            work_item_type=WorkItemType.MAINTENANCE,
            impact_type="source-code",
            plan_path=Path("docs/plans/active/MAINT-371-B/plan.md"),
            verification_goal_path=Path("docs/maintenance/MAINT-371-B/verification-goal.md"),
        ),
    )
    for scope in scopes:
        completed = repo_root / "docs/plans/completed" / scope.display_id / "plan.md"
        completed.parent.mkdir(parents=True, exist_ok=True)
        completed.write_text(f"# {scope.display_id} completed plan\n", encoding="utf-8")
    return change_set, scopes
