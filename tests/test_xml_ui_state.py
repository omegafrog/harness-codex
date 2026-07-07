from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.xml_state import XmlStateValidationError, change_set_state_path
from harness_codex.runtime.xml_ui_state import (
    load_stage_rerun_job,
    load_ui_session,
    save_stage_rerun_job,
    save_ui_session,
)


def _session() -> dict[str, object]:
    return {
        "initial_prompt": "Build XML state",
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "pending_questions": [],
        "requirements_gate_passed": False,
        "language_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "",
        "use_case_clarifications": [],
        "use_case_current_question": None,
        "use_case_current_questions": [],
        "use_case_pending_questions": [],
        "event_storming": None,
        "ddd_architecture": None,
    }


def test_ui_session_shares_changeset_xml_without_json_snapshot(tmp_path: Path) -> None:
    save_ui_session(tmp_path, "CHG-XML-UI-001", _session())

    xml_path = change_set_state_path(tmp_path, "CHG-XML-UI-001")
    assert xml_path.exists()
    assert "<ui-state>" in xml_path.read_text(encoding="utf-8")
    assert load_ui_session(tmp_path, "CHG-XML-UI-001") == _session()
    assert not (tmp_path / ".harness/ui/harvest-session.json").exists()
    assert not (tmp_path / ".harness/ui/change-sets/CHG-XML-UI-001/harvest-session.json").exists()


def test_stage_rerun_job_round_trips_in_changeset_xml(tmp_path: Path) -> None:
    job = {
        "change_set_id": "CHG-XML-UI-002",
        "stage_id": "event-storming",
        "uc_id": "UC-020",
        "status": "needs_input",
        "pending_questions": [{"question": "Which event?"}],
        "output": "Need a decision",
    }

    save_stage_rerun_job(tmp_path, "CHG-XML-UI-002", job)

    assert load_stage_rerun_job(tmp_path, "CHG-XML-UI-002") == job
    assert not (tmp_path / ".harness/ui/stage-rerun-jobs/CHG-XML-UI-002.json").exists()


def test_ui_session_rejects_unknown_stage(tmp_path: Path) -> None:
    invalid = _session()
    invalid["active_stage"] = "not-a-stage"

    with pytest.raises(XmlStateValidationError, match="active_stage"):
        save_ui_session(tmp_path, "CHG-XML-UI-003", invalid)
