"""Keep stable stage labels and optional DDD baseline inputs compatible."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path


_OPTIONAL_BASELINE = Path("ARCHITECTURE.md")


def apply_procedure_stage_compatibility_patch() -> None:
    """Apply compatibility rules before public stage consumers read the registry."""

    import harness_codex.runtime.procedure_stages as stages

    if getattr(stages, "_ddd_stage_compatibility_patch_applied", False):
        return

    patched: list[stages.ProcedureStage] = []
    for stage in stages.PROCEDURE_STAGES:
        if stage.stage_id == "ddd-architecture-definition":
            patched.append(
                replace(
                    stage,
                    display_name="DDD Architecture Definition",
                    inputs=tuple(path for path in stage.inputs if path != _OPTIONAL_BASELINE),
                )
            )
        elif stage.stage_id == "ddd-design-integration":
            patched.append(
                replace(
                    stage,
                    inputs=tuple(path for path in stage.inputs if path != _OPTIONAL_BASELINE),
                )
            )
        else:
            patched.append(stage)

    stages.PROCEDURE_STAGES = tuple(patched)
    stages.PROCEDURE_STAGE_BY_ID = {
        stage.stage_id: stage for stage in stages.PROCEDURE_STAGES
    }
    stages._ddd_stage_compatibility_patch_applied = True
