from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.document_dashboard import delete_active_changeset
from harness_codex.runtime.harvest_ui import activate_changeset_harvest_ui


def _write_active_changeset(root: Path, change_set_id: str) -> None:
    path = root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# ChangeSet {change_set_id}\n", encoding="utf-8")


def _new_session() -> dict[str, object]:
    return {
        "initial_prompt": "new scoped request",
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "pending_questions": [],
        "requirements_gate_passed": False,
        "language_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "",
    }


def test_delete_clears_global_harvest_state_even_when_another_changeset_is_active(
    tmp_path: Path,
) -> None:
    _write_active_changeset(tmp_path, "CHG-001")
    _write_active_changeset(tmp_path, "CHG-002")
    state_path = tmp_path / ".harness" / "ui" / "harvest-session.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps(_new_session()), encoding="utf-8")

    delete_active_changeset(tmp_path, "CHG-001")

    assert not state_path.exists()
    assert (tmp_path / "docs/changes/active/CHG-002.md").exists()


def test_activate_new_changeset_replaces_stale_global_use_case_slices(tmp_path: Path) -> None:
    _write_active_changeset(tmp_path, "CHG-NEW")
    scoped_session = (
        tmp_path
        / ".harness"
        / "ui"
        / "change-sets"
        / "CHG-NEW"
        / "harvest-session.json"
    )
    scoped_session.parent.mkdir(parents=True)
    scoped_session.write_text(json.dumps(_new_session()), encoding="utf-8")

    stale_canonical = tmp_path / "docs" / "design" / "유스케이스.md"
    stale_canonical.parent.mkdir(parents=True)
    stale_canonical.write_text("- UC-001. stale use case\n", encoding="utf-8")
    stale_slice = tmp_path / "docs" / "use-cases" / "UC-001" / "use-case.md"
    stale_slice.parent.mkdir(parents=True)
    stale_slice.write_text("# stale\n", encoding="utf-8")

    activate_changeset_harvest_ui(tmp_path, "CHG-NEW")

    assert not stale_canonical.exists()
    assert not (tmp_path / "docs" / "use-cases").exists()
