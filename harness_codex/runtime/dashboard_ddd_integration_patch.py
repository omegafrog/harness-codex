"""Adapt dashboard DDD projection to the candidate-plus-integration workflow."""

from __future__ import annotations

from pathlib import Path


def apply_dashboard_ddd_integration_patch() -> None:
    """Keep candidate DDD independent from the shared architecture baseline."""

    try:
        from harness_codex.runtime import dashboard_runtime_state as dashboard
    except ImportError:
        return

    if not getattr(dashboard, "_ddd_integration_projection_patch_applied", False):
        original = dashboard._dashboard_stage_artifacts

        def project_candidate_ddd_artifacts(
            root: Path,
            session: dict[str, object],
            affected_use_cases: tuple[str, ...],
        ):
            artifacts = original(root, session, affected_use_cases)
            ddd_state = session.get("ddd_architecture")
            if not isinstance(ddd_state, dict) or not ddd_state.get("complete"):
                return artifacts

            uc_ids = tuple(str(item) for item in ddd_state.get("uc_ids", ()) if str(item))
            if uc_ids:
                paths = [Path("docs/use-cases") / uc_id / "ddd-design.md" for uc_id in uc_ids]
                dashboard._add_artifact(artifacts, "ddd-architecture-definition", root, paths)
            return artifacts

        dashboard._dashboard_stage_artifacts = project_candidate_ddd_artifacts
        dashboard._ddd_integration_projection_patch_applied = True

    from harness_codex.runtime.dashboard_ddd_integration_rerun_patch import (
        apply_dashboard_ddd_integration_rerun_patch,
    )
    from harness_codex.runtime.dashboard_ddd_integration_ui_patch import (
        apply_dashboard_ddd_integration_ui_patch,
    )
    from harness_codex.runtime.procedure_stage_runtime_state_preservation_patch import (
        apply_procedure_stage_runtime_state_preservation_patch,
    )
    from harness_codex.runtime.xml_document_dashboard_patch import (
        apply_xml_document_dashboard_patch,
    )
    from harness_codex.runtime.xml_ui_state_patch import apply_xml_ui_state_patch

    apply_procedure_stage_runtime_state_preservation_patch()
    apply_dashboard_ddd_integration_ui_patch()
    apply_dashboard_ddd_integration_rerun_patch()
    apply_xml_ui_state_patch()
    apply_xml_document_dashboard_patch()
