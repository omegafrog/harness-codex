"""Cleanup for artifacts owned by one deleted active ChangeSet."""

from __future__ import annotations

import re
import shutil
from pathlib import Path


_CHANGESET_ID_PATTERN = re.compile(r"CHG-[A-Za-z0-9-]+")


def purge_changeset_runtime_artifacts(
    repo_root: Path | str,
    change_set_id: str,
) -> tuple[Path, ...]:
    """Remove XML state and disposable evidence owned by a deleted ChangeSet.

    State ownership is path-based.  Cleanup never scans JSON payloads to infer a
    ChangeSet because JSON is no longer a durable runtime authority.
    """

    if not _CHANGESET_ID_PATTERN.fullmatch(change_set_id):
        raise ValueError("invalid ChangeSet id")

    root = Path(repo_root)
    removed: list[Path] = []
    _remove_path(root / ".harness" / "state" / "changesets" / change_set_id, removed)
    _remove_path(root / ".harness" / "ui" / "change-sets" / change_set_id, removed)
    _remove_path(root / ".harness" / "ui" / "stage-rerun-jobs" / f"{change_set_id}.json", removed)
    _remove_path(root / ".harness" / "state" / "stage-handoff" / f"{change_set_id}.json", removed)
    _remove_path(root / ".harness" / "stages" / change_set_id, removed)
    _remove_path(root / ".harness" / "contracts" / change_set_id, removed)

    for sidecar in (root / "docs" / "changes" / "active").glob(f"{change_set_id}.*"):
        _remove_path(sidecar, removed)

    runs_root = root / ".harness" / "runs"
    if runs_root.is_dir():
        _remove_path(runs_root / f"changeset-state-{change_set_id}", removed)

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
