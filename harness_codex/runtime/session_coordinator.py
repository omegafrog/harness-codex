"""ChangeSet execution sequencing with explicit worktree and state collaborators."""

from __future__ import annotations

from pathlib import Path
from typing import Callable
from uuid import uuid4

from harness_codex.runtime import changeset_orchestrator as _legacy
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import RunResult, RunStatus
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.state_projection import persist_canonical_run_state
from harness_codex.runtime.workflow_orchestrator import WorkflowOrchestrator
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
    write_materialized_workflow_manifest,
)
from harness_codex.runtime.worktree_service import WorktreeService


class ChangeSetSessionCoordinator:
    """Coordinate work-item runs and one finalization run.

    ChangeSet/work-item selection lives here. Workflow step progression is owned
    by :class:`WorkflowOrchestrator`. Step execution is delegated to
    :class:`RunnerEngine`, worktree mutation is delegated to
    :class:`WorktreeService`, and persisted output is normalized through the
    canonical state projection before it is exposed to the caller.
    """

    def __init__(
        self,
        *,
        worktrees: WorktreeService | None = None,
        workflow_loader: Callable = load_named_workflow,
        workflow_materializer: Callable = materialize_workflow_for_scope,
        manifest_writer: Callable = write_materialized_workflow_manifest,
        engine_factory: Callable[[], object] | None = None,
        emit: Callable[[str], None] | None = None,
    ) -> None:
        self._worktrees = worktrees or WorktreeService()
        self._workflow_loader = workflow_loader
        self._workflow_materializer = workflow_materializer
        self._manifest_writer = manifest_writer
        self._engine_factory = engine_factory
        self._emit = emit

    def run(
        self,
        repo_root: Path,
        change_set,
        scopes: tuple,
        *,
        run_id: str | None = None,
        force_verification: bool = False,
        rollback_mode: str = "none",
    ):
        if not scopes:
            raise RuntimeError("workflow execution requires at least one ChangeSet work item")

        run_id = run_id or f"run-{uuid4().hex[:12]}"
        run_dir = repo_root / ".harness/runs" / run_id
        isolation = self._worktrees.prepare(repo_root, change_set.change_set_id, run_id)
        if isolation is not None:
            for scope in scopes:
                self._worktrees.repair_resumed_plan_transition(
                    isolation.integration_root,
                    scope,
                )

        workflows_dir = _legacy._workflows_dir(repo_root)
        work_item_workflow = self._workflow_loader(
            _legacy.WORK_ITEM_WORKFLOW_NAME,
            workflows_dir=workflows_dir,
        )
        finalization_workflow = self._workflow_loader(
            _legacy.FINALIZATION_WORKFLOW_NAME,
            workflows_dir=workflows_dir,
        )
        _legacy._assert_workflow_boundary(work_item_workflow, "work_item")
        _legacy._assert_workflow_boundary(finalization_workflow, "changeset_finalization")

        engine = self._engine_factory() if self._engine_factory is not None else RunnerEngine(BasicStepRunner())
        workflow_runner = self._workflow_runner(engine)
        results: dict[str, RunResult] = {}
        failed_scope = None

        for index, scope in enumerate(scopes, start=1):
            scope_repo = self._worktrees.work_item_root(isolation, scope)
            context_repo = scope_repo or repo_root
            if _legacy._work_item_plan_completed(context_repo, scope):
                result = _legacy._completed_work_item_result(run_id)
                if isolation is not None and not _legacy._work_item_plan_completed(
                    isolation.integration_root,
                    scope,
                ):
                    result = self._worktrees.commit_and_merge(
                        isolation,
                        scope,
                        result,
                        change_set_id=change_set.change_set_id,
                    )
                results[scope.display_id] = result
                self._emit_result(scope, result, index=index, total=len(scopes))
                continue

            completion_only = _legacy._work_item_plan_ready_to_complete(
                context_repo,
                change_set.change_set_id,
                scope,
            )
            if self._emit is not None:
                self._emit(_legacy._execution_start_line(scope, index, len(scopes)))
            materialized = _legacy._materialize(
                self._workflow_materializer,
                work_item_workflow,
                change_set,
                scope,
                run_id,
            )
            self._manifest_writer(
                materialized,
                run_dir / "work-items" / scope.display_id / "workflow.json",
            )
            result = workflow_runner.run(
                materialized,
                _legacy._context(
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
                result = self._worktrees.commit_and_merge(
                    isolation,
                    scope,
                    result,
                    change_set_id=change_set.change_set_id,
                )
            results[scope.display_id] = result
            self._emit_result(scope, result)
            if result.status is not RunStatus.SUCCEEDED:
                failed_scope = scope
                break

        finalization_result: RunResult | None = None
        final_repo = isolation.integration_root if isolation is not None else repo_root
        self._worktrees.repair_completed_plan_transitions(final_repo, scopes)
        if isolation is not None:
            repaired = self._worktrees.commit_if_dirty(
                isolation.integration_root,
                f"{change_set.change_set_id} 완료 계획 충돌 복구",
            )
            if repaired.returncode != 0:
                overall = self._worktrees.blocked_result(
                    _legacy._blocked_finalization_result(run_id, change_set),
                    "delivery completed-plan repair commit failed",
                    repaired,
                )
                state = persist_canonical_run_state(
                    repo_root,
                    _legacy._build_state(
                        repo_root=final_repo,
                        run_id=run_id,
                        change_set=change_set,
                        scopes=scopes,
                        results=results,
                        failed_scope=None,
                        finalization_result=None,
                        overall=overall,
                    ),
                )
                _legacy._write_session_report(
                    repo_root,
                    run_id,
                    change_set,
                    scopes,
                    results,
                    overall,
                    completion_repo=final_repo,
                )
                return state, overall

        if failed_scope is None and _legacy._all_work_item_plans_completed(final_repo, scopes):
            final_scope = scopes[-1]
            materialized = _legacy._materialize(
                self._workflow_materializer,
                finalization_workflow,
                change_set,
                final_scope,
                run_id,
            )
            self._manifest_writer(materialized, run_dir / "finalization" / "workflow.json")
            finalization_result = workflow_runner.run(
                materialized,
                _legacy._context(
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
            finalization_result = _legacy._normalize_delivery_approval_pending(finalization_result)
            _legacy._write_finalization_report(repo_root, run_id, finalization_result)

        if failed_scope is not None:
            overall = results[failed_scope.display_id]
        elif finalization_result is not None:
            overall = finalization_result
        else:
            overall = _legacy._blocked_finalization_result(run_id, change_set)
            _legacy._write_finalization_report(repo_root, run_id, overall)

        state = persist_canonical_run_state(
            repo_root,
            _legacy._build_state(
                repo_root=final_repo,
                run_id=run_id,
                change_set=change_set,
                scopes=scopes,
                results=results,
                failed_scope=failed_scope,
                finalization_result=finalization_result,
                overall=overall,
            ),
        )
        _legacy._write_session_report(
            repo_root,
            run_id,
            change_set,
            scopes,
            results,
            overall,
            completion_repo=final_repo,
        )
        return state, overall

    def _workflow_runner(self, engine: object):
        if hasattr(engine, "run_step") and hasattr(engine, "execute_step"):
            return WorkflowOrchestrator(engine=engine)  # type: ignore[arg-type]
        # Compatibility for tests or callers that still inject a workflow-level runner.
        return engine

    def _emit_result(
        self,
        scope,
        result: RunResult,
        *,
        index: int | None = None,
        total: int | None = None,
    ) -> None:
        if self._emit is not None:
            self._emit(_legacy._execution_result_line(scope, result, index=index, total=total))


def apply_workflow(
    repo_root: Path,
    change_set,
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
    """Compatibility function for callers that do not construct a coordinator."""

    return ChangeSetSessionCoordinator(
        workflow_loader=workflow_loader,
        workflow_materializer=workflow_materializer,
        manifest_writer=manifest_writer,
        engine_factory=engine_factory,
        emit=emit,
    ).run(
        repo_root,
        change_set,
        scopes,
        run_id=run_id,
        force_verification=force_verification,
        rollback_mode=rollback_mode,
    )
