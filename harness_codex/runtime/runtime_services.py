"""Explicit runtime service interfaces allowed below the workflow brain.

This module is the boundary #472 asks for: runtime exposes local services, while
an orchestration agent decides workflow progression, routing, retry, and
remediation. The services below are deliberately verdict/result oriented and do
not carry owner-stage or resume-target decisions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Mapping, Protocol, Sequence

from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


@dataclass(frozen=True)
class RuntimeInstallation:
    """Result of one explicit runtime installer invocation."""

    repo_root: Path | None
    prepared_directories: tuple[Path, ...] = ()
    registered_schemas: tuple[str, ...] = ()
    registered_gates: tuple[str, ...] = ()
    registered_tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimeSchema:
    """Named XML or JSON payload contract registered with runtime."""

    schema_id: str
    required_fields: tuple[str, ...] = ()
    optional_fields: tuple[str, ...] = ()
    description: str = ""


@dataclass(frozen=True)
class RuntimeSchemaValidationResult:
    """Schema validation result without routing advice."""

    status: str
    schema_id: str
    reason: str = ""
    violations: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimeGateCondition:
    """A static gate rule evaluated by runtime."""

    rule_id: str
    description: str = ""
    predicate: Callable[[Mapping[str, object]], bool] | None = None


@dataclass(frozen=True)
class RuntimeGateResult:
    """Gate verdict returned to an orchestrator."""

    status: str
    rule_id: str
    reason: str = ""
    evidence_path: str = ""
    violations: tuple[Mapping[str, object], ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "rule_id": self.rule_id,
            "reason": self.reason,
            "evidence_path": self.evidence_path,
            "violations": [dict(item) for item in self.violations],
        }


class RuntimeTool(Protocol):
    """Local runtime tool that returns data, not route decisions."""

    tool_id: str

    def run(self, payload: Mapping[str, object]) -> Mapping[str, object]:
        """Execute one local tool call and return a structured result."""
        ...


class RuntimeServiceRegistry:
    """In-memory registry for runtime schemas, gates, and local tools."""

    def __init__(self) -> None:
        self._schemas: dict[str, RuntimeSchema] = {}
        self._gates: dict[str, RuntimeGateCondition] = {}
        self._tools: dict[str, RuntimeTool] = {}

    def register_schema(self, schema: RuntimeSchema) -> None:
        self._schemas[schema.schema_id] = schema

    def update_schema(self, schema: RuntimeSchema) -> None:
        if schema.schema_id not in self._schemas:
            raise KeyError(f"Unknown schema: {schema.schema_id}")
        self._schemas[schema.schema_id] = schema

    def validate_schema(self, schema_id: str, payload: Mapping[str, object]) -> RuntimeSchemaValidationResult:
        schema = self._schemas[schema_id]
        missing = tuple(field for field in schema.required_fields if field not in payload)
        if missing:
            return RuntimeSchemaValidationResult(
                status="fail",
                schema_id=schema_id,
                reason="missing required fields",
                violations=missing,
            )
        return RuntimeSchemaValidationResult(status="pass", schema_id=schema_id)

    def register_gate(self, condition: RuntimeGateCondition) -> None:
        self._gates[condition.rule_id] = condition

    def update_gate(self, condition: RuntimeGateCondition) -> None:
        if condition.rule_id not in self._gates:
            raise KeyError(f"Unknown gate: {condition.rule_id}")
        self._gates[condition.rule_id] = condition

    def run_gate(
        self,
        rule_id: str,
        payload: Mapping[str, object],
        *,
        evidence_path: str = "",
    ) -> RuntimeGateResult:
        condition = self._gates[rule_id]
        if condition.predicate is None or condition.predicate(payload):
            return RuntimeGateResult(status="pass", rule_id=rule_id, evidence_path=evidence_path)
        return RuntimeGateResult(
            status="fail",
            rule_id=rule_id,
            reason=condition.description or "gate condition failed",
            evidence_path=evidence_path,
            violations=({"type": "gate", "rule_id": rule_id},),
        )

    def register_tool(self, tool: RuntimeTool) -> None:
        self._tools[tool.tool_id] = tool

    def run_tool(self, tool_id: str, payload: Mapping[str, object]) -> Mapping[str, object]:
        return self._tools[tool_id].run(payload)

    @property
    def schema_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._schemas))

    @property
    def gate_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._gates))

    @property
    def tool_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))


def default_runtime_registry() -> RuntimeServiceRegistry:
    """Build the default runtime service registry without monkey patching."""

    registry = RuntimeServiceRegistry()
    registry.register_schema(
        RuntimeSchema(
            schema_id="verification-report",
            required_fields=("status", "failure_class", "verdict"),
            optional_fields=("evidence", "evidence_items"),
            description="Verifier report. Verdict only; no routing fields.",
        )
    )
    registry.register_schema(
        RuntimeSchema(
            schema_id="gate-verdict",
            required_fields=("status",),
            optional_fields=("rule_id", "reason", "evidence_path", "violations"),
            description="Static gate verdict returned to orchestration.",
        )
    )
    registry.register_gate(
        RuntimeGateCondition(
            rule_id="verdict-status-present",
            description="Payload must include a non-empty status field.",
            predicate=lambda payload: bool(str(payload.get("status") or "").strip()),
        )
    )
    return registry


def install_runtime_services(repo_root: Path | str | None = None) -> RuntimeInstallation:
    """Prepare runtime-owned local directories and register default services.

    This is an installer, not a patch registry. It does not import compatibility
    patch modules, replace callables, or install import-time side effects.
    """

    registry = default_runtime_registry()
    if repo_root is None:
        return RuntimeInstallation(
            repo_root=None,
            registered_schemas=registry.schema_ids,
            registered_gates=registry.gate_ids,
            registered_tools=registry.tool_ids,
        )

    root = Path(repo_root)
    directories = (
        root / ".harness" / "runs",
        root / ".harness" / "dashboard",
        root / ".harness" / "schemas",
        root / ".harness" / "gates",
        root / ".harness" / "tools",
    )
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "schemas": list(registry.schema_ids),
        "gates": list(registry.gate_ids),
        "tools": list(registry.tool_ids),
    }
    write_handoff(root / ".harness" / "runtime-services.xml", "runtime-services", manifest)
    return RuntimeInstallation(
        repo_root=root,
        prepared_directories=directories,
        registered_schemas=registry.schema_ids,
        registered_gates=registry.gate_ids,
        registered_tools=registry.tool_ids,
    )


def load_runtime_services_manifest(repo_root: Path | str) -> Mapping[str, object]:
    """Read the installer manifest written by ``install_runtime_services``."""

    return read_handoff(Path(repo_root) / ".harness" / "runtime-services.xml", expected_type="runtime-services")


def runtime_services_manifest_json(repo_root: Path | str) -> str:
    """Return the installed runtime service manifest as deterministic JSON."""

    return json.dumps(load_runtime_services_manifest(repo_root), ensure_ascii=False, indent=2) + "\n"
