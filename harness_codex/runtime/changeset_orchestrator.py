"""Two-layer ChangeSet execution orchestration.

A ChangeSet is a session and delivery unit. Each work item runs only its own plan,
implementation, verification, and plan-completion workflow. A separate finalization
workflow runs exactly once after every work-item plan is completed.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Mapping
from uuid import uuid4

from harness_codex.runtime.changes.models import ChangeSet
from harness_codex.runtime.completion import plan_completion_status
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    RunResult,
    RunStatus,
    StepStatus,
)
from harness_codex.runtime.reports import ReportWriter, RunReport, WorkItemReport
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.state import (
    ArtifactDirtyState,
    RunFailureKind,
    RunState,
    RunStateStore,
    StageArtifactState,
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


@dataclass(frozen=True)
class WorktreeIsolation:
    source_root: Path
    integration_root: Path
    integration_branch: str
    work_item_roots: Mapping[str, Path]
    work_item_branches: Mapping[str, str]


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
    isolation = _prepare_changeset_worktrees(repo_root, change_set.change_set_id, run_id)
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
        scope_repo = _work_item_repo_root(isolation, scope)
        context_repo = scope_repo or repo_root
        if _work_item_plan_completed(context_repo, scope):
            result = _completed_work_item_result(run_id)
            results[scope.display_id] = result
            if emit is not None:
                emit(_execution_result_line(scope, result, index=index, total=len(scopes)))
            continue

        completion_only = _work_item_plan_ready_to_complete(
            context_repo,
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
                context_repo,
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
        if result.status is RunStatus.SUCCEEDED and isolation is not None:
            result = _commit_and_merge_work_item(
                isolation,
                scope,
                result,
                change_set_id=change_set.change_set_id,
            )
        results[scope.display_id] = result
        if emit is not None:
            emit(_execution_result_line(scope, result))
        if result.status is not RunStatus.SUCCEEDED:
            failed_scope = scope
            break

    finalization_result: RunResult | None = None
    final_repo = isolation.integration_root if isolation is not None else repo_root
    if failed_scope is None and _all_work_item_plans_completed(final_repo, scopes):
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
                final_repo,
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
        finalization_result = _normalize_delivery_approval_pending(finalization_result)
        _write_finalization_report(repo_root, run_id, finalization_result)

    if failed_scope is not None:
        overall = results[failed_scope.display_id]
    elif finalization_result is not None:
        overall = finalization_result
    else:
        overall = _blocked_finalization_result(run_id, change_set)
        _write_finalization_report(repo_root, run_id, overall)

    state = _build_state(
        repo_root=final_repo,
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


def _prepare_changeset_worktrees(
    repo_root: Path,
    change_set_id: str,
    run_id: str,
) -> WorktreeIsolation | None:
    if not _is_git_worktree(repo_root):
        return None
    safe_change = _safe_ref_part(change_set_id)
    safe_run = _safe_ref_part(run_id)
    base_dir = repo_root.parent / f".{repo_root.name}-harness-worktrees" / safe_change / safe_run
    integration_branch = f"harness/{safe_change}/{safe_run}/delivery"
    integration_root = base_dir / "delivery"
    _add_worktree(repo_root, integration_root, integration_branch, "HEAD")
    _hydrate_runtime_worktree(repo_root, integration_root, copy_project_docs=True)
    return WorktreeIsolation(
        source_root=repo_root,
        integration_root=integration_root,
        integration_branch=integration_branch,
        work_item_roots={},
        work_item_branches={},
    )


def _work_item_repo_root(isolation: WorktreeIsolation | None, scope) -> Path | None:
    if isolation is None:
        return None
    existing = isolation.work_item_roots.get(scope.display_id)
    if existing is not None:
        return existing
    safe_item = _safe_ref_part(scope.display_id)
    branch_prefix = _safe_ref_part(isolation.integration_branch.replace("/", "-"))
    branch = f"harness/{branch_prefix}/{safe_item}"
    root = isolation.integration_root.parent / "work-items" / safe_item
    _add_worktree(isolation.source_root, root, branch, isolation.integration_branch)
    _hydrate_runtime_worktree(isolation.source_root, root, copy_project_docs=True)
    isolation.work_item_roots[scope.display_id] = root
    isolation.work_item_branches[scope.display_id] = branch
    return root


def _commit_and_merge_work_item(
    isolation: WorktreeIsolation,
    scope,
    result: RunResult,
    *,
    change_set_id: str,
) -> RunResult:
    worktree = isolation.work_item_roots[scope.display_id]
    branch = isolation.work_item_branches[scope.display_id]
    commit = _commit_if_dirty(worktree, f"{change_set_id} {scope.display_id} 구현 완료")
    if commit.returncode != 0:
        return _blocked_isolation_result(result, "work-item commit failed", commit)
    merge = _git(
        isolation.integration_root,
        "merge",
        "--no-ff",
        "--no-edit",
        branch,
        check=False,
    )
    if merge.returncode != 0:
        return _blocked_isolation_result(result, "work-item merge failed", merge)
    return replace(
        result,
        metadata={
            **dict(result.metadata),
            "worktree_root": str(worktree),
            "worktree_branch": branch,
            "integration_worktree": str(isolation.integration_root),
            "integration_branch": isolation.integration_branch,
        },
    )


def _blocked_isolation_result(
    result: RunResult,
    message: str,
    completed: subprocess.CompletedProcess[str],
) -> RunResult:
    detail = completed.stderr.strip() or completed.stdout.strip() or message
    return replace(
        result,
        status=RunStatus.BLOCKED,
        failed_step_id=result.failed_step_id or "worktree-isolation",
        blocker=f"{message}: {detail}",
        metadata={**dict(result.metadata), "worktree_isolation_error": detail},
    )


def _commit_if_dirty(repo_root: Path, message: str) -> subprocess.CompletedProcess[str]:
    _remove_runtime_links(repo_root)
    status = _git(repo_root, "status", "--porcelain=v1", "-z", check=False)
    if status.returncode != 0 or not status.stdout:
        return status
    paths = _committable_status_paths(status.stdout)
    if not paths:
        return subprocess.CompletedProcess(["git", "status", "--porcelain=v1", "-z"], 0, "", "")
    added = _git(repo_root, "add", "--", *paths, check=False)
    if added.returncode != 0:
        return added
    staged = _git(repo_root, "diff", "--cached", "--quiet", check=False)
    if staged.returncode == 0:
        return subprocess.CompletedProcess(["git", "diff", "--cached", "--quiet"], 0, "", "")
    if staged.returncode not in {0, 1}:
        return staged
    return _git(repo_root, "commit", "-m", message, check=False)


def _remove_runtime_links(repo_root: Path) -> None:
    for relative in (
        Path(".harness/runs"),
        Path(".harness/workflows"),
        Path(".codex/agents"),
        Path(".codex/skills"),
        Path("harness"),
        Path("harness_codex"),
    ):
        target = repo_root / relative
        if target.is_symlink():
            target.unlink()


def _committable_status_paths(status_text: str) -> tuple[str, ...]:
    excluded_prefixes = (
        ".harness/runs",
        ".harness/workflows",
        ".codex/agents",
        ".codex/skills",
        "harness",
        "harness_codex",
        "venv",
    )
    paths: list[str] = []
    entries = [entry for entry in status_text.split("\0") if entry]
    skip_next_rename_source = False
    for entry in entries:
        if skip_next_rename_source:
            path = entry
            skip_next_rename_source = False
        else:
            if len(entry) < 4:
                continue
            status_code = entry[:2]
            path = entry[3:]
            if status_code[0] in {"R", "C"} or status_code[1] in {"R", "C"}:
                skip_next_rename_source = True
        if not path or any(path == prefix or path.startswith(prefix + "/") for prefix in excluded_prefixes):
            continue
        paths.append(path)
    return tuple(dict.fromkeys(paths))


def _add_worktree(repo_root: Path, path: Path, branch: str, start_point: str) -> None:
    if path.exists():
        _git(repo_root, "worktree", "remove", "--force", str(path), check=False)
        shutil.rmtree(path, ignore_errors=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    _git(repo_root, "worktree", "add", "-B", branch, str(path), start_point)


def _hydrate_runtime_worktree(
    source_root: Path,
    target_root: Path,
    *,
    copy_project_docs: bool,
) -> None:
    _ensure_runs_link(source_root, target_root)
    for relative in (
        Path("harness"),
        Path("harness_codex"),
        Path(".codex/agents"),
        Path(".codex/skills"),
        Path(".harness/workflows"),
    ):
        _mirror_path(source_root / relative, target_root / relative, symlink=True)
    if not copy_project_docs:
        return
    for relative in (
        Path("docs/changes"),
        Path("docs/use-cases"),
        Path("docs/plans"),
        Path("docs/design"),
        Path(".codex/repository-settings.md"),
        Path(".codex/test-gate.yaml"),
        Path("AGENTS.md"),
        Path("ARCHITECTURE.md"),
        Path("context.md"),
    ):
        _mirror_path(source_root / relative, target_root / relative, symlink=False)


def _ensure_runs_link(source_root: Path, target_root: Path) -> None:
    source_runs = source_root / ".harness/runs"
    source_runs.mkdir(parents=True, exist_ok=True)
    harness_dir = target_root / ".harness"
    harness_dir.mkdir(parents=True, exist_ok=True)
    target_runs = harness_dir / "runs"
    if target_runs.is_symlink():
        target_runs.unlink()
    elif target_runs.exists():
        if target_runs.is_dir():
            shutil.rmtree(target_runs)
        else:
            target_runs.unlink()
    target_runs.symlink_to(source_runs.resolve(), target_is_directory=True)


def _mirror_path(source: Path, target: Path, *, symlink: bool) -> None:
    if not source.exists():
        return
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists() and symlink:
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if symlink:
        target.symlink_to(source.resolve(), target_is_directory=source.is_dir())
        return
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)
    else:
        shutil.copy2(source, target)


def _is_git_worktree(repo_root: Path) -> bool:
    checked = _git(repo_root, "rev-parse", "--is-inside-work-tree", check=False)
    return checked.returncode == 0 and checked.stdout.strip() == "true"


def _git(
    repo_root: Path,
    *args: str,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return completed


def _safe_ref_part(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    normalized = normalized.strip(".-/")
    return normalized or "item"


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
            "skip_existing_active_plan_planning": (repo_root / _active_plan_path(scope)).exists(),
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
    if finalization_result and finalization_result.metadata.get("delivery_status"):
        decisions["changeset_finalization"]["delivery_status"] = finalization_result.metadata[
            "delivery_status"
        ]
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
        artifact_states=_finalization_stage_artifacts(
            completed_count=len(completed),
            scope_count=len(scopes),
            finalization_result=finalization_result,
        ),
        work_item_states=tuple(
            _work_item_state(scope, results.get(scope.display_id)) for scope in scopes
        ),
        use_case_states=tuple(
            _use_case_state(scope, results.get(scope.display_id))
            for scope in scopes
            if scope.use_case is not None
        ),
    )


def _finalization_stage_artifacts(
    *,
    completed_count: int,
    scope_count: int,
    finalization_result: RunResult | None,
) -> tuple[StageArtifactState, ...]:
    artifacts: list[StageArtifactState] = []
    if scope_count and completed_count == scope_count:
        artifacts.append(
            StageArtifactState(
                stage="implementation",
                path=Path("docs/plans/completed"),
                generated_by="changeset-orchestrator",
                accepted=True,
                dirty_state=ArtifactDirtyState.CLEAN,
                downstream_status=ArtifactDirtyState.CLEAN,
            )
        )
    if finalization_result and finalization_result.metadata.get("delivery_status") == "pending_approval":
        artifacts.append(
            StageArtifactState(
                stage="change-set-pr",
                path=Path(".harness/runs/<RUN-ID>/pull-request.json"),
                generated_by="changeset-orchestrator",
                accepted=False,
                dirty_state=ArtifactDirtyState.CLEAN,
                downstream_status=ArtifactDirtyState.CLEAN,
            )
        )
    return tuple(artifacts)


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
        "delivery_status": result.metadata.get("delivery_status"),
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
                f"- Delivery status: {result.metadata.get('delivery_status') or '-'}",
            )
        )
        + "\n",
        encoding="utf-8",
    )


def _normalize_delivery_approval_pending(result: RunResult) -> RunResult:
    if not _is_delivery_approval_blocker(result):
        return result
    return replace(
        result,
        status=RunStatus.SUCCEEDED,
        failed_step_id=None,
        failure_kind=None,
        blocker=None,
        step_results=tuple(
            replace(
                step,
                status=StepStatus.SKIPPED,
                error="전달 승인 없음으로 PR/ChangeSet 완료 단계는 대기 상태로 남김.",
                failure_kind=None,
                metadata={
                    **dict(step.metadata),
                    "delivery_status": "pending_approval",
                },
            )
            if step.status is StepStatus.BLOCKED and _is_delivery_approval_step(step.step_id)
            else step
            for step in result.step_results
        ),
        metadata={
            **dict(result.metadata),
            "delivery_status": "pending_approval",
            "delivery_approval_required": True,
        },
    )


def _is_delivery_approval_blocker(result: RunResult) -> bool:
    if result.status is not RunStatus.BLOCKED:
        return False
    if not _is_delivery_approval_step(result.failed_step_id or ""):
        return False
    text = f"{result.blocker or ''} " + " ".join(
        f"{step.error or ''} {step.metadata.get('approval_env', '')} {step.metadata.get('delivery_approved', '')}"
        for step in result.step_results
    )
    lowered = text.lower()
    return (
        "delivery approval is missing" in lowered
        or "explicit delivery approval is required" in lowered
        or "delivery_approved false" in lowered
        or "명시적인 전달 승인이 필요" in text
        or "전달 승인 없음" in text
    )


def _is_delivery_approval_step(step_id: str) -> bool:
    return step_id in {"create-change-set-pr", "complete-change-set"}


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
