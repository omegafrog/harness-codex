"""Cleanup for runtime artifacts owned by one deleted active ChangeSet."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Mapping


_CHANGESET_ID_PATTERN = re.compile(r"CHG-[A-Za-z0-9-]+")


def purge_changeset_runtime_artifacts(
    repo_root: Path | str,
    change_set_id: str,
) -> tuple[Path, ...]:
    """Remove disposable runtime state owned by a deleted ChangeSet.

    Canonical design, use-case, and plan documents are intentionally not touched.
    They can be reused or explicitly removed by a separate user action. The cleanup
    covers only resumable UI snapshots, persisted stage-rerun jobs, and run
    directories whose JSON metadata identifies the deleted ChangeSet.
    """

    if not _CHANGESET_ID_PATTERN.fullmatch(change_set_id):
        raise ValueError("invalid ChangeSet id")

    root = Path(repo_root)
    removed: list[Path] = []

    _remove_path(
        root / ".harness" / "ui" / "change-sets" / change_set_id,
        removed,
    )
    _remove_path(
        root / ".harness" / "ui" / "stage-rerun-jobs" / f"{change_set_id}.json",
        removed,
    )

    runs_root = root / ".harness" / "runs"
    if runs_root.is_dir():
        for run_dir in runs_root.iterdir():
            if run_dir.is_dir() and _run_directory_references_change_set(
                run_dir, change_set_id
            ):
                _remove_path(run_dir, removed)

    # This is a materialized working copy, not durable ChangeSet state. Every
    # active ChangeSet owns a scoped snapshot, so retaining this unscoped file
    # after deleting any ChangeSet can resurrect the deleted workflow.
    _remove_path(root / ".harness" / "ui" / "harvest-session.json", removed)

    return tuple(removed)


def _remove_path(path: Path, removed: list[Path]) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
        removed.append(path)
    elif path.is_dir():
        shutil.rmtree(path)
        removed.append(path)


def _run_directory_references_change_set(run_dir: Path, change_set_id: str) -> bool:
    """Return whether durable JSON within one run identifies ``change_set_id``."""

    for json_path in run_dir.rglob("*.json"):
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if _json_references_change_set(payload, change_set_id):
            return True
    return False


def _json_references_change_set(value: Any, change_set_id: str) -> bool:
    if isinstance(value, Mapping):
        if value.get("change_set_id") == change_set_id:
            return True
        return any(_json_references_change_set(item, change_set_id) for item in value.values())
    if isinstance(value, list):
        return any(_json_references_change_set(item, change_set_id) for item in value)
    return False
