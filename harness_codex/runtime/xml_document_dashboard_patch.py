"""Install XML-backed dashboard state readers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from harness_codex.runtime.xml_ui_state import load_ui_session

_PATCHED_ATTR = "_harness_xml_document_dashboard_patch_applied"


def apply_xml_document_dashboard_patch() -> None:
    """Remove dashboard fallback reads from Markdown status and UI JSON files."""

    from harness_codex.runtime import dashboard as run_dashboard
    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import document_dashboard as dashboard
    from harness_codex.runtime.dashboard_runtime_state import load_canonical_change_set_state
    from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES
    from harness_codex.runtime.state import runtime_stage_projection
    from harness_codex.runtime.xml_gate_authority import verification_routing_from_xml

    if getattr(dashboard, _PATCHED_ATTR, False):
        return

    original_project = dashboard._project_workflow_stages

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

    dashboard._scoped_workflow_state = scoped_workflow_state
    dashboard._integration_candidate_uc_ids = candidate_use_cases
    dashboard._project_workflow_stages = project_xml_stages
    dashboard.reconcile_procedure_stage_rows = lambda _state, _rows: ()
    run_dashboard._verification_routing = verification_routing_from_xml
    canonical.reconcile_change_set_procedure_table = no_markdown_reconcile
    canonical.assert_canonical_stage_gate = xml_gate
    setattr(dashboard, _PATCHED_ATTR, True)
