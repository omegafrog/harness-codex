"""Project XML UI sessions into the canonical ChangeSet RunState.

The UI session is stored in the same XML document as RunState. This projection
turns validated UI completion flags into canonical stage artifacts without
using a Markdown procedure table or a JSON snapshot.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping


def sync_xml_ui_session(repo_root: Path | str, change_set_id: str, session: Mapping[str, Any]) -> None:
    """Update the deterministic canonical RunState when an active ChangeSet exists."""

    root = Path(repo_root)
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_path.is_file():
        return

    from harness_codex.runtime import dashboard_runtime_state as dashboard
    from harness_codex.runtime.state import RunStateStore

    affected_use_cases, affected_work_items = dashboard._affected_work_items(root, change_path)
    current = dashboard.load_canonical_change_set_state(root, change_set_id)
    artifacts = dashboard._dashboard_stage_artifacts(root, dict(session), affected_use_cases)
    state = dashboard._build_canonical_state(
        change_set_id=change_set_id,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current=current,
        artifacts=artifacts,
    )
    RunStateStore(root).save(state)
