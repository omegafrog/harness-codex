"""Explicit worktree lifecycle boundary for ChangeSet execution.

The legacy helper implementation remains internal during this migration, while
new session orchestration depends only on this collaborator rather than on
module-level worktree helpers spread through the coordinator.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime import changeset_orchestrator as _legacy


@dataclass(frozen=True)
class WorktreeService:
    """Own isolated checkout preparation, merge, and plan-conflict repair."""

    def prepare(self, repo_root: Path, change_set_id: str, run_id: str):
        return _legacy._prepare_changeset_worktrees(repo_root, change_set_id, run_id)

    def repair_resumed_plan_transition(self, repo_root: Path, scope) -> None:
        _legacy._repair_resumed_plan_transition_conflict(repo_root, scope)

    def repair_completed_plan_transitions(self, repo_root: Path, scopes: tuple) -> None:
        _legacy._repair_completed_plan_conflicts(repo_root, scopes)

    def work_item_root(self, isolation, scope) -> Path | None:
        return _legacy._work_item_repo_root(isolation, scope)

    def commit_and_merge(self, isolation, scope, result, *, change_set_id: str):
        return _legacy._commit_and_merge_work_item(
            isolation,
            scope,
            result,
            change_set_id=change_set_id,
        )

    def commit_if_dirty(self, repo_root: Path, message: str):
        return _legacy._commit_if_dirty(repo_root, message)

    def blocked_result(self, result, message: str, completed):
        return _legacy._blocked_isolation_result(result, message, completed)
