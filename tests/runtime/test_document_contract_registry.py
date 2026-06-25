from pathlib import Path

import pytest

from harness_codex.runtime.contracts import (
    DocumentContractRegistryError,
    document_contract_dashboard_rows,
    load_document_contract_registry,
    load_document_contract_registry_text,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_default_document_contract_registry_loads_deterministically() -> None:
    registry = load_document_contract_registry(REPO_ROOT)

    assert registry.by_doc_type("ubiquitous_language").path_pattern == (
        "docs/design/ubiquitous-language.md"
    )
    assert registry.by_doc_type("use_case_slice").owner_stage == "use-case-definition"
    assert registry.by_doc_type("run_state").path_pattern == (
        ".harness/runs/<RUN-ID>/state.json"
    )

    assert registry.path_patterns() == tuple(
        contract.path_pattern for contract in registry.contracts
    )


def test_registry_covers_known_harness_artifact_path_patterns() -> None:
    registry = load_document_contract_registry(REPO_ROOT)

    expected_patterns = {
        "docs/design/ubiquitous-language.md",
        "docs/design/요구사항.md",
        "docs/design/유스케이스.md",
        "docs/changes/active/<CHG-ID>.md",
        "docs/changes/completed/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/index.md",
        "docs/use-cases/<UC-ID>/use-case.md",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/use-cases/<UC-ID>/event-storming.md",
        "docs/use-cases/<UC-ID>/ddd-design.md",
        "docs/use-cases/<UC-ID>/technical-decisions.md",
        "docs/use-cases/<UC-ID>/affected-files.md",
        "docs/maintenance/<MAINT-ID>/index.md",
        "docs/maintenance/<MAINT-ID>/change-intent.md",
        "docs/maintenance/<MAINT-ID>/technical-decisions.md",
        "docs/maintenance/<MAINT-ID>/affected-files.md",
        "docs/maintenance/<MAINT-ID>/verification-goal.md",
        "docs/plans/active/<WORK-ITEM-ID>/plan.md",
        "docs/plans/completed/<WORK-ITEM-ID>/plan.md",
        ".harness/runs/<RUN-ID>/state.json",
    }

    assert expected_patterns <= set(registry.path_patterns())


def test_registry_validates_downstream_stale_edges() -> None:
    registry = load_document_contract_registry(REPO_ROOT)

    assert tuple(
        contract.doc_type for contract in registry.downstream_of("ubiquitous_language")
    ) == (
        "requirements",
        "use_case_index",
        "use_case_slice",
        "e2e_goal",
        "event_storming",
        "ddd_design",
        "technical_decisions",
        "active_plan",
    )
    assert tuple(
        contract.doc_type for contract in registry.downstream_of("use_case_slice")
    ) == (
        "e2e_goal",
        "event_storming",
        "ddd_design",
        "technical_decisions",
        "active_plan",
    )
    assert tuple(
        contract.doc_type for contract in registry.downstream_of("technical_decisions")
    ) == ("active_plan", "run_state")


def test_registry_rejects_unknown_downstream_edges() -> None:
    text = """
contracts:
  - doc_type: source
    path_pattern: source.md
    owner_stage: stage
    producer:
      runtime: test
    consumes: [input.field]
    produces: [output.field]
    gates: [gate]
    stales_downstream: [missing]
    dashboard_fields: [status]
"""

    with pytest.raises(
        DocumentContractRegistryError,
        match="source has unknown downstream contract",
    ):
        load_document_contract_registry_text(text)


def test_dashboard_projection_exposes_contract_rows() -> None:
    registry = load_document_contract_registry(REPO_ROOT)
    rows = document_contract_dashboard_rows(registry)

    context_row = rows[0]
    assert context_row.doc_type == "ubiquitous_language"
    assert context_row.path_pattern == "docs/design/ubiquitous-language.md"
    assert context_row.dashboard_fields == (
        "status",
        "blocker",
        "approval_status",
        "checksum",
        "stale",
    )
