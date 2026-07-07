from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.procedure_stages import render_initial_changeset
from harness_codex.runtime.dashboard_runtime_state import load_canonical_change_set_state
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


def test_ui_completion_projects_into_canonical_xml_state(tmp_path: Path) -> None:
    change_set_id = "CHG-XML-UI-STATE-001"
    change_path = tmp_path / "docs/changes/active" / f"{change_set_id}.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="XML state",
            request_summary="Project UI completion into canonical XML state",
        ),
        encoding="utf-8",
    )
    requirements = tmp_path / "docs/design/요구사항.md"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("# Requirements\n\nready\n", encoding="utf-8")
    session = _session()
    session["requirements_gate_passed"] = True

    save_ui_session(tmp_path, change_set_id, session)

    state = load_canonical_change_set_state(tmp_path, change_set_id)
    assert state is not None
    assert any(item.stage == "requirements-definition" and item.accepted for item in state.artifact_states)


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
