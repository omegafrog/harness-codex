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
from harness_codex.runtime.state import (
    ResumeDisposition,
    decide_resume_target,
    runtime_stage_projection,
)


class _SuccessfulEngine:
    calls: list[tuple[str, str, str]] = []
    completion_only: list[tuple[str, bool]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        self.completion_only.append(
            (work_item_id, bool(context.metadata.get("run_ready_work_item_completion_only")))
        )
        if boundary == "work_item":
            _complete_active_plan(context, work_item_id)
        return _success_result(context)


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


class _FinalizationBlockedEngine:
    calls: list[tuple[str, str, str]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        if boundary == "work_item":
            _complete_active_plan(context, work_item_id)
            return _success_result(context)
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.BLOCKED,
            step_results=(),
            mode=context.mode,
            failed_step_id="create-change-set-pr",
            blocker="delivery approval is missing",
        )


class _FinalizationFailedEngine:
    calls: list[tuple[str, str, str]] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        if boundary == "work_item":
            _complete_active_plan(context, work_item_id)
            return _success_result(context)
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.BLOCKED,
            step_results=(),
            mode=context.mode,
            failed_step_id="create-change-set-pr",
            blocker="git push failed",
        )


class _WorktreeEngine:
    calls: list[tuple[str, str, str]] = []
    repo_roots: list[Path] = []

    def __init__(self, _runner) -> None:
        pass

    def run(self, workflow, context):
        boundary = str(context.metadata["execution_boundary"])
        work_item_id = str(context.metadata["active_work_item_id"])
        self.calls.append((boundary, workflow.name, work_item_id))
        self.repo_roots.append(context.repo_root)
        if boundary == "work_item":
            product = context.repo_root / "src" / f"{work_item_id}.txt"
            product.parent.mkdir(parents=True, exist_ok=True)
            product.write_text(f"{work_item_id}\n", encoding="utf-8")
            _complete_active_plan(context, work_item_id)
        return _success_result(context)


def test_cli_installs_changeset_session_execution_boundary() -> None:
    assert cli._changeset_execution_boundary_installed is True
    assert cli._apply_workflow is not orchestrator.apply_workflow


def test_runs_two_use_cases_before_one_changeset_finalization(tmp_path: Path, monkeypatch) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _SuccessfulEngine.calls = []
    _SuccessfulEngine.completion_only = []
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
        ("work_item", "changeset-work-item-workflow", "UC-371-B"),
        ("changeset_finalization", "changeset-finalization-workflow", "UC-371-B"),
    ]
    assert state.completed_work_items == ("UC-371-A", "UC-371-B")
    assert state.decision_results["changeset_finalization"]["status"] == "succeeded"
    assert (tmp_path / ".harness/runs/run-371/finalization/workflow.json").is_file()
    finalization = json.loads(
        (tmp_path / ".harness/runs/run-371/finalization/report.json").read_text(
            encoding="utf-8"
        )
    )
    assert finalization["workflow"] == "changeset-finalization-workflow"
    report = json.loads((tmp_path / ".harness/runs/run-371/report.json").read_text(encoding="utf-8"))
    assert report["workflow_name"] == "changeset-session"
    assert report["report_paths"]["changeset_finalization"].endswith("finalization/report.json")


def test_ready_active_plan_runs_completion_only_workflow(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _write_completion_ready_plan(tmp_path, "UC-371-A")
    _SuccessfulEngine.calls = []
    _SuccessfulEngine.completion_only = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _SuccessfulEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes[:1],
        run_id="run-374",
    )

    assert result.status is RunStatus.SUCCEEDED
    assert _SuccessfulEngine.completion_only == [
        ("UC-371-A", True),
        ("UC-371-A", False),
    ]
    assert state.completed_work_items == ("UC-371-A",)


