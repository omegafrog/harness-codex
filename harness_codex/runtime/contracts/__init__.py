"""Document contract registry and dashboard projection API."""

from harness_codex.runtime.contracts.dashboard_projection import (
    DocumentContractDashboardRow,
    contract_dashboard_projection,
    contract_dashboard_projection_json,
    document_contract_dashboard_rows,
)
from harness_codex.runtime.contracts.models import (
    DEFAULT_DASHBOARD_FIELDS,
    DocumentContract,
    DocumentProducer,
)
from harness_codex.runtime.contracts.registry import (
    DEFAULT_CONTRACT_REGISTRY_PATH,
    DocumentContractRegistry,
    load_document_contract_registry,
    load_document_contract_registry_text,
)
from harness_codex.runtime.contracts.validators import DocumentContractRegistryError

__all__ = [
    "DEFAULT_CONTRACT_REGISTRY_PATH",
    "DEFAULT_DASHBOARD_FIELDS",
    "DocumentContract",
    "DocumentContractDashboardRow",
    "DocumentContractRegistry",
    "DocumentContractRegistryError",
    "DocumentProducer",
    "contract_dashboard_projection",
    "contract_dashboard_projection_json",
    "document_contract_dashboard_rows",
    "load_document_contract_registry",
    "load_document_contract_registry_text",
]
