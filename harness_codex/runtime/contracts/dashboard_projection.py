"""Dashboard projection for document contracts."""

from __future__ import annotations

from dataclasses import dataclass

from harness_codex.runtime.contracts.registry import DocumentContractRegistry


@dataclass(frozen=True)
class DocumentContractDashboardRow:
    """Small dashboard-safe row for one document contract."""

    doc_type: str
    path_pattern: str
    owner_stage: str
    dashboard_fields: tuple[str, ...]
    stales_downstream: tuple[str, ...]


def document_contract_dashboard_rows(
    registry: DocumentContractRegistry,
) -> tuple[DocumentContractDashboardRow, ...]:
    """Project contracts into deterministic dashboard rows."""

    return tuple(
        DocumentContractDashboardRow(
            doc_type=contract.doc_type,
            path_pattern=contract.path_pattern,
            owner_stage=contract.owner_stage,
            dashboard_fields=contract.dashboard_fields,
            stales_downstream=contract.stales_downstream,
        )
        for contract in registry.contracts
    )