def test_stops_on_first_failed_work_item_without_starting_second_or_finalization(
    tmp_path: Path,
    monkeypatch,
) -> None:
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
    assert state.work_item_states[1].status is RunStatus.PENDING
    assert state.completed_work_items == ()
    assert state.decision_results["changeset_finalization"]["status"] == "not_started"
    assert not (tmp_path / ".harness/runs/run-372/finalization/workflow.json").exists()
    resume = decide_resume_target(state)
    assert resume.disposition is ResumeDisposition.RETRY_REMEDIATION
    assert resume.work_item_id == "UC-371-A"


def test_missing_delivery_approval_completes_run_without_pr_delivery(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _FinalizationBlockedEngine.calls = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _FinalizationBlockedEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-373",
    )

    assert result.status is RunStatus.SUCCEEDED
    assert _FinalizationBlockedEngine.calls == [
        ("work_item", "changeset-work-item-workflow", "UC-371-A"),
        ("work_item", "changeset-work-item-workflow", "UC-371-B"),
        ("changeset_finalization", "changeset-finalization-workflow", "UC-371-B"),
    ]
    assert state.completed_work_items == ("UC-371-A", "UC-371-B")
    assert state.decision_results["changeset_finalization"]["status"] == "succeeded"
    assert (
        state.decision_results["changeset_finalization"]["delivery_status"]
        == "pending_approval"
    )
    stage_projection = runtime_stage_projection(state)
    assert stage_projection["implementation"]["status"] == "verified"
    assert stage_projection["change-set-pr"]["status"] == "pending"
    assert (tmp_path / ".harness/runs/run-373/finalization/report.json").is_file()
    resume = decide_resume_target(state)
    assert resume.disposition is ResumeDisposition.COMPLETE


def test_changes_continue_prefers_implementation_when_all_plans_completed(
    tmp_path: Path,
) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    for scope in scopes:
        completed = tmp_path / "docs/plans/completed" / scope.display_id / "plan.md"
        completed.parent.mkdir(parents=True, exist_ok=True)
        completed.write_text(f"# {scope.display_id} completed\n", encoding="utf-8")

    decision = cli._decide_changes_continue_target(
        tmp_path,
        change_set,
        uc_override=None,
    )

    assert decision["stage_id"] == "implementation"
    assert decision["uc_id"] is None
    assert decision["force"] is True


def test_finalization_failure_preserves_completed_work_items_for_delivery_retry(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _FinalizationFailedEngine.calls = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _FinalizationFailedEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-373",
    )

    assert result.status is RunStatus.BLOCKED
    assert _FinalizationFailedEngine.calls == [
        ("work_item", "changeset-work-item-workflow", "UC-371-A"),
        ("work_item", "changeset-work-item-workflow", "UC-371-B"),
        ("changeset_finalization", "changeset-finalization-workflow", "UC-371-B"),
    ]
    assert state.completed_work_items == ("UC-371-A", "UC-371-B")
    assert state.decision_results["changeset_finalization"]["status"] == "blocked"
    resume = decide_resume_target(state)
    assert resume.disposition is ResumeDisposition.RETRY_FINALIZATION


def test_git_implementation_runs_each_work_item_in_own_worktree_and_merges(tmp_path: Path, monkeypatch) -> None:
    change_set, scopes = _change_set_and_scopes(tmp_path)
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "harness@example.test")
    _git(tmp_path, "config", "user.name", "Harness Test")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "초기 상태")
    _WorktreeEngine.calls = []
    _WorktreeEngine.repo_roots = []
    monkeypatch.setattr(orchestrator, "RunnerEngine", _WorktreeEngine)

    state, result = orchestrator.apply_workflow(
        tmp_path,
        change_set,
        scopes,
        run_id="run-worktree",
    )

    assert result.status is RunStatus.SUCCEEDED
    work_item_roots = _WorktreeEngine.repo_roots[:2]
    final_root = _WorktreeEngine.repo_roots[2]
    assert all(root != tmp_path for root in work_item_roots)
    assert len(set(work_item_roots)) == 2
    assert final_root != tmp_path
    assert final_root.name == "delivery"
    assert (final_root / "src/UC-371-A.txt").read_text(encoding="utf-8") == "UC-371-A\n"
    assert (final_root / "src/UC-371-B.txt").read_text(encoding="utf-8") == "UC-371-B\n"
    assert state.completed_work_items == ("UC-371-A", "UC-371-B")


