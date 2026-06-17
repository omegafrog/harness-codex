"""Validation helpers for document contract registries."""

from __future__ import annotations

from collections import Counter

from harness_codex.runtime.contracts.models import DocumentContract


class DocumentContractRegistryError(ValueError):
    """Raised when a document contract registry is invalid."""


def validate_contracts(contracts: tuple[DocumentContract, ...]) -> None:
    """Validate registry invariants that downstream tools rely on."""

    if not contracts:
        raise DocumentContractRegistryError("contracts must not be empty")

    _reject_duplicates("doc_type", (contract.doc_type for contract in contracts))
    _reject_duplicates(
        "path_pattern", (contract.path_pattern for contract in contracts)
    )

    doc_types = {contract.doc_type for contract in contracts}
    for contract in contracts:
        if not contract.consumes:
            raise DocumentContractRegistryError(
                f"{contract.doc_type} must declare consumed fields"
            )
        if not contract.produces:
            raise DocumentContractRegistryError(
                f"{contract.doc_type} must declare produced fields"
            )
        if not contract.gates:
            raise DocumentContractRegistryError(f"{contract.doc_type} must declare gates")
        if not contract.dashboard_fields:
            raise DocumentContractRegistryError(
                f"{contract.doc_type} must declare dashboard fields"
            )
        if not (
            contract.producer.skill
            or contract.producer.agent
            or contract.producer.runtime
        ):
            raise DocumentContractRegistryError(
                f"{contract.doc_type} must declare at least one producer identity"
            )

        unknown_edges = [
            target
            for target in contract.stales_downstream
            if target not in doc_types
        ]
        if unknown_edges:
            joined = ", ".join(sorted(unknown_edges))
            raise DocumentContractRegistryError(
                f"{contract.doc_type} has unknown downstream contract(s): {joined}"
            )


def _reject_duplicates(label: str, values) -> None:
    counts = Counter(values)
    duplicates = sorted(value for value, count in counts.items() if count > 1)
    if duplicates:
        joined = ", ".join(duplicates)
        raise DocumentContractRegistryError(f"duplicate {label}: {joined}")
