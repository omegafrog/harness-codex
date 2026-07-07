"""Install XML-backed dashboard state readers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from harness_codex.runtime.xml_ui_state import load_ui_session, save_ui_session

_PATCHED_ATTR = "_harness_xml_document_dashboard_patch_applied"


def _unwrap_legacy_dashboard_reader(function):
    for cell in function.__closure__ or ():
        candidate = cell.cell_contents
        if callable(candidate) and getattr(candidate, "__name__", "") == "document_dashboard_state":
            return candidate
    return function


def apply_xml_document_dashboard_patch() -> None:
    """Remove dashboard fallback reads from Markdown status and UI JSON files."""

    from harness_codex.runtime import dashboard as run_dashboard
    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import document_dashboard as dashboard
    from harness_codex.runtime import harvest_ui, ui_server
    from harness_codex.runtime.dashboard_runtime_state import load_canonical_change_set_state
    from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES
    from harness_codex.runtime.state import runtime_stage_projection
    from harness_codex.runtime.xml_gate_authority import verification_routing_from_xml
    from harness_codex.runtime.xml_harvest_state_patch import (
        activate_harvest_xml_context,
        copy_harvest_evidence,
    )

    if getattr(dashboard, _PATCHED_ATTR, False):
        return

    original_project = dashboard._project_workflow_stages
    original_dashboard_state = _unwrap_legacy_dashboard_reader(dashboard.document_dashboard_state)

    def scoped_workflow_state(root: Path, change_set_id: str, lifecycle: str):
        if lifecycle != "active":
            return None
        return load_ui_session(root, change_set_id)

    def candidate_use_cases(root: Path, change_set_id: str) -> tuple[str, ...]:
        state = load_canonical_change_set_state(root, change_set_id)
        if state is None:
            return ()
        ids = state.affected_use_cases or tuple(
            item.work_item_id
            for item in state.work_item_states
            if item.work_item_type.value == "use_case"
        )
        return tuple(item for item in ids if item.startswith("UC-"))

    def project_xml_stages(
        stages: list[dict[str, str]],
        workflow_state: dict[str, Any] | None,
        run_state=None,
        work_items=None,
        pull_request=None,
    ):
        clean = [
            {**stage, "status": "pending", "notes": "-", "source": "xml"}
            for stage in stages
        ]
        return original_project(clean, workflow_state, run_state, work_items, pull_request)

    def no_markdown_reconcile(_repo_root, _state) -> None:
        return None

    def xml_gate(repo_root, change_set_id, target_stage_id, *, uc_id=None) -> None:
        del uc_id
        state = load_canonical_change_set_state(repo_root, change_set_id)
        if state is None:
            raise ValueError(f"{target_stage_id} is blocked: canonical XML state is missing")
        ids = [item.stage_id for item in PROCEDURE_STAGES]
        target = ids.index(target_stage_id)
        rows = runtime_stage_projection(state)
        incomplete = [item for item in ids[:target] if rows.get(item, {}).get("status") != "verified"]
        if incomplete:
            raise ValueError(f"{target_stage_id} is blocked: " + ", ".join(incomplete))

    def strict_load_changeset(root: Path | str, change_set_id: str):
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_harvest_xml_context(root_path, change_set_id)
        session = load_ui_session(root_path, change_set_id)
        if session is None:
            raise ValueError(
                f"Resume unavailable for {change_set_id}: canonical XML UI state is missing."
            )
        harvest_ui._normalize_session(session)
        harvest_ui._sync_use_case_readiness(root_path, session)
        harvest_ui._normalize_resumed_stage(session)
        save_ui_session(root_path, change_set_id, session)
        copy_harvest_evidence(harvest_ui, root_path, change_set_id, session)
        return harvest_ui._result(
            root_path,
            session,
            artifact_root=harvest_ui._changeset_session_root(root_path, change_set_id),
        )

    def strict_save_changeset(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_harvest_xml_context(root_path, change_set_id)
        session = harvest_ui._load_session(root_path)
        if session is None:
            raise ValueError("harvest session has not started")
        save_ui_session(root_path, change_set_id, session)
        copy_harvest_evidence(harvest_ui, root_path, change_set_id, session)

    dashboard._scoped_workflow_state = scoped_workflow_state
    dashboard._integration_candidate_uc_ids = candidate_use_cases
    dashboard._project_workflow_stages = project_xml_stages
    dashboard.document_dashboard_state = original_dashboard_state
    ui_server.document_dashboard_state = original_dashboard_state
    harvest_ui.load_changeset_harvest_ui = strict_load_changeset
    harvest_ui.save_changeset_harvest_ui = strict_save_changeset
    ui_server.load_changeset_harvest_ui = strict_load_changeset
    ui_server.save_changeset_harvest_ui = strict_save_changeset
    dashboard.reconcile_procedure_stage_rows = lambda _state, _rows: ()
    run_dashboard._verification_routing = verification_routing_from_xml
    canonical.reconcile_change_set_procedure_table = no_markdown_reconcile
    canonical.assert_canonical_stage_gate = xml_gate
    setattr(dashboard, _PATCHED_ATTR, True)
