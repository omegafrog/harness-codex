import importlib
from pathlib import Path

import harness_codex.runtime.procedure_stage_compatibility_patch as compatibility
import harness_codex.runtime.procedure_stages as stages


def test_candidate_stage_excludes_architecture_but_integration_keeps_it() -> None:
    importlib.reload(stages)
    importlib.reload(compatibility)

    compatibility.apply_procedure_stage_compatibility_patch()

    candidate = stages.PROCEDURE_STAGE_BY_ID["ddd-architecture-definition"]
    integration = stages.PROCEDURE_STAGE_BY_ID["ddd-design-integration"]

    assert Path("ARCHITECTURE.md") not in candidate.inputs
    assert Path("ARCHITECTURE.md") in integration.inputs
