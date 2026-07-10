"""Explicit runtime service interfaces allowed below the workflow brain.

This module is the boundary #472 asks for: runtime exposes local services, while
an orchestration agent decides workflow progression, routing, retry, and
remediation. The services below are deliberately verdict/result oriented and do
not carry owner-stage or resume-target decisions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Protocol

from harness_codex.runtime.lifecycle_services import (
    append_run_event,
    cleanup_worktree,
    complete_work_item,
    create_run_state,
    create_worktree,
    merge_commit,
    prepare_artifact_directories,
    prepare_commit,
    read_execution_report,
    read_run_state,
    update_run_status,
    worktree_status,
    write_execution_report,
)


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


@dataclass(frozen=True)
class RuntimeLocalTool:
    """Registered local runtime capability.

    The default tools intentionally return capability data when no handler is
    bound. This keeps service discovery executable without letting the registry
    become a workflow router.
    """

    tool_id: str
    capability: str
    description: str = ""
    handler: Callable[[Mapping[str, object]], Mapping[str, object]] | None = field(
        default=None,
        compare=False,
        repr=False,
    )

    def run(self, payload: Mapping[str, object]) -> Mapping[str, object]:
        if self.handler is not None:
            return self.handler(payload)
        return {
            "status": "unavailable",
            "tool_id": self.tool_id,
            "capability": self.capability,
            "description": self.description,
            "error": "runtime tool handler is not configured",
        }


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
            schema_id="subagent-invocation-v1",
            required_fields=("identity", "delegate", "instruction", "inputs", "result"),
            optional_fields=("reviewTask",),
            description="Common invocation contract for implementation, verification, and reviewer subagents.",
        )
    )
    registry.register_schema(
        RuntimeSchema(
            schema_id="subagent-result-v1",
            required_fields=("identity", "delegate", "outcome", "artifacts", "evidence", "changes", "blockers"),
            optional_fields=("review",),
            description="Common result contract with one outcome status.",
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
    for tool in _default_runtime_tools():
        registry.register_tool(tool)
    return registry


def _default_runtime_tools() -> tuple[RuntimeLocalTool, ...]:
    return (
        RuntimeLocalTool(
            tool_id="worktree-setup",
            capability="worktree",
            description="Create and initialize runtime-owned worktrees.",
            handler=create_worktree,
        ),
        RuntimeLocalTool(
            tool_id="worktree-status",
            capability="worktree",
            description="Read worktree branch, HEAD, and dirty state.",
            handler=worktree_status,
        ),
        RuntimeLocalTool(
            tool_id="worktree-cleanup",
            capability="worktree",
            description="Remove one explicitly requested runtime worktree.",
            handler=cleanup_worktree,
        ),
        RuntimeLocalTool(
            tool_id="artifact-directories",
            capability="artifacts",
            description="Prepare runtime artifact directories for runs, dashboard, schemas, gates, and tools.",
            handler=prepare_artifact_directories,
        ),
        RuntimeLocalTool(
            tool_id="run-state",
            capability="state",
            description="Create, update, append, and read one run state.",
            handler=_run_state_tool,
        ),
        RuntimeLocalTool(
            tool_id="execution-report",
            capability="report",
            description="Write and read one plan-fingerprinted execution report.",
            handler=_execution_report_tool,
        ),
        RuntimeLocalTool(
            tool_id="git-commit-boundary",
            capability="git",
            description="Validate allowed paths and create one requested commit.",
            handler=prepare_commit,
        ),
        RuntimeLocalTool(
            tool_id="git-merge-boundary",
            capability="git",
            description="Merge one explicitly requested branch and return conflicts as facts.",
            handler=merge_commit,
        ),
        RuntimeLocalTool(
            tool_id="work-item-completion",
            capability="completion",
            description="Validate required plan/report paths and archive one active plan.",
            handler=complete_work_item,
        ),
        RuntimeLocalTool(
            tool_id="dashboard-projection",
            capability="dashboard",
            description="Persist dashboard projections from runtime result data.",
        ),
        RuntimeLocalTool(
            tool_id="dashboard-ui",
            capability="dashboard-ui",
            description="Serve dashboard UI from saved runtime projections.",
        ),
        RuntimeLocalTool(
            tool_id="memory",
            capability="memory",
            description="Read and write runtime-managed memory artifacts.",
        ),
        RuntimeLocalTool(
            tool_id="observability",
            capability="observability",
            description="Collect local runtime metrics and traces.",
        ),
        RuntimeLocalTool(
            tool_id="shell-command",
            capability="shell",
            description="Execute local shell commands as a runtime service.",
        ),
        RuntimeLocalTool(
            tool_id="dev-server-lifecycle",
            capability="dev-server",
            description="Start, stop, and health-check development servers.",
        ),
        RuntimeLocalTool(
            tool_id="deploy-server-lifecycle",
            capability="deploy-server",
            description="Start, stop, and health-check deployment servers.",
        ),
    )


def _run_state_tool(payload: Mapping[str, object]) -> Mapping[str, object]:
    operation = str(payload.get("operation") or "read").strip().lower()
    if operation == "create":
        return create_run_state(payload)
    if operation == "append_event":
        return append_run_event(payload)
    if operation == "update_status":
        return update_run_status(payload)
    return read_run_state(payload)


def _execution_report_tool(payload: Mapping[str, object]) -> Mapping[str, object]:
    operation = str(payload.get("operation") or "read").strip().lower()
    if operation == "write":
        return write_execution_report(payload)
    return read_execution_report(payload)


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
    return RuntimeInstallation(
        repo_root=root,
        prepared_directories=directories,
        registered_schemas=registry.schema_ids,
        registered_gates=registry.gate_ids,
        registered_tools=registry.tool_ids,
    )
