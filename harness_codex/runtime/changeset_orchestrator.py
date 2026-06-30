"""Two-layer ChangeSet execution orchestration.

A ChangeSet is a session and delivery unit. Each work item runs only its own plan,
implementation, verification, and plan-completion workflow. A separate finalization
workflow runs exactly once after every work-item plan is completed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Mapping
from uuid import uuid4

from harness_codex.runtime.changes.models import ChangeSet
from harness_codex.runtime.completion import plan_completion_status
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import FailureKind, RunContext, RunMode, RunResult, RunStatus
from harness_codex.runtime.reports import ReportWriter, RunReport, WorkItemReport
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.state import (
    RunFailureKind,
    RunState,
    RunStateStore,
    UseCaseLoopState,
    WorkItemLoopState,
)
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
    write_materialized_workflow_manifest,
)

WORK_ITEM_WORKFLOW_NAME = "changeset-use-case-workflow"
FINALIZATION_WORKFLOW_NAME = "changeset-finalization-workflow"
SESSION_WORKFLOW_NAME = "changeset-session"


class WorkflowBoundaryError(RuntimeError):
    """Raised when a workflow contains steps from the other execution boundary."""


def apply_workflow(
    repo_root: Path,
    change_set: ChangeSet,
    scopes: tuple,
    *,
    run_id: str | None = None,
    force_verification: bool = False,
    rollback_mode: str = "none",
    workflow_loader: Callable = load_named_workflow,
    workflow_materializer: Callable = materialize_workflow_for_scope,
    manifest_writer: Callable = write_materialized_workflow_manifest,
    engine_factory: Callable[[], object] | None = None,
    emit: Callable[[str], None] | None = None,
):
    """Execute unfinished work items, then finalize the ChangeSet once.

    Completion is established by durable plan locations, not a last-work-item
    metadata convention. A work-item workflow cannot contain ChangeSet delivery
    steps; finalization is materialized and run only after every plan is complete.
    """

    if not scopes:
        raise RuntimeError("workflow execution requires at least one ChangeSet work item")

    run_id = run_id or f"run-{uuid4().hex[:12]}"
    run_dir = repo_root / ".harness/runs" / run_id
    workflows_dir = _workflows_dir(repo_root)
    work_item_workflow = workflow_loader(
        WORK_ITEM_WORKFLOW_NAME,
        workflows_dir=workflows_dir,
    )
    finalization_workflow = workflow_loader(
        FINALIZATION_WORKFLOW_NAME,
        workflows_dir=workflows_dir,
    )
    _assert_workflow_boundary(work_item_workflow, "work_item")
    _assert_workflow_boundary(finalization_workflow, "changeset_finalization")

    engine = engine_factory() if engine_factory is not None else RunnerEngine(BasicStepRunner())
    results: dict[str, RunResult] = {}
    failed_scope = None

    for index, scope in enumerate(scopes, start=1):
        if _work_item_plan_completed(repo_root, scope):
            result = _completed_work_item_result(run_id)
            results[scope.display_id] = result
            if emit is not None:
                emit(_execution_result_line(scope, result, index=index, total=len(scopes)))
            continue

        completion_only = _work_item_plan_ready_to_complete(
            repo_root,
            change_set.change_set_id,
            scope,
        )
        if emit is not None:
            emit(_execution_start_line(scope, index, len(scopes)))
        materialized = _materialize(
            workflow_materializer,
            work_item_workflow,
            change_set,
            scope,
            run_id,
        )
        manifest_writer(
            materialized,
            run_dir / "work-items" / scope.display_id / "workflow.json",
        )
        result = engine.run(
            materialized,
            _context(
                repo_root,
                run_dir,
                change_set,
                scopes,
                scope,
                workflow_name=materialized.name,
                boundary="work_item",
                force_verification=force_verification,
                rollback_mode=rollback_mode,
                completion_only=completion_only,
            ),
        )
        results[scope.display_id] = result
        if emit is not None:
            emit(_execution_result_line(scope, result))
        if result.status is not RunStatus.SUCCEEDED:
            failed_scope = scope
            break

    finalization_result: RunResult | None = None
    if failed_scope is None and _all_work_item_plans_completed(repo_root, scopes):
        final_scope = scopes[-1]
        materialized = _materialize(
            workflow_materializer,
            finalization_workflow,
            change_set,
            final_scope,
            run_id,
        )
        manifest_writer(materialized, run_dir / "finalization" / "workflow.json")
        finalization_result = engine.run(
            materialized,
            _context(
                repo_root,
                run_dir,
                change_set,
                scopes,
                final_scope,
                workflow_name=materialized.name,
                boundary="changeset_finalization",
                force_verification=force_verification,
                rollback_mode=rollback_mode,
            ),
        )
        _write_finalization_report(repo_root, run_id, finalization_result)

    if failed_scope is not None:
        overall = results[failed_scope.display_id]
    elif finalization_result is not None:
        overall = finalization_result
    else:
        overall = _blocked_finalization_result(run_id, change_set)
        _write_finalization_report(repo_root, run_id, overall)

    state = _build_state(
        repo_root=repo_root,
        run_id=run_id,
        change_set=change_set,
        scopes=scopes,
        results=results,
        failed_scope=failed_scope,
        finalization_result=finalization_result,
        overall=overall,
    )
    RunStateStore(repo_root).save(state)
    _write_session_report(repo_root, run_id, change_set, scopes, results, overall)
    return state, overall


def _assert_workflow_boundary(workflow, boundary: str) -> None:
    expected_scope = "work_item" if boundary == "work_item" else "change_set"
    violations = []
    for step in workflow.steps:
        scope = step.metadata.get("scope")
        step_boundary = step.metadata.get("execution_boundary")
        if scope != expected_scope or step_boundary != boundary:
            violations.append(
                f"{step.id}(scope={scope!r}, execution_boundary={step_boundary!r})"
            )
    if violations:
        raise WorkflowBoundaryError(
            f"{workflow.name} violates {boundary} boundary: {', '.join(violations)}"
        )


def _completed_work_item_result(run_id: str) -> RunResult:
    return RunResult(
        run_id=run_id,
        status=RunStatus.SUCCEEDED,
        step_results=(),
        mode=RunMode.APPLY,
        metadata={"resumed_from_completed_plan": True},
    )


def _materialize(materializer: Callable, workflow, change_set: ChangeSet, scope, run_id: str):
    try:
        return materializer(workflow, change_set, scope, run_id=run_id)
    except TypeError as exc:
        if "run_id" not in str(exc) or "unexpected keyword argument" not in str(exc):
            raise
        return materializer(workflow, change_set, scope)


def _workflows_dir(repo_root: Path) -> Path:
    candidate = repo_root / ".harness/workflows"
    if (
        (candidate / f"{WORK_ITEM_WORKFLOW_NAME}.yaml").exists()
        and (candidate / f"{FINALIZATION_WORKFLOW_NAME}.yaml").exists()
    ):
        return candidate
    return Path(__file__).resolve().parents[2] / ".harness/workflows"


def _context(
    repo_root: Path,
    run_dir: Path,
    change_set: ChangeSet,
    scopes: tuple,
    scope,
    *,
    workflow_name: str,
    boundary: str,
    force_verification: bool,
    rollback_mode: str,
    completion_only: bool = False,
) -> RunContext:
    run_subdir = (
        Path("finalization")
        if boundary == "changeset_finalization"
        else Path("work-items") / scope.display_id
    )
    return RunContext(
        run_id=run_dir.name,
        workflow_name=workflow_name,
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=run_dir / run_subdir,
        metadata={
            "execution_boundary": boundary,
            "change_set_id": change_set.change_set_id,
            "change_set_path": str(
                change_set.path or Path(f"docs/changes/active/{change_set.change_set_id}.md")
            ),
            "active_work_item_id": scope.display_id,
            "active_work_item_type": scope.work_item_type.value,
            "active_plan_path": str(_active_plan_path(scope)),
            "verification_goal_path": (
                str(scope.verification_goal_path) if scope.verification_goal_path else None
            ),
            "force_verification": force_verification,
            "rollback_mode": rollback_mode,
            "run_ready_work_item_completion_only": completion_only,
            "all_work_item_plans_completed": boundary == "changeset_finalization",
            "affected_work_items": [
                {
                    "id": item.display_id,
                    "type": item.work_item_type.value,
                    "plan_path": str(_active_plan_path(item)),
                    "verification_goal_path": (
                        str(item.verification_goal_path)
                        if item.verification_goal_path
                        else None
                    ),
                }
                for item in scopes
            ],
        },
    )


def _execution_start_line(scope, index: int, total: int) -> str:
    label = "Use case" if scope.use_case is not None else "Work item"
    name = scope.use_case.name if scope.use_case is not None else scope.display_id
    return f"{label} execution start: {scope.display_id} - {name} ({index}/{total})"


def _execution_result_line(
    scope,
    result: RunResult,
    *,
    index: int | None = None,
    total: int | None = None,
) -> str:
    label = "Use case" if scope.use_case is not None else "Work item"
    name = scope.use_case.name if scope.use_case is not None else scope.display_id
    if result.metadata.get("resumed_from_completed_plan"):
        position = f" ({index}/{total})" if index is not None and total is not None else ""
        return (
            f"{label} execution skipped: {scope.display_id} - {name}{position} "
            "reason=completed_plan"
        )
    details = f"{label} execution result: {scope.display_id} - {name} status={result.status.value}"
    if result.failed_step_id:
        details += f" failed_step={result.failed_step_id}"
    if result.failure_kind is not None:
        details += f" failure_kind={result.failure_kind.value}"
    if result.blocker:
        details += f" blocker={result.blocker}"
    return details


def _build_state(
    *,
    repo_root: Path,
    run_id: str,
    change_set: ChangeSet,
    scopes: tuple,
    results: Mapping[str, RunResult],
    failed_scope,
    finalization_result: RunResult | None,
    overall: RunResult,
) -> RunState:
    completed = tuple(
        scope.display_id for scope in scopes if _work_item_plan_completed(repo_root, scope)
    )
    blocked = tuple(
        scope.display_id
        for scope in scopes
        if scope.display_id in results and results[scope.display_id].status is not RunStatus.SUCCEEDED
    )
    affected_use_cases = tuple(
        scope.use_case.uc_id for scope in scopes if scope.use_case is not None
    )
    decisions: dict[str, object] = {
        work_item_id: tuple(result.metadata.get("decisions", ()))
        for work_item_id, result in results.items()
        if result.metadata.get("decisions")
    }
    decisions["changeset_finalization"] = {
        "workflow": FINALIZATION_WORKFLOW_NAME,
        "eligible": len(completed) == len(scopes),
        "status": finalization_result.status.value if finalization_result else "not_started",
        "failed_step_id": finalization_result.failed_step_id if finalization_result else None,
        "blocker": finalization_result.blocker if finalization_result else None,
        "report": f".harness/runs/{run_id}/finalization/report.json",
    }
    return RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name=SESSION_WORKFLOW_NAME,
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=tuple(scope.display_id for scope in scopes),
        current_use_case_id=(
            failed_scope.use_case.uc_id
            if failed_scope is not None and failed_scope.use_case is not None
            else None
        ),
        current_work_item_id=failed_scope.display_id if failed_scope is not None else None,
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
        work_item_states=tuple(
            _work_item_state(scope, results.get(scope.display_id)) for scope in scopes
        ),
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
    run_id: str,
    change_set: ChangeSet,
    scopes: tuple,
    results: Mapping[str, RunResult],
    overall: RunResult,
) -> None:
    affected_use_cases = tuple(
        scope.use_case.uc_id for scope in scopes if scope.use_case is not None
    )
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
                if scope.use_case is not None and _work_item_plan_completed(repo_root, scope)
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
                    completed_plan_path=(
                        _completed_plan_path(scope.display_id)
                        if _work_item_plan_completed(repo_root, scope)
                        else None
                    ),
                    status=(
                        results[scope.display_id].status
                        if scope.display_id in results
                        else RunStatus.PENDING
                    ),
                    current_stage=(
                        "completed"
                        if _work_item_plan_completed(repo_root, scope)
                        else scope.current_stage
                    ),
                    verification_goal_path=scope.verification_goal_path,
                    blocker=(
                        results[scope.display_id].blocker
                        if scope.display_id in results
                        else None
                    ),
                    verification_result=(
                        results[scope.display_id].status.value
                        if scope.display_id in results
                        else "pending"
                    ),
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
        "failure_kind": result.failure_kind.value if result.failure_kind else None,
        "blocker": result.blocker,
        "step_results": [
            {"step_id": step.step_id, "status": step.status.value, "error": step.error}
            for step in result.step_results
        ],
    }
    (directory / "report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (directory / "report.md").write_text(
        "\n".join(
            (
                "# ChangeSet Finalization",
                "",
                f"- Workflow: {FINALIZATION_WORKFLOW_NAME}",
                f"- Status: {result.status.value}",
                f"- Failed step: {result.failed_step_id or '-'}",
                f"- Blocker: {result.blocker or '-'}",
            )
        )
        + "\n",
        encoding="utf-8",
    )


def _blocked_finalization_result(run_id: str, change_set: ChangeSet) -> RunResult:
    return RunResult(
        run_id=run_id,
        status=RunStatus.BLOCKED,
        step_results=(),
        mode=RunMode.APPLY,
        failed_step_id="verify-all-work-items-completed",
        blocker=(
            f"ChangeSet {change_set.change_set_id} cannot finalize because one or more "
            "work-item plans are incomplete"
        ),
    )


def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:
    return bool(scopes) and all(
        _work_item_plan_completed(repo_root, scope) for scope in scopes
    )


def _work_item_plan_completed(repo_root: Path, scope) -> bool:
    return (
        (repo_root / _completed_plan_path(scope.display_id)).exists()
        and not (repo_root / _active_plan_path(scope)).exists()
    )


def _work_item_plan_ready_to_complete(repo_root: Path, change_set_id: str, scope) -> bool:
    active_plan = _active_plan_path(scope)
    if not (repo_root / active_plan).exists():
        return False
    status = plan_completion_status(
        repo_root,
        active_plan,
        change_set_id=change_set_id,
        work_item_id=scope.display_id,
    )
    return status.ready


def _active_plan_path(scope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(work_item_id: str) -> Path:
    return Path(f"docs/plans/completed/{work_item_id}/plan.md")


def _run_failure_kind(failure_kind: FailureKind | None) -> RunFailureKind | None:
    return {
        FailureKind.IMPLEMENTATION: RunFailureKind.IMPLEMENTATION_FAILURE,
        FailureKind.UPSTREAM_DESIGN: RunFailureKind.UPSTREAM_DESIGN_CONFLICT,
        FailureKind.ENVIRONMENT_BLOCKER: RunFailureKind.ENVIRONMENT_BLOCKER,
        FailureKind.UNCLEAR_E2E_GOAL: RunFailureKind.UNCLEAR_E2E_GOAL,
        FailureKind.DOCUMENT_DELTA_CONFLICT: RunFailureKind.DOCUMENT_DELTA_CONFLICT,
        FailureKind.SCOPE_CONFLICT: RunFailureKind.SCOPE_CONFLICT,
        FailureKind.PLAN_REVIEW_REJECTED: RunFailureKind.PLAN_REVIEW_REJECTED,
        FailureKind.VERIFICATION_GOAL_UNCLEAR: RunFailureKind.VERIFICATION_GOAL_UNCLEAR,
        FailureKind.UNKNOWN: RunFailureKind.UNCLEAR_E2E_GOAL,
    }.get(failure_kind)
