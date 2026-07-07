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
    return tuple(removed)


def _remove_path(path: Path, removed: list[Path]) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
        removed.append(path)
    elif path.is_dir():
        shutil.rmtree(path)
        removed.append(path)
