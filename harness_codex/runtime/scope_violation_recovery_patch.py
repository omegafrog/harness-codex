"""Recover scope violations from detached Git checkpoints."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.agent_write_scope_policy_patch import _inside_git_work_tree
from harness_codex.runtime.models import FailureKind, StepKind, StepStatus


@dataclass(frozen=True)
class ScopeRecoveryCheckpoint:
    index_commit: str
    worktree_commit: str


@dataclass(frozen=True)
class ScopeRecoveryResult:
    report_path: Path
    detected_files: tuple[str, ...]
    recovered_files: tuple[str, ...]
    failed_files: tuple[dict[str, str], ...]
    preserved_preexisting_dirty_files: tuple[str, ...]


def apply_scope_violation_recovery_patch() -> None:
    import harness_codex.runtime.runner as runner_module

    runner_type = runner_module.BasicStepRunner
    if getattr(runner_type, "_scope_violation_recovery_patch_applied", False):
        return
    original = runner_type._run_agent

    def run_agent(self, step, context, step_dir: Path):
        if step.kind != StepKind.AGENT or not _inside_git_work_tree(context.repo_root):
            return original(self, step, context, step_dir)
        try:
            checkpoint = capture_git_recovery_checkpoint(context.repo_root)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            return runner_module.StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=f"scope recovery checkpoint failed: {exc}",
                failure_kind=FailureKind.SCOPE_CONFLICT,
                metadata={"scope_recovery_checkpoint_error": str(exc)},
            )

        result = original(self, step, context, step_dir)
        blocked = _blocked_files(result.metadata)
        if not blocked:
            return result
        recovery = recover_scope_violation(
            repo_root=context.repo_root,
            step_dir=step_dir,
            scope_report_path=_report_path(context.repo_root, step_dir, result.metadata),
            checkpoint=checkpoint,
            blocked_files=blocked,
        )
        updated = runner_module.replace(
            result,
            status=StepStatus.BLOCKED,
            failure_kind=FailureKind.SCOPE_CONFLICT,
            error=_message(result.error, recovery),
            metadata={
                **dict(result.metadata),
                "scope_recovery_report_path": str(_relative(recovery.report_path, context.repo_root)),
                "scope_recovery_checkpoint": {
                    "index_commit": checkpoint.index_commit,
                    "worktree_commit": checkpoint.worktree_commit,
                },
                "scope_recovery_detected_files": recovery.detected_files,
                "scope_recovery_recovered_files": recovery.recovered_files,
                "scope_recovery_failed_files": recovery.failed_files,
                "scope_recovery_preserved_preexisting_dirty_files": recovery.preserved_preexisting_dirty_files,
            },
        )
        _write_result(context, step, step_dir, updated)
        return updated

    runner_type._run_agent = run_agent
    runner_type._scope_violation_recovery_patch_applied = True


def capture_git_recovery_checkpoint(repo_root: Path) -> ScopeRecoveryCheckpoint:
    """Create rollback commits without moving HEAD or the active branch."""

    index_tree = _git(repo_root, ("write-tree",))
    index_commit = _commit_tree(repo_root, index_tree, "index")
    with tempfile.TemporaryDirectory(prefix="harness-scope-") as directory:
        env = {"GIT_INDEX_FILE": str(Path(directory) / "index")}
        _run(repo_root, ("read-tree", index_tree), env=env)
        _run(repo_root, ("add", "--all", "--force", "--", "."), env=env)
        worktree_tree = _git(repo_root, ("write-tree",), env=env)
    return ScopeRecoveryCheckpoint(index_commit, _commit_tree(repo_root, worktree_tree, "worktree"))


def recover_scope_violation(
    *,
    repo_root: Path,
    step_dir: Path,
    scope_report_path: Path,
    checkpoint: ScopeRecoveryCheckpoint,
    blocked_files: tuple[str, ...],
) -> ScopeRecoveryResult:
    detected = tuple(dict.fromkeys(path for path in blocked_files if path))
    recovered: list[str] = []
    failed: list[dict[str, str]] = []
    preserved: list[str] = []
    for relative in detected:
        try:
            if _dirty_before(repo_root, checkpoint, relative):
                preserved.append(relative)
            _restore(repo_root, checkpoint, relative)
            recovered.append(relative)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            failed.append({"path": relative, "error": str(exc) or type(exc).__name__})

    report_path = step_dir / "scope-recovery-report.json"
    payload = {
        "status": "failed" if failed else "recovered",
        "detected_files": list(detected),
        "recovered_files": recovered,
        "recovery_failed_files": failed,
        "preserved_preexisting_dirty_files": preserved,
        "checkpoint": {
            "index_commit": checkpoint.index_commit,
            "worktree_commit": checkpoint.worktree_commit,
        },
        "scope_diff_report": str(scope_report_path),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _append_report(scope_report_path, payload)
    return ScopeRecoveryResult(
        report_path,
        detected,
        tuple(recovered),
        tuple(failed),
        tuple(preserved),
    )


def _restore(repo_root: Path, checkpoint: ScopeRecoveryCheckpoint, relative: str) -> None:
    target = _safe_path(repo_root, relative)
    if target is None:
        raise ValueError(f"unsafe repository path: {relative}")
    if _entry(repo_root, checkpoint.index_commit, relative) is None:
        _run(repo_root, ("update-index", "--force-remove", "--", relative))
    else:
        _run(repo_root, ("restore", "--source", checkpoint.index_commit, "--staged", "--", relative))
    if _entry(repo_root, checkpoint.worktree_commit, relative) is None:
        _remove(target)
    else:
        _run(repo_root, ("restore", "--source", checkpoint.worktree_commit, "--worktree", "--", relative))


def _dirty_before(repo_root: Path, checkpoint: ScopeRecoveryCheckpoint, relative: str) -> bool:
    worktree = _entry(repo_root, checkpoint.worktree_commit, relative)
    index = _entry(repo_root, checkpoint.index_commit, relative)
    head = _head(repo_root)
    return worktree != index or index != (_entry(repo_root, head, relative) if head else None)


def _commit_tree(repo_root: Path, tree: str, kind: str) -> str:
    command = ["commit-tree", tree]
    head = _head(repo_root)
    if head:
        command += ["-p", head]
    return _git(
        repo_root,
        tuple(command),
        input_text=f"harness scope recovery {kind} checkpoint\n",
        env={
            "GIT_AUTHOR_NAME": "harness-runtime",
            "GIT_AUTHOR_EMAIL": "runtime@harness.local",
            "GIT_COMMITTER_NAME": "harness-runtime",
            "GIT_COMMITTER_EMAIL": "runtime@harness.local",
        },
    )


def _head(repo_root: Path) -> str | None:
    result = _run(repo_root, ("rev-parse", "--verify", "HEAD"), check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def _entry(repo_root: Path, treeish: str, relative: str) -> str | None:
    result = _run(repo_root, ("ls-tree", "-r", "-z", treeish, "--", relative), check=False)
    if result.returncode:
        raise subprocess.SubprocessError(result.stderr.strip() or f"git ls-tree failed: {relative}")
    values = [value for value in result.stdout.split("\0") if value]
    return values[0] if values else None


def _run(
    repo_root: Path,
    args: tuple[str, ...],
    *,
    input_text: str | None = None,
    env: Mapping[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    if env:
        environment.update(env)
    result = subprocess.run(
        ("git", *args),
        cwd=repo_root,
        input=input_text,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    if check and result.returncode:
        raise subprocess.SubprocessError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result


def _git(repo_root: Path, args: tuple[str, ...], **kwargs: Any) -> str:
    return _run(repo_root, args, **kwargs).stdout.strip()


def _blocked_files(metadata: Mapping[str, Any] | None) -> tuple[str, ...]:
    values = metadata.get("scope_diff_blocked_files") if metadata else ()
    if not isinstance(values, (tuple, list)):
        return ()
    return tuple(str(path) for path in values if isinstance(path, str) and path)


def _report_path(repo_root: Path, step_dir: Path, metadata: Mapping[str, Any]) -> Path:
    value = metadata.get("scope_diff_report_path")
    if isinstance(value, str):
        path = _safe_path(repo_root, value)
        if path is not None:
            return path
    return step_dir / "scope-diff-report.json"


def _append_report(path: Path, recovery: Mapping[str, Any]) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        payload = {}
    payload["recovery"] = dict(recovery)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _message(original: str | None, recovery: ScopeRecoveryResult) -> str:
    base = original or "scope violation blocked unauthorized changes"
    if recovery.failed_files:
        details = ", ".join(f"{row['path']}: {row['error']}" for row in recovery.failed_files)
        return f"{base}; scope recovery failed: {details}"
    return f"{base}; unauthorized changes recovered: {', '.join(recovery.recovered_files)}"


def _write_result(context, step, step_dir: Path, result) -> None:
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
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _safe_path(root: Path, relative: str) -> Path | None:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def _relative(path: Path, repo_root: Path) -> Path:
    try:
        return path.relative_to(repo_root)
    except ValueError:
        return path


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()
