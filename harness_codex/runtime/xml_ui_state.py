"""XML-backed UI interaction and resumable-job state.

UI state is not a second source of truth.  It is stored inside the same
ChangeSet XML document used for RunState.  The runtime state document therefore
contains one authoritative view of execution state, user questions, and
interrupted UI jobs.
"""

from __future__ import annotations

import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping
from xml.etree import ElementTree as ET

from harness_codex.runtime import xml_state as state_xml

_UI_STATE_KEY = "ui-state"
_ALLOWED_ACTIVE_STAGES = {
    "requirements",
    "ubiquitousLanguage",
    "useCases",
    "eventStorming",
    "dddArchitecture",
}
_ALLOWED_JOB_STATUSES = {"needs_input", "blocked", "failed"}
_ORIGINAL_VALIDATE = state_xml._validate_document
_EXTENSION_INSTALLED = False


def install_xml_ui_state_extension() -> None:
    """Allow one strictly validated ``ui-state`` element in canonical XML."""

    global _EXTENSION_INSTALLED
    if _EXTENSION_INSTALLED:
        return

    def validate_document(root: ET.Element) -> None:
        ui_elements = [child for child in root if state_xml._local(child) == _UI_STATE_KEY]
        if len(ui_elements) > 1:
            raise state_xml.XmlStateValidationError("state document may contain only one ui-state element")
        for element in ui_elements:
            root.remove(element)
        try:
            _ORIGINAL_VALIDATE(root)
        finally:
            for element in ui_elements:
                root.append(element)
        if ui_elements:
            _validate_ui_element(ui_elements[0])

    state_xml._validate_document = validate_document
    _EXTENSION_INSTALLED = True


def load_ui_session(repo_root: Path | str, change_set_id: str) -> dict[str, Any] | None:
    """Load the persisted UI session for exactly one ChangeSet."""

    install_xml_ui_state_extension()
    path = state_xml.change_set_state_path(repo_root, change_set_id)
    if not path.exists():
        return None
    root = state_xml._parse_document(path)
    element = _ui_element(root)
    if element is None:
        return None
    value = state_xml._read_mapping(root, _UI_STATE_KEY)
    session = value.get("harvest_session")
    if not isinstance(session, dict):
        return None
    _validate_session(session)
    return deepcopy(session)


def save_ui_session(repo_root: Path | str, change_set_id: str, session: Mapping[str, Any]) -> Path:
    """Persist a complete UI session in the ChangeSet XML document."""

    install_xml_ui_state_extension()
    normalized = deepcopy(dict(session))
    _validate_session(normalized)
    payload = _load_ui_payload(repo_root, change_set_id)
    payload["harvest_session"] = normalized
    return _save_ui_payload(repo_root, change_set_id, payload)


def load_stage_rerun_job(repo_root: Path | str, change_set_id: str) -> dict[str, Any] | None:
    """Return a persisted rerun job only when it is resumable."""

    payload = _load_ui_payload(repo_root, change_set_id, missing_ok=True)
    job = payload.get("stage_rerun_job") if payload else None
    if not isinstance(job, dict):
        return None
    _validate_stage_rerun_job(job, expected_change_set_id=change_set_id)
    return deepcopy(job)


def save_stage_rerun_job(repo_root: Path | str, change_set_id: str, job: Mapping[str, Any]) -> Path:
    """Persist or clear the one resumable rerun job for a ChangeSet."""

    normalized = deepcopy(dict(job))
    status = str(normalized.get("status", ""))
    payload = _load_ui_payload(repo_root, change_set_id)
    if status not in _ALLOWED_JOB_STATUSES:
        payload.pop("stage_rerun_job", None)
    else:
        _validate_stage_rerun_job(normalized, expected_change_set_id=change_set_id)
        payload["stage_rerun_job"] = normalized
    return _save_ui_payload(repo_root, change_set_id, payload)


def clear_stage_rerun_job(repo_root: Path | str, change_set_id: str) -> Path:
    """Remove a completed rerun job without leaving a JSON tombstone."""

    payload = _load_ui_payload(repo_root, change_set_id)
    payload.pop("stage_rerun_job", None)
    return _save_ui_payload(repo_root, change_set_id, payload)


