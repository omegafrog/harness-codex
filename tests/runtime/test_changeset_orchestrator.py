from __future__ import annotations

import json
from pathlib import Path

import harness_codex.cli as cli
import harness_codex.runtime.changeset_orchestrator as orchestrator
from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.models import FailureKind, RunResult, RunStatus
from harness_codex.runtime.state import ResumeDisposition, decide_resume_target


class _SuccessfulEngine:
    calls: list[tuple[str, str, str]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        if boundary == "work_item":
            active = context.repo_root / str(context.metadata["active_plan_path"])
            completed = context.repo_root / "docs/plans/completed" / work_item_id / "plan.md"
            completed.parent.mkdir(parents=True, exist_ok=True)
            active.replace(completed)
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=(),
            mode=context.mode,
        )


class _BlockedFirstEngine:
    calls: list[tuple[str, str, str]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.BLOCKED,
            step_results=(),
            mode=context.mode,
            failed_step_id="execute-work-item",
            failure_kind=FailureKind.IMPLEMENTATION,
            blocker="implementation failed",
        )


def test_cli_delegates_apply_workflow_to_session_orchestrator() -> None:
    assert cli._apply_workflow is orchestrator.apply_workflow


def test_runs_each_work_item_before_one_changeset_finalization(tmp_path: Path, monkeypatch) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _SuccessfulEngine.calls = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _SuccessfulEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-371",
    )

    assert result.status is RunStatus.SUCCEEDED
    assert _SuccessfulEngine.calls == [
        ("work_item", "changeset-work-item-workflow", "UC-371-A"),
        ("work_item", "changeset-work-item-workflow", "MAINT-371-B"),
        ("changeset_finalization", "changeset-finalization-workflow", "MAINT-371-B"),
    ]
    assert state.completed_work_items == ("UC-371-A", "MAINT-371-B")
    assert state.decision_results["changeset_finalization"]["status"] == "succeeded"
    assert (tmp_path / ".harness/runs/run-371/finalization/workflow.json").is_file()
    finalization = json.loads(
        (tmp_path / ".harness/runs/run-371/finalization/report.json").read_text(encoding="utf-8")
    )
    assert finalization["workflow"] == "changeset-finalization-workflow"
    report = json.loads((tmp_path / ".harness/runs/run-371/report.json").read_text(encoding="utf-8"))
    assert report["workflow_name"] == "changeset-session"
    assert report["report_paths"]["changeset_finalization"].endswith("finalization/report.json")


def test_stops_on_first_failed_work_item_and_does_not_finalize(tmp_path: Path, monkeypatch) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _BlockedFirstEngine.calls = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _BlockedFirstEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-372",
    )

    assert result.status is RunStatus.BLOCKED
    assert _BlockedFirstEngine.calls == [
        ("work_item", "changeset-work-item-workflow", "UC-371-A"),
    ]
    assert state.blocked_work_items == ("UC-371-A",)
    assert state.completed_work_items == ()
    assert state.decision_results["changeset_finalization"]["status"] == "not_started"
    assert not (tmp_path / ".harness/runs/run-372/finalization/workflow.json").exists()
    resume = decide_resume_target(state)
    assert resume.disposition is ResumeDisposition.RETRY_REMEDIATION
    assert resume.work_item_id == "UC-371-A"


def _change_set_and_scopes(tmp_path: Path) -> tuple[ChangeSet, tuple[PlanningInputScope, ...]]:
    first_use_case = AffectedUseCase(
        uc_id="UC-371-A",
        name="first user flow",
        impact_type="source-code, user-feature",
        slice_path=Path("docs/use-cases/UC-371-A"),
    )
    work_items = (
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
            name="second maintenance task",
            impact_type="source-code",
            slice_path=Path("docs/maintenance/MAINT-371-B"),
        ),
    )
    change_set = ChangeSet(
        change_set_id="CHG-371",
        title="two work item session",
        path=Path("docs/changes/active/CHG-371.md"),
        affected_use_cases=(first_use_case,),
        affected_work_items=work_items,
    )
    scopes = (
        PlanningInputScope(
            change_set_path=change_set.path,
            use_case=first_use_case,
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
        plan = tmp_path / scope.plan_path
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(f"# {scope.display_id} plan\n", encoding="utf-8")
    return change_set, scopes