def _success_result(context) -> RunResult:
    return RunResult(
        run_id=context.run_id,
        status=RunStatus.SUCCEEDED,
        step_results=(),
        mode=context.mode,
    )


def _complete_active_plan(context, work_item_id: str) -> None:
    active = context.repo_root / str(context.metadata["active_plan_path"])
    completed = context.repo_root / "docs/plans/completed" / work_item_id / "plan.md"
    completed.parent.mkdir(parents=True, exist_ok=True)
    active.replace(completed)


def _write_completion_ready_plan(root: Path, work_item_id: str) -> None:
    evidence = root / ".harness/runs/run-374/evidence.txt"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text("ok\n", encoding="utf-8")
    plan = root / "docs/plans/active" / work_item_id / "plan.md"
    plan.write_text(
        f"""# {work_item_id} plan

ChangeSet: CHG-371

- [x] 구현 완료

## 검증 방법
- 집중 검증 사용.

## 완료 조건
- 체크리스트와 검증 증거 완료.

## 검증 결과
- Build: PASS `.harness/runs/run-374/evidence.txt`
- Tests: PASS `.harness/runs/run-374/evidence.txt`
- E2E 또는 maintenance verification: PASS `.harness/runs/run-374/evidence.txt`
- Test gate: PASS `.harness/runs/run-374/evidence.txt`
- Runtime server verification: PASS `.harness/runs/run-374/evidence.txt`
- Static analysis: PASS `.harness/runs/run-374/evidence.txt`
""",
        encoding="utf-8",
    )


def _change_set_and_scopes(tmp_path: Path) -> tuple[ChangeSet, tuple[PlanningInputScope, ...]]:
    use_cases = (
        AffectedUseCase(
            uc_id="UC-371-A",
            name="first user flow",
            impact_type="source-code, user-feature",
            slice_path=Path("docs/use-cases/UC-371-A"),
        ),
        AffectedUseCase(
            uc_id="UC-371-B",
            name="second user flow",
            impact_type="source-code, user-feature",
            slice_path=Path("docs/use-cases/UC-371-B"),
        ),
    )
    work_items = tuple(
        AffectedWorkItem(
            work_item_id=use_case.uc_id,
            work_item_type=WorkItemType.USE_CASE,
            name=use_case.name,
            impact_type=use_case.impact_type,
            slice_path=use_case.slice_path,
        )
        for use_case in use_cases
    )
    change_set = ChangeSet(
        change_set_id="CHG-371",
        title="two use-case session",
        path=Path("docs/changes/active/CHG-371.md"),
        affected_use_cases=use_cases,
        affected_work_items=work_items,
    )
    scopes = tuple(
        PlanningInputScope(
            change_set_path=change_set.path,
            use_case=use_case,
            planner_inputs=(),
            executor_inputs=(),
            e2e_goal_path=Path(f"docs/use-cases/{use_case.uc_id}/e2e-goal.md"),
            work_item_id=use_case.uc_id,
            work_item_type=WorkItemType.USE_CASE,
            impact_type=use_case.impact_type,
            plan_path=Path(f"docs/plans/active/{use_case.uc_id}/plan.md"),
            verification_goal_path=Path(f"docs/use-cases/{use_case.uc_id}/e2e-goal.md"),
        )
        for use_case in use_cases
    )
    for scope in scopes:
        plan = tmp_path / scope.plan_path
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(f"# {scope.display_id} plan\n", encoding="utf-8")
    return change_set, scopes


def _git(repo_root: Path, *args: str) -> None:
    completed = __import__("subprocess").run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
