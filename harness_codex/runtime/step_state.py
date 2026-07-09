"""Step-local XML handoff storage."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def step_state_xml_path(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    step_id: str,
) -> Path:
    root = Path(repo_root)
    return (
        root
        / ".harness"
        / "state"
        / "step-state"
        / change_set_id
        / work_item_id
        / step_id
        / "state.xml"
    )


def write_step_state_handoff(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    step_id: str,
    handoff_type: str,
    payload: Mapping[str, Any],
) -> Path:
    path = step_state_xml_path(
        repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        step_id=step_id,
    )
    return write_handoff(path, handoff_type, payload)


def read_step_state_handoff(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    step_id: str,
    expected_type: str,
) -> dict[str, Any]:
    path = step_state_xml_path(
        repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        step_id=step_id,
    )
    return read_handoff(path, expected_type=expected_type)
