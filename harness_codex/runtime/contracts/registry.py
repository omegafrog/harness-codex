"""Load document contract registries."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import yaml

from harness_codex.runtime.contracts.models import DocumentContract, DocumentProducer
from harness_codex.runtime.contracts.validators import (
    DocumentContractRegistryError,
    validate_contracts,
)
from harness_codex.runtime.workflows.schema import (
    require_mapping,
    require_optional_string,
    require_sequence,
    require_string,
)

DEFAULT_CONTRACT_REGISTRY_PATH = Path(".harness/contracts/document-contracts.yaml")


@dataclass(frozen=True)
class DocumentContractRegistry:
    """Deterministic lookup table for harness document contracts."""

    contracts: tuple[DocumentContract, ...]

    def __post_init__(self) -> None:
        validate_contracts(self.contracts)

    def by_doc_type(self, doc_type: str) -> DocumentContract:
        for contract in self.contracts:
            if contract.doc_type == doc_type:
                return contract
        raise KeyError(doc_type)

    def downstream_of(self, doc_type: str) -> tuple[DocumentContract, ...]:
        contract = self.by_doc_type(doc_type)
        return tuple(self.by_doc_type(target) for target in contract.stales_downstream)

    def path_patterns(self) -> tuple[str, ...]:
        return tuple(contract.path_pattern for contract in self.contracts)


def load_document_contract_registry(
    repo_root: Path | str = Path("."),
    registry_path: Path | str = DEFAULT_CONTRACT_REGISTRY_PATH,
) -> DocumentContractRegistry:
    """Load the default document contract registry from a repo root."""

    path = Path(registry_path)
    if not path.is_absolute():
        path = Path(repo_root) / path
    return load_document_contract_registry_text(path.read_text(encoding="utf-8"))


def load_document_contract_registry_text(text: str) -> DocumentContractRegistry:
    """Load registry YAML text into a validated registry."""

    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise DocumentContractRegistryError(f"Invalid contract registry YAML: {exc}") from exc

    root = require_mapping(document, "contract registry")
    raw_contracts = require_sequence(root.get("contracts"), "contracts")
    contracts = tuple(
        _to_contract(require_mapping(raw_contract, f"contracts[{index}]"))
        for index, raw_contract in enumerate(raw_contracts)
    )
    return DocumentContractRegistry(contracts=contracts)


def _to_contract(raw_contract: Mapping[str, Any]) -> DocumentContract:
    producer = _to_producer(raw_contract.get("producer"))
    doc_type = require_string(raw_contract.get("doc_type"), "contracts[].doc_type")
    return DocumentContract(
        doc_type=doc_type,
        path_pattern=require_string(
            raw_contract.get("path_pattern"), f"contracts[{doc_type}].path_pattern"
        ),
        owner_stage=require_string(
            raw_contract.get("owner_stage"), f"contracts[{doc_type}].owner_stage"
        ),
        producer=producer,
        consumes=_string_tuple(
            raw_contract.get("consumes"), f"contracts[{doc_type}].consumes"
        ),
        produces=_string_tuple(
            raw_contract.get("produces"), f"contracts[{doc_type}].produces"
        ),
        gates=_string_tuple(raw_contract.get("gates"), f"contracts[{doc_type}].gates"),
        stales_downstream=_string_tuple(
            raw_contract.get("stales_downstream"),
            f"contracts[{doc_type}].stales_downstream",
        ),
        dashboard_fields=_string_tuple(
            raw_contract.get("dashboard_fields"),
            f"contracts[{doc_type}].dashboard_fields",
        )
        or DocumentContract.dashboard_fields,
    )


def _to_producer(value: Any) -> DocumentProducer:
    producer = require_mapping(value, "contracts[].producer")
    return DocumentProducer(
        skill=require_optional_string(producer.get("skill"), "producer.skill") or "",
        agent=require_optional_string(producer.get("agent"), "producer.agent") or "",
        runtime=require_optional_string(producer.get("runtime"), "producer.runtime") or "",
    )


def _string_tuple(value: Any, path: str) -> tuple[str, ...]:
    if value is None:
        return ()
    sequence = require_sequence(value, path)
    return tuple(require_string(item, f"{path}[]") for item in sequence)
