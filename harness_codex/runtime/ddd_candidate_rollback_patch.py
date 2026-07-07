"""Rollback candidate output bytes when an interactive DDD attempt is not accepted."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping



def apply_ddd_candidate_rollback_patch() -> None:
    """Make candidate retries filesystem-transactional at the output boundary.

    The SQLite ledger records the agent attempt's before/after facts. This wrapper
    prevents an unaccepted attempt from leaving a partial candidate as the current
    working artifact: only a candidate whose five UI sections are complete remains
    in place. The rollback receipt preserves the attempt/restore relationship.
    """

    import harness_codex.runtime.ddd_candidate_efficiency_patch as candidate
    import harness_codex.runtime.harvest_ui as ui

    original_run_candidate = candidate._run_candidate
    if getattr(original_run_candidate, "_ddd_candidate_rollback_patch", False):
        return

    def run_candidate(*, ui, original_advance_all, root, session, change_set_id, uc_id, targets):
        snapshot = _capture_candidate(root, change_set_id, uc_id)
        original_run_candidate(
            ui=ui,
            original_advance_all=original_advance_all,
            root=root,
            session=session,
            change_set_id=change_set_id,
            uc_id=uc_id,
            targets=targets,
        )
        if _candidate_is_accepted(ui, session, uc_id):
            _write_rollback_receipt(
                root,
                change_set_id,
                uc_id,
                snapshot,
                restored=False,
                reason="accepted",
            )
            return
        _restore_candidate(root, uc_id, snapshot)
        _write_rollback_receipt(
            root,
            change_set_id,
            uc_id,
            snapshot,
            restored=True,
            reason=str(session.get("runtime_error") or session["ddd_architecture"].get("status") or "not accepted"),
        )

    run_candidate._ddd_candidate_rollback_patch = True
    candidate._run_candidate = run_candidate


def _candidate_path(root: Path, uc_id: str) -> Path:
    return root / "docs" / "use-cases" / uc_id / "ddd-design.md"


def _capture_candidate(root: Path, change_set_id: str, uc_id: str) -> dict[str, Any]:
    path = _candidate_path(root, uc_id)
    snapshot_root = root / ".harness" / "contracts" / change_set_id / uc_id
    backup = snapshot_root / "ddd-candidate.before.md"
    snapshot_root.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError(f"DDD candidate output must not be a symlink: {path}")
    if not path.exists():
        backup.unlink(missing_ok=True)
        return {"existed": False, "backup": str(backup.relative_to(root)), "sha256": None}
    if not path.is_file():
        raise ValueError(f"DDD candidate output must be a regular file: {path}")
    payload = path.read_bytes()
    _atomic_write_bytes(backup, payload)
    return {
        "existed": True,
        "backup": str(backup.relative_to(root)),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def _restore_candidate(root: Path, uc_id: str, snapshot: Mapping[str, Any]) -> None:
    path = _candidate_path(root, uc_id)
    backup_value = snapshot.get("backup")
    backup = root / str(backup_value) if isinstance(backup_value, str) else None
    if snapshot.get("existed"):
        if backup is None or not backup.is_file():
            raise ValueError(f"DDD candidate rollback backup is missing: {backup_value}")
        _atomic_write_bytes(path, backup.read_bytes())
        return
    if path.exists() or path.is_symlink():
        path.unlink()


def _candidate_is_accepted(ui, session: Mapping[str, Any], uc_id: str) -> bool:
    state = session.get("ddd_architecture")
    if not isinstance(state, Mapping) or state.get("status") == "error":
        return False
    item = state.get("items", {}).get(uc_id)
    if not isinstance(item, Mapping):
        return False
    steps = item.get("steps", {})
    return all(
        isinstance(steps.get(step_id), Mapping)
        and steps[step_id].get("status") == "complete"
        for step_id, _label in ui.DDD_STEPS
    )


def _write_rollback_receipt(
    root: Path,
    change_set_id: str,
    uc_id: str,
    snapshot: Mapping[str, Any],
    *,
    restored: bool,
    reason: str,
) -> None:
    path = root / ".harness" / "contracts" / change_set_id / uc_id / "ddd-candidate.rollback.json"
    current = _candidate_path(root, uc_id)
    payload = {
        "schema_version": 1,
        "change_set_id": change_set_id,
        "work_item_id": uc_id,
        "restored": restored,
        "reason": reason,
        "before": dict(snapshot),
        "current_sha256": hashlib.sha256(current.read_bytes()).hexdigest()
        if current.is_file() and not current.is_symlink()
        else None,
    }
    _atomic_write_json(path, payload)


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(payload)
    temporary.replace(path)


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
