from __future__ import annotations

from copy import deepcopy


_PATCHED = "_harness_xml_ui_atomic_applied"


def apply() -> None:
    from harness_codex.runtime import xml_ui_state as ui
    from harness_codex.runtime.xml_state_transaction import change_set_transaction
    from harness_codex.runtime.xml_ui_canonical_projection import sync_xml_ui_session

    if getattr(ui, _PATCHED, False):
        return

    def save_session(root, change_set_id, session):
        value = deepcopy(dict(session))
        ui._validate_session(value)
        with change_set_transaction(root, change_set_id) as tx:
            data = tx.read_mapping(ui._UI_STATE_KEY) or {}
            data["harvest_session"] = value
            tx.replace_mapping(ui._UI_STATE_KEY, data)
            sync_xml_ui_session(root, change_set_id, value, transaction=tx)
            return tx.path

    ui.save_ui_session = save_session
    for name in (
        "harness_codex.runtime.xml_harvest_state_patch",
        "harness_codex.runtime.xml_ui_state_patch",
        "harness_codex.runtime.xml_document_dashboard_patch",
    ):
        try:
            module = __import__(name, fromlist=["*"])
        except ImportError:
            continue
        module.save_ui_session = save_session
    setattr(ui, _PATCHED, True)
