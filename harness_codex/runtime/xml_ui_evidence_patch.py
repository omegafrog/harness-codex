"""Keep generated UI documents without reintroducing JSON state."""

from __future__ import annotations

from pathlib import Path

_PATCHED_ATTR = "_harness_xml_ui_evidence_patch_applied"


def apply_xml_ui_evidence_patch() -> None:
    from harness_codex.runtime import harvest_ui
    from harness_codex.runtime import xml_ui_state_patch
    from harness_codex.runtime.xml_harvest_state_patch import copy_harvest_evidence
    from harness_codex.runtime.xml_ui_state import load_ui_session

    if getattr(harvest_ui, _PATCHED_ATTR, False):
        return

    original_write = harvest_ui._write_session
    original_load_changeset = harvest_ui.load_changeset_harvest_ui

    def write_session(root: Path, session: dict) -> None:
        original_write(root, session)
        context = xml_ui_state_patch._CONTEXT.get()
        if context and context[0] == Path(root).resolve():
            copy_harvest_evidence(harvest_ui, context[0], context[1], session)

    def load_changeset(root: Path | str, change_set_id: str):
        result = original_load_changeset(root, change_set_id)
        root_path = Path(root).resolve()
        session = load_ui_session(root_path, change_set_id)
        if session is not None:
            copy_harvest_evidence(harvest_ui, root_path, change_set_id, session)
        return result

    harvest_ui._write_session = write_session
    harvest_ui.load_changeset_harvest_ui = load_changeset
    setattr(harvest_ui, _PATCHED_ATTR, True)
