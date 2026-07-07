"""Project XML UI sessions into the canonical ChangeSet RunState."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping


def sync_xml_ui_session(
    repo_root: Path | str,
    change_set_id: str,
    session: Mapping[str, Any],
    *,
    transaction=None,
) -> None:
    """Project validated UI completion flags without a second XML commit."""

    root = Path(repo_root)
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_path.is_file():
        return

    from harness_codex.runtime import dashboard_runtime_state as dashboard

    affected_use_cases, affected_work_items = dashboard._affected_work_items(root, change_path)
    current = (
        transaction.load_run_state(dashboard.canonical_run_id(change_set_id))
        if transaction is not None
        else dashboard.load_canonical_change_set_state(root, change_set_id)
    )
    artifacts = dashboard._dashboard_stage_artifacts(root, dict(session), affected_use_cases)
    state = dashboard._build_canonical_state(
        change_set_id=change_set_id,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current=current,
        artifacts=artifacts,
    )
    if transaction is not None:
        transaction.save_run_state(state)
        return

    from harness_codex.runtime.state import RunStateStore

    RunStateStore(root).save(state)
