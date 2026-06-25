from pathlib import Path

from harness_codex.runtime.procedure_stages import procedure_stage


def test_ddd_candidate_and_integration_allow_missing_architecture_baseline() -> None:
    candidate = procedure_stage("ddd-architecture-definition")
    integration = procedure_stage("ddd-design-integration")

    assert candidate.display_name == "DDD Architecture Definition"
    assert Path("ARCHITECTURE.md") not in candidate.inputs
    assert Path("ARCHITECTURE.md") not in integration.inputs
    assert not integration.requires_uc
