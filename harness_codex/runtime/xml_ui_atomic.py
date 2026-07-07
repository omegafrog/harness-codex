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

    def save_rerun_job(root, change_set_id, job):
        value = deepcopy(dict(job))
        with change_set_transaction(root, change_set_id) as tx:
            data = tx.read_mapping(ui._UI_STATE_KEY) or {}
            if str(value.get("status", "")) in ui._ALLOWED_JOB_STATUSES:
                ui._validate_stage_rerun_job(value, expected_change_set_id=change_set_id)
                data["stage_rerun_job"] = value
            else:
                data.pop("stage_rerun_job", None)
            tx.replace_mapping(ui._UI_STATE_KEY, data)
            return tx.path

    def clear_rerun_job(root, change_set_id):
        with change_set_transaction(root, change_set_id) as tx:
            data = tx.read_mapping(ui._UI_STATE_KEY) or {}
            data.pop("stage_rerun_job", None)
            tx.replace_mapping(ui._UI_STATE_KEY, data)
            return tx.path

    ui.save_ui_session = save_session
    ui.save_stage_rerun_job = save_rerun_job
    ui.clear_stage_rerun_job = clear_rerun_job
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
        module.save_stage_rerun_job = save_rerun_job
    setattr(ui, _PATCHED, True)