def _load_ui_payload(
    repo_root: Path | str,
    change_set_id: str,
    *,
    missing_ok: bool = False,
) -> dict[str, Any]:
    install_xml_ui_state_extension()
    path = state_xml.change_set_state_path(repo_root, change_set_id)
    if not path.exists():
        return {} if missing_ok else {}
    root = state_xml._parse_document(path)
    if _ui_element(root) is None:
        return {}
    payload = state_xml._read_mapping(root, _UI_STATE_KEY)
    return deepcopy(dict(payload))


def _save_ui_payload(repo_root: Path | str, change_set_id: str, payload: Mapping[str, Any]) -> Path:
    install_xml_ui_state_extension()
    path = state_xml.change_set_state_path(repo_root, change_set_id)
    root = state_xml._load_document_or_new(path, change_set_id)
    existing = _ui_element(root)
    if existing is not None:
        root.remove(existing)
    container = ET.SubElement(root, state_xml._tag(_UI_STATE_KEY))
    state_xml._append_value(container, dict(payload))
    state_xml._validate_document(root)
    state_xml._atomic_write(path, state_xml._serialize(root))
    return path


def _ui_element(root: ET.Element) -> ET.Element | None:
    matches = [child for child in root if state_xml._local(child) == _UI_STATE_KEY]
    return matches[0] if matches else None


def _validate_ui_element(element: ET.Element) -> None:
    state_xml._allow_attributes(element, set())
    state_xml._allow_children(element, {"value"})
    state_xml._validate_mapping_container(element)
    payload = state_xml._read_mapping(_synthetic_parent(element), _UI_STATE_KEY)
    if "harvest_session" in payload:
        if not isinstance(payload["harvest_session"], dict):
            raise state_xml.XmlStateValidationError("ui harvest_session must be an XML map")
        _validate_session(payload["harvest_session"])
    if "stage_rerun_job" in payload:
        if not isinstance(payload["stage_rerun_job"], dict):
            raise state_xml.XmlStateValidationError("ui stage_rerun_job must be an XML map")
        _validate_stage_rerun_job(payload["stage_rerun_job"])


def _synthetic_parent(element: ET.Element) -> ET.Element:
    parent = ET.Element(state_xml._tag("synthetic"))
    parent.append(deepcopy(element))
    return parent


def _validate_session(session: Mapping[str, Any]) -> None:
    active_stage = str(session.get("active_stage", "requirements"))
    if active_stage not in _ALLOWED_ACTIVE_STAGES:
        raise state_xml.XmlStateValidationError(f"invalid UI active_stage: {active_stage}")
    for name in ("requirements_gate_passed", "language_gate_passed", "use_cases_ready"):
        value = session.get(name, False)
        if not isinstance(value, bool):
            raise state_xml.XmlStateValidationError(f"UI {name} must be boolean")
    for name in ("clarifications", "current_questions", "pending_questions", "use_case_clarifications", "use_case_current_questions", "use_case_pending_questions"):
        value = session.get(name, [])
        if not isinstance(value, list):
            raise state_xml.XmlStateValidationError(f"UI {name} must be a list")
    for name in ("event_storming", "ddd_architecture"):
        value = session.get(name)
        if value is not None and not isinstance(value, dict):
            raise state_xml.XmlStateValidationError(f"UI {name} must be a map or null")


def _validate_stage_rerun_job(job: Mapping[str, Any], *, expected_change_set_id: str | None = None) -> None:
    change_set_id = str(job.get("change_set_id", ""))
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        raise state_xml.XmlStateValidationError("stage rerun job requires a valid ChangeSet id")
    if expected_change_set_id and change_set_id != expected_change_set_id:
        raise state_xml.XmlStateValidationError("stage rerun job ChangeSet id does not match XML document")
    status = str(job.get("status", ""))
    if status not in _ALLOWED_JOB_STATUSES:
        raise state_xml.XmlStateValidationError(f"invalid stage rerun job status: {status}")
    if not str(job.get("stage_id", "")):
        raise state_xml.XmlStateValidationError("stage rerun job requires stage_id")
    questions = job.get("pending_questions", [])
    if not isinstance(questions, list):
        raise state_xml.XmlStateValidationError("stage rerun job pending_questions must be a list")
