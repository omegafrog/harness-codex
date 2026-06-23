"""Two-layer ChangeSet execution orchestration.

A ChangeSet is a session and delivery unit.  Each selected work item runs only its
own planning, implementation, verification, and plan-completion workflow.  Once
all work-item plans are completed, a separate ChangeSet finalization workflow runs
exactly once for delivery and completion.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from harness_codex.runtime.changes.models import ChangeSet
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import FailureKind, RunContext, RunMode, RunResult, RunStatus
from harness_codex.runtime.reports import ReportWriter, RunReport, WorkItemReport
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.state import RunFailureKind, RunState, RunStateStore, UseCaseLoopState, WorkItemLoopState
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
    write_materialized_workflow_manifest,
)

WORK_ITEM_WORKFLOW_NAME = "changeset-use-case-workflow"
FINALIZATION_WORKFLOW_NAME = "changeset-finalization-workflow"
SESSION_WORKFLOW_NAME = "changeset-session"


def apply_workflow(
    repo_root: Path,
    change_set: ChangeSet,
    scopes: tuple,
    *,
    run_id: str | None = None,
    force_verification: bool = False,
    rollback_mode: str = "none",
):
    """Run work items first, then run ChangeSet finalization once when eligible."""

    if not scopes:
        raise RuntimeError("workflow execution requires at least one ChangeSet work item")

    run_id = run_id or f"run-{uuid4().hex[:12]}"
    run_dir = repo_root / ".harness/runs" / run_id
    workflows_dir = _workflows_dir(repo_root)
    work_item_workflow = load_named_workflow(WORK_ITEM_WORKFLOW_NAME, workflows_dir=workflows_dir)
    finalization_workflow = load_named_workflow(FINALIZATION_WORKFLOW_NAME, workflows_dir=workflows_dir)
    engine = RunnerEngine(BasicStepRunner())

    affected_use_cases = tuple(scope.use_case.uc_id for scope in scopes if scope.use_case is not None)
    affected_work_items = tuple(scope.display_id for scope in scopes)
    results: dict[str, RunResult] = {}
    failed_scope = None

    for scope in scopes:
        materialized = materialize_workflow_for_scope(
            work_item_workflow,
            change_set,
            scope,
            run_id=run_id,
        )
        write_materialized_workflow_manifest(
            materialized,
            run_dir / "work-items" / scope.display_id / "workflow.json",
        )
        context = _work_item_context(
            repo_root,
            run_dir,
            change_set,
            scopes,
            scope,
            workflow_name=materialized.name,
            force_verification=force_verification,
            rollback_mode=rollback_mode,
        )
        result = engine.run(materialized, context)
        results[scope.display_id] = result
        if result.status is not RunStatus.SUCCEEDED:
            failed_scope = scope
            break

    finalization_result: RunResult | None = None
    if failed_scope is None and _all_work_item_plans_completed(repo_root, scopes):
        final_scope = scopes[-1]
        materialized = materialize_workflow_for_scope(
            finalization_workflow,
            change_set,
            final_scope,
            run_id=run_id,
        )
        write_materialized_workflow_manifest(
            materialized,
            run_dir / "finalization" / "workflow.json",
        )
        finalization_result = engine.run(
            materialized,
            _finalization_context(
                repo_root,
                run_dir,
                change_set,
                scopes,
                final_scope,
                workflow_name=materialized.name,
                force_verification=force_verification,
                rollback_mode=rollback_mode,
            ),
        )
        _write_finalization_report(repo_root, run_id, finalization_result)

    overall = finalization_result or results[failed_scope.display_id] if failed_scope is not None else _missing_finalization_result(change_set, scopes)
    state = _build_state(
        run_id=run_id,
        change_set=change_set,
        scopes=scopes,
        results=results,
        failed_scope=failed_scope,
        finalization_result=finalization_result,
        overall=overall,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
    )
    RunStateStore(repo_root).save(state)
    _write_session_report(
        repo_root,
        run_id=run_id,
        change_set=change_set,
        scopes=scopes,
        results=results,
        finalization_result=finalization_result,
        overall=overall,
        affected_use_cases=affected_use_cases,
    )
    return state, overall


def _workflows_dir(repo_root: Path) -> Path:
    candidate = repo_root / ".harness/workflows"
    if (candidate / f"{WORK_ITEM_WORKFLOW_NAME}.yaml").exists():
        return candidate
    return Path(__file__).resolve().parents[2] / ".harness/workflows"


def _work_item_context(
    repo_root: Path,
    run_dir: Path,
    change_set: ChangeSet,
    scopes: tuple,
    scope,
    *,
    workflow_name: str,
    force_verification: bool,
    rollback_mode: str,
) -> RunContext:
    return RunContext(
        run_id=run_dir.name,
        workflow_name=workflow_name,
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=run_dir / "work-items" / scope.display_id,
        metadata={
            **_shared_context_metadata(change_set, scopes, scope, force_verification, rollback_mode),
            "execution_boundary": "work_item",
            "skip_precompleted_work_item_steps": _work_item_plan_completed(repo_root, scope),
        },
    )


def _finalization_context(
    repo_root: Path,
    run_dir: Path,
    change_set: ChangeSet,
    scopes: tuple,
    scope,
    *,
    workflow_name: str,
    force_verification: bool,
    rollback_mode: str,
) -> RunContext:
    return RunContext(
        run_id=run_dir.name,
        workflow_name=workflow_name,
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=run_dir / "finalization",
        metadata={
            **_shared_context_metadata(change_set, scopes, scope, force_verification, rollback_mode),
            "execution_boundary": "changeset_finalization",
            "all_work_item_plans_completed": True,
            "skip_precompleted_work_item_steps": False,
        },
    )


def _shared_context_metadata(
    change_set: ChangeSet,
    scopes: tuple,
    scope,
    force_verification: bool,
    rollback_mode: str,
) -> dict[str, object]:
    return {
        "change_set_id": change_set.change_set_id,
        "change_set_path": str(change_set.path or Path(f"docs/changes/active/{change_set.change_set_id}.md")),
        "active_work_item_id": scope.display_id,
        "active_work_item_type": scope.work_item_type.value,
        "active_plan_path": str(_active_plan_path(scope)),
        "verification_goal_path": str(scope.verification_goal_path) if scope.verification_goal_path else None,
        "force_verification": force_verification,
        "rollback_mode": rollback_mode,
        "affected_work_items": [
            {
                "id": item.display_id,
                "type": item.work_item_type.value,
                "plan_path": str(_active_plan_path(item)),
                "planner_inputs": [str(path) for path in item.planner_inputs],
                "executor_inputs": [str(path) for path in item.executor_inputs],
                "verification_goal_path": str(item.verification_goal_path) if item.verification_goal_path else None,
            }
            for item in scopes
        ],
    }


def _build_state(
    *,
    run_id: str,
    change_set: ChangeSet,
    scopes: tuple,
    results: Mapping[str, RunResult],
    failed_scope,
    finalization_result: RunResult | None,
    overall: RunResult,
    affected_use_cases: tuple[str, ...],
    affected_work_items: tuple[str, ...],
) -> RunState:
    completed = tuple(scope.display_id for scope in scopes if _work_item_completed_from_result(scope, results))
    blocked = tuple(
        scope.display_id
        for scope in scopes
        if scope.display_id in results and results[scope.display_id].status is not RunStatus.SUCCEEDED
    )
    current_scope = failed_scope
    decisions = {
        work_item_id: tuple(result.metadata.get("decisions", ()))
        for work_item_id, result in results.items()
        if result.metadata.get("decisions")
    }
    decisions["changeset_finalization"] = _finalization_summary(finalization_result, completed, affected_work_items)
    return RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name=SESSION_WORKFLOW_NAME,
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current_use_case_id=(current_scope.use_case.uc_id if current_scope is not None and current_scope.use_case is not None else None),
        current_work_item_id=current_scope.display_id if current_scope is not None else None,
        completed_use_cases=tuple(
            scope.use_case.uc_id
            for scope in scopes
            if scope.use_case is not None and scope.display_id in completed
        ),
        completed_work_items=completed,
        blocked_use_cases=tuple(
            scope.use_case.uc_id
            for scope in scopes
            if scope.use_case is not None and scope.display_id in blocked
        ),
        blocked_work_items=blocked,
        failed_step_id=overall.failed_step_id,
        failure_kind=_run_failure_kind(overall.failure_kind),
        status=overall.status,
        decision_results=decisions,
        work_item_states=tuple(_work_item_state(scope, results.get(scope.display_id)) for scope in scopes),
        use_case_states=tuple(
            _use_case_state(scope, results.get(scope.display_id))
            for scope in scopes
            if scope.use_case is not None
        ),
    )


def _work_item_state(scope, result: RunResult | None) -> WorkItemLoopState:
    return WorkItemLoopState(
        work_item_id=scope.display_id,
        work_item_type=scope.work_item_type,
        active_plan_path=_active_plan_path(scope),
        status=result.status if result is not None else RunStatus.PENDING,
        current_step_id=scope.current_stage,
        verification_status=result.status.value if result is not None else "pending",
        retry_count=result.retry_count if result is not None else 0,
        failure_kind=_run_failure_kind(result.failure_kind) if result is not None else None,
        blocker=result.blocker if result is not None else None,
    )


def _use_case_state(scope, result: RunResult | None) -> UseCaseLoopState:
    return UseCaseLoopState(
        uc_id=scope.use_case.uc_id,
        active_plan_path=_active_plan_path(scope),
        status=result.status if result is not None else RunStatus.PENDING,
        retry_count=result.retry_count if result is not None else 0,
        failure_kind=_run_failure_kind(result.failure_kind) if result is not None else None,
        blocker=result.blocker if result is not None else None,
    )


def _write_session_report(
    repo_root: Path,
    *,
    run_id: str,
    change_set: ChangeSet,
    scopes: tuple,
    results: Mapping[str, RunResult],
    finalization_result: RunResult | None,
    overall: RunResult,
    affected_use_cases: tuple[str, ...],
) -> None:
    finalization_path = Path(".harness/runs") / run_id / "finalization" / "report.json"
    ReportWriter(repo_root).write(
        RunReport(
            run_id=run_id,
            change_set_id=change_set.change_set_id,
            workflow_name=SESSION_WORKFLOW_NAME,
            mode=RunMode.APPLY,
            status=overall.status,
            affected_use_cases=affected_use_cases,
            completed_use_cases=tuple(
                scope.use_case.uc_id
                for scope in scopes
                if scope.use_case is not None and _work_item_completed_from_result(scope, results)
            ),
            blocked_use_cases=tuple(
                scope.use_case.uc_id
                for scope in scopes
                if scope.use_case is not None
                and scope.display_id in results
                and results[scope.display_id].status is not RunStatus.SUCCEEDED
            ),
            report_paths={"changeset_finalization": finalization_path},
            artifact_paths={"changeset_finalization": finalization_path},
            work_item_reports=tuple(
                WorkItemReport(
                    work_item_id=scope.display_id,
                    work_item_type=scope.work_item_type,
                    active_plan_path=_active_plan_path(scope),
                    completed_plan_path=_completed_plan_path(scope.display_id) if _work_item_completed_from_result(scope, results) else None,
                    status=results[scope.display_id].status if scope.display_id in results else RunStatus.PENDING,
                    current_stage="completed" if _work_item_completed_from_result(scope, results) else scope.current_stage,
                    verification_goal_path=scope.verification_goal_path,
                    blocker=results[scope.display_id].blocker if scope.display_id in results else None,
                    verification_result=results[scope.display_id].status.value if scope.display_id in results else "pending",
                )
                for scope in scopes
            ),
        )
    )


def _write_finalization_report(repo_root: Path, run_id: str, result: RunResult) -> None:
    directory = repo_root / ".harness/runs" / run_id / "finalization"
    directory.mkdir(parents=True, exist_ok=True)
    payload = {
        "workflow": FINALIZATION_WORKFLOW_NAME,
        "status": result.status.value,
        "failed_step_id": result.failed_step_id,
        "failure_kind": result.failure_kind.value if result.failure_kind is not None else None,
        "blocker": result.blocker,
        "step_results": [
            {"step_id": step.step_id, "status": step.status.value, "error": step.error}
            for step in result.step_results
        ],
    }
    (directory / "report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# ChangeSet Finalization",
        "",
        f"- Workflow: {FINALIZATION_WORKFLOW_NAME}",
        f"- Status: {result.status.value}",
        f"- Failed step: {result.failed_step_id or '-'}",
        f"- Blocker: {result.blocker or '-'}",
    ]
    (directory / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _finalization_summary(
    result: RunResult | None,
    completed: tuple[str, ...],
    affected: tuple[str, ...],
) -> dict[str, object]:
    return {
        "workflow": FINALIZATION_WORKFLOW_NAME,
        "eligible": len(completed) == len(affected),
        "status": result.status.value if result is not None else "not_started",
        "failed_step_id": result.failed_step_id if result is not None else None,
        "blocker": result.blocker if result is not None else None,
    }


def _missing_finalization_result(change_set: ChangeSet, scopes: tuple) -> RunResult:
    return RunResult(
        run_id="",
        status=RunStatus.BLOCKED,
        mode=RunMode.APPLY,
        blocker=(
            f"ChangeSet {change_set.change_set_id} cannot finalize because one or more work-item plans are incomplete: "
            + ", ".join(scope.display_id for scope in scopes if not _work_item_plan_completed(Path("."), scope))
        ),
    )


def _work_item_completed_from_result(scope, results: Mapping[str, RunResult]) -> bool:
    result = results.get(scope.display_id)
    return result is not None and result.status is RunStatus.SUCCEEDED


def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:
    return bool(scopes) and all(_work_item_plan_completed(repo_root, scope) for scope in scopes)


def _work_item_plan_completed(repo_root: Path, scope) -> bool:
    return (repo_root / _completed_plan_path(scope.display_id)).exists() and not (repo_root / _active_plan_path(scope)).exists()


def _active_plan_path(scope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(work_item_id: str) -> Path:
    return Path(f"docs/plans/completed/{work_item_id}/plan.md")


def _run_failure_kind(failure_kind: FailureKind | None) -> RunFailureKind | None:
    mapping = {
        FailureKind.IMPLEMENTATION: RunFailureKind.IMPLEMENTATION_FAILURE,
        FailureKind.UPSTREAM_DESIGN: RunFailureKind.UPSTREAM_DESIGN_CONFLICT,
        FailureKind.ENVIRONMENT_BLOCKER: RunFailureKind.ENVIRONMENT_BLOCKER,
        FailureKind.UNCLEAR_E2E_GOAL: RunFailureKind.UNCLEAR_E2E_GOAL,
        FailureKind.DOCUMENT_DELTA_CONFLICT: RunFailureKind.DOCUMENT_DELTA_CONFLICT,
        FailureKind.SCOPE_CONFLICT: RunFailureKind.SCOPE_CONFLICT,
        FailureKind.PLAN_REVIEW_REJECTED: RunFailureKind.PLAN_REVIEW_REJECTED,
        FailureKind.VERIFICATION_GOAL_UNCLEAR: RunFailureKind.VERIFICATION_GOAL_UNCLEAR,
        FailureKind.UNKNOWN: RunFailureKind.UNCLEAR_E2E_GOAL,
    }
    return mapping.get(failure_kind)
