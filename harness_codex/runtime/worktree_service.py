"""Git worktree lifecycle for isolated ChangeSet execution."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping

from harness_codex.runtime.models import FailureKind, RunResult, RunStatus
from harness_codex.runtime.worktree_support import (
    add_worktree,
    branch_contains,
    committable_status_paths,
    git,
    hydrate_runtime_worktree,
    is_git_worktree,
    remove_runtime_links,
    remove_worktree,
    safe_ref_part,
    usable_worktree,
    worktree_dirty,
    worktrees_base_dir,
)


@dataclass(frozen=True)
class WorktreeIsolation:
    """One integration checkout and a checkout for each work item."""

    source_root: Path
    integration_root: Path
    integration_branch: str
    work_item_roots: Mapping[str, Path]
    work_item_branches: Mapping[str, str]


@dataclass(frozen=True)
class WorktreeService:
    """Own isolated checkout preparation, merge, and plan-conflict repair."""

    def prepare(self, repo_root: Path, change_set_id: str, run_id: str) -> WorktreeIsolation | None:
        if not is_git_worktree(repo_root):
            return None
        safe_change = safe_ref_part(change_set_id)
        safe_run = safe_ref_part(run_id)
        base_dir = worktrees_base_dir(repo_root, safe_change, safe_run)
        integration_branch = f"harness/{safe_change}/{safe_run}/delivery"
        integration_root = base_dir / "delivery"
        reuse = usable_worktree(integration_root, integration_branch)
        if reuse and worktree_dirty(integration_root):
            remove_worktree(repo_root, integration_root)
            reuse = False
        if not reuse:
            add_worktree(repo_root, integration_root, integration_branch, "HEAD")
        hydrate_runtime_worktree(repo_root, integration_root, copy_project_docs=not reuse)
        return WorktreeIsolation(
            source_root=repo_root,
            integration_root=integration_root,
            integration_branch=integration_branch,
            work_item_roots={},
            work_item_branches={},
        )

    def repair_resumed_plan_transition(self, repo_root: Path, scope) -> None:
        active = repo_root / _active_plan_path(scope)
        completed = repo_root / _completed_plan_path(scope.display_id)
        if active.exists() and completed.exists():
            active.unlink()

    def repair_completed_plan_transitions(self, repo_root: Path, scopes: tuple) -> None:
        for scope in scopes:
            self.repair_resumed_plan_transition(repo_root, scope)

    def work_item_root(self, isolation: WorktreeIsolation | None, scope) -> Path | None:
        if isolation is None:
            return None
        existing = isolation.work_item_roots.get(scope.display_id)
        if existing is not None:
            return existing
        safe_item = safe_ref_part(scope.display_id)
        branch_prefix = safe_ref_part(isolation.integration_branch.replace("/", "-"))
        branch = f"harness/{branch_prefix}/{safe_item}"
        root = isolation.integration_root.parent / "work-items" / safe_item
        reuse = usable_worktree(root, branch)
        if reuse and not branch_contains(root, branch, isolation.integration_branch):
            remove_worktree(isolation.source_root, root)
            reuse = False
        if not reuse:
            add_worktree(isolation.source_root, root, branch, isolation.integration_branch)
        hydrate_runtime_worktree(isolation.source_root, root, copy_project_docs=not reuse)
        self.repair_resumed_plan_transition(root, scope)
        if reuse:
            _sync_resumed_active_plan(isolation.source_root, root, scope)
        isolation.work_item_roots[scope.display_id] = root
        isolation.work_item_branches[scope.display_id] = branch
        return root

    def commit_and_merge(
        self,
        isolation: WorktreeIsolation,
        scope,
        result: RunResult,
        *,
        change_set_id: str,
    ) -> RunResult:
        worktree = isolation.work_item_roots[scope.display_id]
        branch = isolation.work_item_branches[scope.display_id]
        baseline = self.commit_if_dirty(
            isolation.integration_root,
            f"{change_set_id} 전달 기준 산출물 반영",
        )
        if baseline.returncode != 0:
            return self.blocked_result(result, "delivery baseline commit failed", baseline)
        commit = self.commit_if_dirty(worktree, f"{change_set_id} {scope.display_id} 구현 완료")
        if commit.returncode != 0:
            return self.blocked_result(result, "work-item commit failed", commit)
        merge = git(
            isolation.integration_root,
            "merge",
            "--no-ff",
            "--no-edit",
            branch,
            check=False,
        )
        if merge.returncode != 0:
            git(isolation.integration_root, "merge", "--abort", check=False)
            return self.blocked_result(result, "work-item merge failed", merge)
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

    def commit_if_dirty(self, repo_root: Path, message: str) -> subprocess.CompletedProcess[str]:
        remove_runtime_links(repo_root)
        status = git(repo_root, "status", "--porcelain=v1", "-z", check=False)
        if status.returncode != 0 or not status.stdout:
            return status
        paths = committable_status_paths(status.stdout)
        if not paths:
            return subprocess.CompletedProcess(["git", "status", "--porcelain=v1", "-z"], 0, "", "")
        added = git(repo_root, "add", "-A", "-f", "--", *paths, check=False)
        if added.returncode != 0:
            return added
        staged = git(repo_root, "diff", "--cached", "--quiet", check=False)
        if staged.returncode == 0:
            return subprocess.CompletedProcess(["git", "diff", "--cached", "--quiet"], 0, "", "")
        if staged.returncode not in {0, 1}:
            return staged
        return git(repo_root, "commit", "-m", message, check=False)

    def blocked_result(
        self,
        result: RunResult,
        message: str,
        completed: subprocess.CompletedProcess[str],
    ) -> RunResult:
        detail = completed.stderr.strip() or completed.stdout.strip() or message
        return replace(
            result,
            status=RunStatus.BLOCKED,
            failed_step_id=result.failed_step_id or "worktree-isolation",
            failure_kind=result.failure_kind or FailureKind.IMPLEMENTATION,
            blocker=f"{message}: {detail}",
            metadata={**dict(result.metadata), "worktree_isolation_error": detail},
        )


def _sync_resumed_active_plan(source_root: Path, worktree_root: Path, scope) -> None:
    if (worktree_root / _completed_plan_path(scope.display_id)).exists():
        return
    relative = _active_plan_path(scope)
    source = source_root / relative
    target = worktree_root / relative
    if not source.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _active_plan_path(scope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(work_item_id: str) -> Path:
    return Path(f"docs/plans/completed/{work_item_id}/plan.md")
