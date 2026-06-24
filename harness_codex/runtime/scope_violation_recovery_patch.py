"""Git-checkpoint recovery for unauthorized agent writes.

Scope validation identifies the paths a step was not authorized to modify. The
runner must remove that delta without resetting the caller's whole worktree.

Instead of copying user files into a runtime snapshot, this module captures two
ephemeral Git commits before the agent runs:

* an index checkpoint, preserving the caller's staged state;
* a worktree checkpoint, preserving the caller's visible files, including
  untracked and ignored files.

Recovery restores only blocked paths from those checkpoints. The commits are
never attached to the caller's branch, so normal history and the shared index
are not rewritten merely to establish a rollback point.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.agent_write_scope_policy_patch import (
    _capture_worktree_snapshot,
    _inside_git_work_tree,
)
from harness_codex.runtime.models import FailureKind, StepKind, StepStatus


@dataclass(frozen=True)
class ScopeRecoveryCheckpoint:
    """Ephemeral Git objects representing pre-agent index and worktree state."""

    index_commit: str
    worktree_commit: str


@dataclass(frozen=True)
class ScopeRecoveryResult:
    """Recorded outcome of a fail-closed scope recovery."""

    report_path: Path
    detected_files: tuple[str, ...]
    recovered_files: tuple[str, ...]
    failed_files: tuple[dict[str, str], ...]
    preserved_preexisting_dirty_files: tuple[str, ...]


def apply_scope_violation_recovery_patch() -> None:
    """Install post-scope-validation recovery around every writable agent step."""

    import harness_codex.runtime.runner as runner_module

    BasicStepRunner = runner_module.BasicStepRunner
    if getattr(BasicStepRunner, "_scope_violation_recovery_patch_applied", False):
        return

    original_run_agent = BasicStepRunner._run_agent

    def run_agent(self, step, context, step_dir: Path):
        if step.kind != StepKind.AGENT or not _inside_git_work_tree(context.repo_root):
            return original_run_agent(self, step, context, step_dir)

        try:
            preexisting_dirty_files = _preexisting_dirty_paths(context.repo_root)
            checkpoint = capture_git_recovery_checkpoint(context.repo_root)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            blocked = runner_module.StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=f"scope recovery checkpoint failed before agent execution: {exc}",
                failure_kind=FailureKind.SCOPE_CONFLICT,
                metadata={"scope_recovery_checkpoint_error": str(exc)},
            )
            _rewrite_result_artifacts(
                context=context,
                step=step,
                step_dir=step_dir,
                result=blocked,
            )
            return blocked

        result = original_run_agent(self, step, context, step_dir)
        blocked_files = _scope_blocked_files(result.metadata)
        if not blocked_files:
            return result

        scope_report_path = _scope_report_path(context.repo_root, step_dir, result.metadata)
        recovery = recover_scope_violation(
            repo_root=context.repo_root,
            step_dir=step_dir,
            scope_report_path=scope_report_path,
            checkpoint=checkpoint,
            preexisting_dirty_files=preexisting_dirty_files,
            blocked_files=blocked_files,
        )
        metadata = {
            **dict(result.metadata),
            "scope_recovery_report_path": str(
                _relative_to_repo(recovery.report_path, context.repo_root)
            ),
            "scope_recovery_checkpoint": {
                "index_commit": checkpoint.index_commit,
                "worktree_commit": checkpoint.worktree_commit,
            },
            "scope_recovery_detected_files": recovery.detected_files,
            "scope_recovery_recovered_files": recovery.recovered_files,
            "scope_recovery_failed_files": recovery.failed_files,
            "scope_recovery_preserved_preexisting_dirty_files": (
                recovery.preserved_preexisting_dirty_files
            ),
        }
        error = _recovery_error(
            result.error,
            recovered=recovery.recovered_files,
            failures=recovery.failed_files,
        )
        recovered_result = runner_module.replace(
            result,
            status=StepStatus.BLOCKED,
            error=error,
            failure_kind=FailureKind.SCOPE_CONFLICT,
            metadata=metadata,
        )
        _rewrite_result_artifacts(
            context=context,
            step=step,
            step_dir=step_dir,
            result=recovered_result,
        )
        return recovered_result

    BasicStepRunner._run_agent = run_agent
    BasicStepRunner._scope_violation_recovery_patch_applied = True


def capture_git_recovery_checkpoint(repo_root: Path) -> ScopeRecoveryCheckpoint:
    """Create Git-only rollback points without touching the caller's branch.

    The normal index is read as-is for the index checkpoint. A temporary index
    is then populated from that state and force-adds the current worktree so
    ignored and untracked files can be restored too. ``commit-tree`` creates
    unreachable commit objects; it does not move ``HEAD`` or create a visible
    branch commit.
    """

    index_tree = _git_stdout(repo_root, ("write-tree",))
    index_commit = _create_checkpoint_commit(
        repo_root,
        index_tree,
        "harness scope recovery index checkpoint",
    )

    with tempfile.TemporaryDirectory(prefix="harness-scope-recovery-") as temp_dir:
        temporary_index = Path(temp_dir) / "index"
        environment = {"GIT_INDEX_FILE": str(temporary_index)}
        _run_git(repo_root, ("read-tree", index_tree), environment=environment)
        _run_git(
            repo_root,
            ("add", "--all", "--force", "--", "."),
            environment=environment,
        )
        worktree_tree = _git_stdout(
            repo_root,
            ("write-tree",),
            environment=environment,
        )

    worktree_commit = _create_checkpoint_commit(
        repo_root,
        worktree_tree,
        "harness scope recovery worktree checkpoint",
    )
    return ScopeRecoveryCheckpoint(
        index_commit=index_commit,
        worktree_commit=worktree_commit,
    )


def recover_scope_violation(
    *,
    repo_root: Path,
    step_dir: Path,
    scope_report_path: Path,
    checkpoint: ScopeRecoveryCheckpoint,
    preexisting_dirty_files: frozenset[str] | None = None,
    blocked_files: tuple[str, ...],
) -> ScopeRecoveryResult:
    """Restore only unauthorized paths from pre-agent Git checkpoint objects."""

    detected = tuple(dict.fromkeys(path for path in blocked_files if path))
    recovered: list[str] = []
    failed: list[dict[str, str]] = []
    preserved_dirty: list[str] = []
    dirty_paths = preexisting_dirty_files or frozenset()
    for relative in detected:
        try:
            if relative in dirty_paths:
                preserved_dirty.append(relative)
            _restore_path_from_checkpoint(repo_root, checkpoint, relative)
            recovered.append(relative)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            failed.append({"path": relative, "error": str(exc) or type(exc).__name__})

    report_path = step_dir / "scope-recovery-report.json"
    payload = {
        "status": "failed" if failed else "recovered",
        "detected_files": list(detected),
        "recovered_files": recovered,
        "recovery_failed_files": failed,
        "preserved_preexisting_dirty_files": preserved_dirty,
        "checkpoint": {
            "index_commit": checkpoint.index_commit,
            "worktree_commit": checkpoint.worktree_commit,
        },
        "scope_diff_report": str(scope_report_path),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    _append_recovery_to_scope_report(scope_report_path, payload)
    return ScopeRecoveryResult(
        report_path=report_path,
        detected_files=detected,
        recovered_files=tuple(recovered),
        failed_files=tuple(failed),
        preserved_preexisting_dirty_files=tuple(preserved_dirty),
    )


def _preexisting_dirty_paths(repo_root: Path) -> frozenset[str]:
    """Return a path inventory for reporting; it never copies file contents."""

    return frozenset(_capture_worktree_snapshot(repo_root))


def _restore_path_from_checkpoint(
    repo_root: Path,
    checkpoint: ScopeRecoveryCheckpoint,
    relative: str,
) -> None:
    target = _safe_repo_path(repo_root, relative)
    if target is None:
        raise ValueError(f"unsafe repository path: {relative}")

    if _tree_entry(repo_root, checkpoint.index_commit, relative) is None:
        _run_git(repo_root, ("update-index", "--force-remove", "--", relative))
    else:
        _run_git(
            repo_root,
            ("restore", "--source", checkpoint.index_commit, "--staged", "--", relative),
        )

    if _tree_entry(repo_root, checkpoint.worktree_commit, relative) is None:
        _remove_path(target)
    else:
        _run_git(
            repo_root,
            (
                "restore",
                "--source",
                checkpoint.worktree_commit,
                "--worktree",
                "--",
                relative,
            ),
        )


def _create_checkpoint_commit(repo_root: Path, tree: str, message: str) -> str:
    command = ["commit-tree", tree]
    head = _head_commit(repo_root)
    if head:
        command.extend(("-p", head))
    return _git_stdout(
        repo_root,
        tuple(command),
        input_text=message + "\n",
        environment={
            "GIT_AUTHOR_NAME": "harness-runtime",
            "GIT_AUTHOR_EMAIL": "runtime@harness.local",
            "GIT_COMMITTER_NAME": "harness-runtime",
            "GIT_COMMITTER_EMAIL": "runtime@harness.local",
        },
    )


def _head_commit(repo_root: Path) -> str | None:
    completed = _run_git(repo_root, ("rev-parse", "--verify", "HEAD"), check=False)
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def _tree_entry(repo_root: Path, treeish: str, relative: str) -> str | None:
    completed = _run_git(
        repo_root,
        ("ls-tree", "-r", "-z", treeish, "--", relative),
        check=False,
    )
    if completed.returncode != 0:
        raise subprocess.SubprocessError(
            completed.stderr.strip()
            or completed.stdout.strip()
            or f"git ls-tree failed for {relative}"
        )
    entries = [entry for entry in completed.stdout.split("\0") if entry]
    return entries[0] if entries else None


def _run_git(
    repo_root: Path,
    arguments: tuple[str, ...],
    *,
    input_text: str | None = None,
    environment: Mapping[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if environment:
        env.update(environment)
    completed = subprocess.run(
        ("git", *arguments),
        cwd=repo_root,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise subprocess.SubprocessError(detail or f"git {' '.join(arguments)} failed")
    return completed


def _git_stdout(
    repo_root: Path,
    arguments: tuple[str, ...],
    *,
    input_text: str | None = None,
    environment: Mapping[str, str] | None = None,
) -> str:
    return _run_git(
        repo_root,
        arguments,
        input_text=input_text,
        environment=environment,
    ).stdout.strip()


def _append_recovery_to_scope_report(report_path: Path, recovery: Mapping[str, Any]) -> None:
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        payload = {}
    payload["recovery"] = dict(recovery)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _scope_blocked_files(metadata: Mapping[str, Any] | None) -> tuple[str, ...]:
    value = metadata.get("scope_diff_blocked_files") if metadata else ()
    if not isinstance(value, (tuple, list)):
        return ()
    return tuple(str(path) for path in value if isinstance(path, str) and path)


def _scope_report_path(repo_root: Path, step_dir: Path, metadata: Mapping[str, Any]) -> Path:
    value = metadata.get("scope_diff_report_path")
    if isinstance(value, str) and value:
        candidate = _safe_repo_path(repo_root, value)
        if candidate is not None:
            return candidate
    return step_dir / "scope-diff-report.json"


def _recovery_error(
    original: str | None,
    *,
    recovered: tuple[str, ...],
    failures: tuple[dict[str, str],
) -> str:
    base = original or "scope violation blocked unauthorized changes"
    if failures:
        details = ", ".join(
            f"{item['path']}: {item['error']}" for item in failures
        )
        return f"{base}; scope violation recovery failed: {details}"
    if recovered:
        return f"{base}; unauthorized changes recovered: {', '.join(recovered)}"
    return f"{base}; scope violation recovery found no recoverable paths"


def _rewrite_result_artifacts(*, context, step, step_dir: Path, result) -> None:
    payload = {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "status": result.status.value,
        "exit_code": result.exit_code,
        "error": result.error,
        "metadata": dict(result.metadata),
    }
    for path in (step_dir / "result.json", context.run_dir / f"response-{step.id}.json"):
        if path.exists() or path.name == "result.json":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )


def _safe_repo_path(root: Path, relative: str) -> Path | None:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def _relative_to_repo(path: Path, repo_root: Path) -> Path:
    try:
        return path.relative_to(repo_root)
    except ValueError:
        return path


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()
