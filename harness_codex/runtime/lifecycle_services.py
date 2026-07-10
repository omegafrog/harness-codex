"""Workflow brain 없이 호출하는 로컬 lifecycle utility."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.worktree_support import (
    add_worktree,
    git,
    is_git_worktree,
    remove_worktree,
    usable_worktree,
    worktree_dirty,
    worktrees_base_dir,
)
from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def prepare_artifact_directories(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    work_item_id = str(payload.get("work_item_id") or "").strip()
    run_dir = root / ".harness" / "runs" / run_id
    item_dir = run_dir / "work-items" / work_item_id if work_item_id else run_dir
    paths = {
        "run_dir": run_dir,
        "evidence_dir": item_dir / "evidence",
        "stdout_dir": item_dir / "stdout",
        "stderr_dir": item_dir / "stderr",
        "report_path": item_dir / "execution-report.xml",
    }
    for path in paths.values():
        if path.suffix:
            path.parent.mkdir(parents=True, exist_ok=True)
        else:
            path.mkdir(parents=True, exist_ok=True)
    return {"operation_id": run_id, **_completed_paths(paths)}


def create_worktree(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    if not is_git_worktree(root):
        return _failed("repo_root is not a git worktree")
    branch = _required_text(payload, "branch_name")
    base_ref = str(payload.get("base_ref") or "HEAD")
    requested = payload.get("requested_path")
    path = Path(requested) if requested else worktrees_base_dir(root, "runtime", branch) / "worktree"
    path = path if path.is_absolute() else root / path
    if path.exists():
        if bool(payload.get("reuse_allowed", True)) and usable_worktree(path, branch):
            dirty = worktree_dirty(path)
            return {
                "status": "completed",
                "worktree_path": str(path),
                "branch_name": branch,
                "base_sha": _git_stdout(path, "rev-parse", "HEAD"),
                "head_sha": _git_stdout(path, "rev-parse", "HEAD"),
                "created": False,
                "reused": True,
                "dirty": dirty,
            }
        return _failed(f"worktree path already exists or belongs to another branch: {path}")
    try:
        add_worktree(root, path, branch, base_ref)
    except (OSError, RuntimeError) as exc:
        return _failed(str(exc))
    head = _git_stdout(path, "rev-parse", "HEAD")
    return {
        "status": "completed",
        "worktree_path": str(path),
        "branch_name": branch,
        "base_sha": head,
        "head_sha": head,
        "created": True,
        "reused": False,
        "dirty": False,
    }


def worktree_status(payload: Mapping[str, object]) -> dict[str, object]:
    path = _required_path(payload, "worktree_path")
    if not is_git_worktree(path):
        return _failed(f"not a git worktree: {path}")
    return {
        "status": "completed",
        "worktree_path": str(path),
        "branch_name": _git_stdout(path, "branch", "--show-current"),
        "head_sha": _git_stdout(path, "rev-parse", "HEAD"),
        "dirty": worktree_dirty(path),
    }


def cleanup_worktree(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    path = _required_path(payload, "worktree_path")
    if not path.exists():
        return {"status": "not_applicable", "worktree_path": str(path)}
    try:
        remove_worktree(root, path)
    except (OSError, RuntimeError) as exc:
        return _failed(str(exc))
    return {"status": "completed", "worktree_path": str(path)}


def create_run_state(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    path = _run_state_path(root, run_id)
    existing = _read_json(path)
    identity = {key: str(payload.get(key) or "") for key in ("run_id", "change_set_id", "work_item_id")}
    if existing:
        if any(existing.get(key, "") != value for key, value in identity.items() if value):
            return _failed("run identity cannot change")
        return {"status": "completed", "operation_id": run_id, "state_path": str(path), "reused": True}
    state = {**identity, "status": "created", "events": [], "artifact_paths": [], "errors": []}
    _atomic_json(path, state)
    return {"status": "completed", "operation_id": run_id, "state_path": str(path), "reused": False}


def append_run_event(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    path = _run_state_path(root, run_id)
    state = _read_json(path)
    if not state:
        return _failed(f"run state does not exist: {run_id}")
    state.setdefault("events", []).append(dict(payload.get("event") or {}))
    _atomic_json(path, state)
    return {"status": "completed", "operation_id": run_id, "state_path": str(path)}


def update_run_status(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    status = _required_text(payload, "status")
    path = _run_state_path(root, run_id)
    state = _read_json(path)
    if not state:
        return _failed(f"run state does not exist: {run_id}")
    state["status"] = status
    _atomic_json(path, state)
    return {"status": "completed", "operation_id": run_id, "state_path": str(path)}


def read_run_state(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    path = _run_state_path(root, run_id)
    state = _read_json(path)
    if not state:
        return _failed(f"run state does not exist: {run_id}")
    return {"status": "completed", "operation_id": run_id, "state_path": str(path), "state": state}


def write_execution_report(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    run_id = _required_text(payload, "run_id")
    work_item_id = _required_text(payload, "work_item_id")
    report_path = root / ".harness" / "runs" / run_id / "work-items" / work_item_id / "execution-report.xml"
    report = dict(payload)
    report.pop("repo_root", None)
    report.setdefault("schema_version", 1)
    report.setdefault("plan_fingerprint", "")
    try:
        write_handoff(report_path, "execution-report", report)
    except ValueError as exc:
        return _failed(str(exc))
    return {"status": "completed", "operation_id": run_id, "report_path": str(report_path)}


def read_execution_report(payload: Mapping[str, object]) -> dict[str, object]:
    path = _required_path(payload, "report_path")
    try:
        report = read_handoff(path, expected_type="execution-report")
    except ValueError as exc:
        return _failed(str(exc))
    expected = str(payload.get("plan_fingerprint") or "")
    if expected and report.get("plan_fingerprint") != expected:
        return _failed("execution report plan fingerprint does not match")
    return {"status": "completed", "report_path": str(path), "report": report}


def prepare_commit(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    status = git(root, "status", "--porcelain=v1", "-z", check=False)
    if status.returncode != 0:
        return _failed(status.stderr.strip() or "git status failed")
    changed = _status_paths(status.stdout)
    allowed = tuple(str(item).rstrip("/") for item in (payload.get("allowed_paths") or ()))
    outside = tuple(path for path in changed if allowed and not any(path == item or path.startswith(item + "/") for item in allowed))
    if outside:
        return {"status": "blocked", "changed_paths": changed, "violations": list(outside), "error": "path outside allowed scope"}
    if not changed:
        return {"status": "not_applicable", "changed_paths": []}
    added = git(root, "add", "-A", "--", *changed, check=False)
    if added.returncode != 0:
        return _failed(added.stderr.strip() or "git add failed")
    message = _required_text(payload, "commit_message")
    committed = git(root, "commit", "-m", message, check=False)
    if committed.returncode != 0:
        return _failed(committed.stderr.strip() or committed.stdout.strip() or "git commit failed")
    return {"status": "completed", "changed_paths": changed, "commit_sha": _git_stdout(root, "rev-parse", "HEAD")}


def merge_commit(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    branch = _required_text(payload, "branch_name")
    merged = git(root, "merge", "--no-ff", "--no-edit", branch, check=False)
    if merged.returncode != 0:
        git(root, "merge", "--abort", check=False)
        return {"status": "blocked", "conflicts": True, "error": merged.stderr.strip() or merged.stdout.strip()}
    return {"status": "completed", "merge_sha": _git_stdout(root, "rev-parse", "HEAD"), "conflicts": False}


def complete_work_item(payload: Mapping[str, object]) -> dict[str, object]:
    root = _required_path(payload, "repo_root")
    active = _required_path(payload, "active_plan_path")
    report = _required_path(payload, "execution_report_path")
    violations: list[str] = []
    if not active.is_file():
        violations.append(f"active plan does not exist: {active}")
    if not report.is_file():
        violations.append(f"execution report does not exist: {report}")
    expected_fingerprint = str(payload.get("plan_fingerprint") or "").strip()
    if not violations and expected_fingerprint:
        try:
            stored = read_handoff(report, expected_type="execution-report")
        except ValueError as exc:
            violations.append(str(exc))
        else:
            if stored.get("plan_fingerprint") != expected_fingerprint:
                violations.append("execution report plan fingerprint does not match")
    if violations:
        return {"status": "blocked", "violations": violations, "evidence_paths": [str(active), str(report)]}
    completed = root / "docs" / "plans" / "completed" / active.parent.name / active.name
    completed.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(active), str(completed))
    except OSError as exc:
        return _failed(str(exc))
    return {
        "status": "completed",
        "operation_id": active.parent.name,
        "completed_plan_path": str(completed),
        "evidence_paths": [str(report)],
    }


def _required_path(payload: Mapping[str, object], key: str) -> Path:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return Path(value).resolve()


def _required_text(payload: Mapping[str, object], key: str) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def _failed(error: str) -> dict[str, object]:
    return {"status": "failed", "error": error}


def _completed_paths(paths: Mapping[str, Path]) -> dict[str, object]:
    return {"status": "completed", **{key: str(value) for key, value in paths.items()}}


def _run_state_path(root: Path, run_id: str) -> Path:
    return root / ".harness" / "runs" / run_id / "runtime-state.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _atomic_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _git_stdout(root: Path, *args: str) -> str:
    result = git(root, *args, check=False)
    return result.stdout.strip()


def _status_paths(status_text: str) -> tuple[str, ...]:
    paths: list[str] = []
    for entry in status_text.split("\0"):
        if entry and len(entry) >= 4:
            paths.append(entry[3:])
    return tuple(dict.fromkeys(paths))


__all__ = [
    "append_run_event",
    "cleanup_worktree",
    "complete_work_item",
    "create_run_state",
    "create_worktree",
    "merge_commit",
    "prepare_artifact_directories",
    "prepare_commit",
    "read_execution_report",
    "read_run_state",
    "update_run_status",
    "worktree_status",
    "write_execution_report",
]
