"""Keep stable public stage labels while DDD candidate semantics evolve."""

from __future__ import annotations

from dataclasses import replace


def apply_procedure_stage_compatibility_patch() -> None:
    """Preserve the durable DDD stage label used in ChangeSet tables and dashboard tests."""

    import harness_codex.runtime.procedure_stages as stages

    if getattr(stages, "_ddd_stage_display_name_patch_applied", False):
        return

    stages.PROCEDURE_STAGES = tuple(
        replace(stage, display_name="DDD Architecture Definition")
        if stage.stage_id == "ddd-architecture-definition"
        else stage
        for stage in stages.PROCEDURE_STAGES
    )
    stages.PROCEDURE_STAGE_BY_ID = {
        stage.stage_id: stage for stage in stages.PROCEDURE_STAGES
    }
    stages._ddd_stage_display_name_patch_applied = True
