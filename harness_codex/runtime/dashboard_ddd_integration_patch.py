"""Adapt dashboard DDD projection to the candidate-plus-integration workflow."""

from __future__ import annotations

from pathlib import Path


def apply_dashboard_ddd_integration_patch() -> None:
    """Keep candidate DDD independent from the shared architecture baseline.

    The dashboard runtime state module is optional on older runtime revisions.  When
    present, its legacy DDD completion check required ``ARCHITECTURE.md`` and would
    therefore force an individual UC candidate stage to mutate the shared model.
    The patch records verified candidate documents only; the separate integration
    stage remains required before downstream canonical gates can pass.
    """

    try:
        from harness_codex.runtime import dashboard_runtime_state as dashboard
    except ImportError:
        return

    if getattr(dashboard, "_ddd_integration_projection_patch_applied", False):
        return

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
        if not uc_ids:
            return artifacts
        paths = [Path("docs/use-cases") / uc_id / "ddd-design.md" for uc_id in uc_ids]
        dashboard._add_artifact(artifacts, "ddd-architecture-definition", root, paths)
        return artifacts

    dashboard._dashboard_stage_artifacts = project_candidate_ddd_artifacts
    dashboard._ddd_integration_projection_patch_applied = True
