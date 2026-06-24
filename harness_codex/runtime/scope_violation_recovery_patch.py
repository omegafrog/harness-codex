"""Fail-closed recovery for unauthorized agent writes.

A scope violation is different from an ordinary agent failure: the runner must retain
its audit artifacts while restoring only the unauthorized delta made by that step.
The patch is intentionally layered after the generic agent write-scope boundary so
it can use the same before/after scope report for both executor and document agents.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.agent_write_scope_policy_patch import (
    _capture_worktree_snapshot,
    _inside_git_work_tree,
)
from harness_codex.runtime.models import FailureKind, StepKind, StepStatus


@dataclass(frozen=True)
class ScopeRecoverySnapshot:
    """Pre-agent state required to preserve already-dirty user work."""

    entries: Mapping[str, Mapping[str, Any]]
    snapshot_dir: Path


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

        recovery_snapshot = capture_scope_recovery_snapshot(
            context.repo_root,
            step_dir / "scope-recovery-before",
        )
        result = original_run_agent(self, step, context, step_dir)
        blocked_files = _scope_blocked_files(result.metadata)
        if not blocked_files:
            return result

        scope_report_path = _scope_report_path(context.repo_root, step_dir, result.metadata)
        recovery = recover_scope_violation(
            repo_root=context.repo_root,
            step_dir=step_dir,
            scope_report_path=scope_report_path,
            snapshot=recovery_snapshot,
            blocked_files=blocked_files,
        )
        metadata = {
            **dict(result.metadata),
            "scope_recovery_report_path": str(
                _relative_to_repo(recovery.report_path, context.repo_root)
            ),
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


def capture_scope_recovery_snapshot(repo_root: Path, snapshot_dir: Path) -> ScopeRecoverySnapshot:
    """Persist pre-step dirty files so user work can be restored byte-for-byte.

    Clean tracked files do not need copies because ``git restore`` can recover them.
    Runtime artifacts are intentionally omitted: they are evidence, not user work,
    and are already allowed by the scope policy.
    """

    snapshot_dir.mkdir(parents=True, exist_ok=True)
    backup_root = snapshot_dir / "files"
    entries: dict[str, dict[str, Any]] = {}
    for relative, state in _capture_worktree_snapshot(repo_root).items():
        if _runtime_artifact_path(relative):
            continue
        target = _safe_repo_path(repo_root, relative)
        if target is None:
            continue
        entry: dict[str, Any] = {
            "state": state.get("state", "missing"),
            "index_info": _index_info(repo_root, relative),
        }
        if entry["state"] == "file" and target.is_file():
            backup = _safe_repo_path(backup_root, relative)
            if backup is not None:
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
                entry["backup"] = str(backup.relative_to(snapshot_dir))
                entry["mode"] = target.stat().st_mode
        entries[relative] = entry

    metadata_path = snapshot_dir / "snapshot.json"
    metadata_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return ScopeRecoverySnapshot(entries=entries, snapshot_dir=snapshot_dir)


def recover_scope_violation(
    *,
    repo_root: Path,
    step_dir: Path,
    scope_report_path: Path,
    snapshot: ScopeRecoverySnapshot,
    blocked_files: tuple[str, ...],
) -> ScopeRecoveryResult:
    """Restore unauthorized paths and record all recovery outcomes.

    A path present in ``snapshot.entries`` was already dirty before the agent ran and
    is restored from the private runtime backup. Other paths are restored to Git's
    baseline or removed when they were new untracked/ignored files.
    """

    detected = tuple(dict.fromkeys(path for path in blocked_files if path))
    recovered: list[str] = []
    failed: list[dict[str, str]] = []
    preserved_dirty: list[str] = []
    for relative in detected:
        try:
            if relative in snapshot.entries:
                _restore_preexisting_dirty_path(repo_root, snapshot, relative)
                preserved_dirty.append(relative)
            else:
                _restore_new_path(repo_root, relative)
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
        "snapshot": str(snapshot.snapshot_dir),
        "scope_diff_report": str(scope_report_path),
    }
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


def _restore_preexisting_dirty_path(
    repo_root: Path,
    snapshot: ScopeRecoverySnapshot,
    relative: str,
) -> None:
    entry = snapshot.entries[relative]
    target = _safe_repo_path(repo_root, relative)
    if target is None:
        raise ValueError(f"unsafe repository path: {relative}")
    state = str(entry.get("state") or "missing")
    if state == "file":
        backup_value = entry.get("backup")
        if not isinstance(backup_value, str) or not backup_value:
            raise ValueError(f"missing dirty-worktree backup for {relative}")
        backup = _safe_repo_path(snapshot.snapshot_dir, backup_value)
        if backup is None or not backup.is_file():
            raise ValueError(f"unreadable dirty-worktree backup for {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_dir():
            shutil.rmtree(target)
        shutil.copy2(backup, target)
        mode = entry.get("mode")
        if isinstance(mode, int):
            os.chmod(target, mode)
    elif state == "directory":
        target.mkdir(parents=True, exist_ok=True)
    else:
        _remove_path(target)
    _restore_index_info(repo_root, relative, str(entry.get("index_info") or ""))


def _restore_new_path(repo_root: Path, relative: str) -> None:
    target = _safe_repo_path(repo_root, relative)
    if target is None:
        raise ValueError(f"unsafe repository path: {relative}")
    completed = subprocess.run(
        ("git", "restore", "--staged", "--worktree", "--", relative),
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if not _path_exists_in_head(repo_root, relative):
        _remove_path(target)
        _restore_index_info(repo_root, relative, "")
        return
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise subprocess.SubprocessError(detail or f"git restore failed for {relative}")


def _restore_index_info(repo_root: Path, relative: str, index_info: str) -> None:
    if index_info:
        completed = subprocess.run(
            ("git", "update-index", "--index-info", "-z"),
            cwd=repo_root,
            text=True,
            input=index_info if index_info.endswith("\0") else index_info + "\0",
            capture_output=True,
            check=False,
        )
    else:
        completed = subprocess.run(
            ("git", "update-index", "--force-remove", "--", relative),
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise subprocess.SubprocessError(detail or f"git index recovery failed for {relative}")


def _index_info(repo_root: Path, relative: str) -> str:
    completed = subprocess.run(
        ("git", "ls-files", "-s", "-z", "--", relative),
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.stdout if completed.returncode == 0 else ""


def _path_exists_in_head(repo_root: Path, relative: str) -> bool:
    completed = subprocess.run(
        ("git", "cat-file", "-e", f"HEAD:{relative}"),
        cwd=repo_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode == 0


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
    failures: tuple[dict[str, str], ...],
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


def _runtime_artifact_path(path: str) -> bool:
    return path == ".harness" or path.startswith(".harness/")
