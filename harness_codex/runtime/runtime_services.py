"""XML-dispatched local runtime services.

Runtime tools execute local capabilities only. They never choose workflow
routes, retries, remediation, or owners.
"""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from harness_codex.runtime.app_runner import run_app_lifecycle
from harness_codex.runtime.changeset_memory import (
    load_memory_documents,
    rebuild_memory_index,
    search_memory as search_changeset_memory,
)
from harness_codex.runtime.dashboard import dashboard_state_json, load_dashboard_runs
from harness_codex.runtime.document_dashboard import document_dashboard_state
from harness_codex.runtime.file_memory_cache import (
    clear_file_cache,
    file_cache_stats,
    read_file_cache,
    warm_file_cache,
)
from harness_codex.runtime.graph_context import (
    build_graph_context,
    graph_context_status,
    query_graph_context,
    rebuild_graph_context,
)
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
from harness_codex.runtime.observability import (
    RunEventWriter,
    read_run_events,
    render_run_metrics,
    summarize_run_events,
    write_run_metrics,
)
from harness_codex.runtime.runtime_tool_contract import (
    RuntimeToolContractError,
    RuntimeToolRequest,
    RuntimeToolResult,
    request_from_xml,
    result_to_xml,
)
from harness_codex.runtime.state import RunStateStore
from harness_codex.runtime.state_projection import write_dashboard_projection


@dataclass(frozen=True)
class RuntimeInstallation:
    repo_root: Path | None
    prepared_directories: tuple[Path, ...] = ()
    registered_gates: tuple[str, ...] = ()
    registered_tools: tuple[str, ...] = ()
    registry: RuntimeServiceRegistry | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class RuntimeGateCondition:
    rule_id: str
    description: str = ""
    predicate: Callable[[Mapping[str, object]], bool] | None = None


@dataclass(frozen=True)
class RuntimeGateResult:
    status: str
    rule_id: str
    reason: str = ""
    evidence_path: str = ""
    violations: tuple[Mapping[str, object], ...] = ()

    def __post_init__(self) -> None:
        if self.status not in {"approved", "rejected"}:
            raise ValueError("gate verdict status must be approved or rejected")

    def as_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "rule_id": self.rule_id,
            "reason": self.reason,
            "evidence_path": self.evidence_path,
            "violations": [dict(item) for item in self.violations],
        }


class RuntimeTool(Protocol):
    tool_id: str

    def run(self, request: RuntimeToolRequest) -> RuntimeToolResult:
        """Run one XML-decoded local capability."""


@dataclass(frozen=True)
class RuntimeToolDefinition:
    tool_id: str
    capability: str
    description: str = ""
    handler: Callable[[RuntimeToolRequest], Any] | None = field(
        default=None,
        compare=False,
        repr=False,
    )

    def run(self, request: RuntimeToolRequest) -> RuntimeToolResult:
        if self.handler is None:
            raise RuntimeToolContractError(f"runtime tool handler is not configured: {self.tool_id}")
        try:
            value = self.handler(request)
        except PermissionError as exc:
            return _error_result(request, "permission-denied", str(exc), "blocked")
        except (OSError, TimeoutError, ValueError, RuntimeError) as exc:
            return _error_result(request, "tool-failed", str(exc), "failed")
        if isinstance(value, RuntimeToolResult):
            return value
        return RuntimeToolResult(
            request_id=request.request_id,
            tool_id=request.tool_id,
            status="completed",
            output=_json_safe(value),
        )


class RuntimeServiceRegistry:
    """Registry dispatching fixed XML requests to local tools."""

    def __init__(self) -> None:
        self._tools: dict[str, RuntimeTool] = {}
        self._gates: dict[str, RuntimeGateCondition] = {}

    def register_tool(self, tool: RuntimeTool) -> None:
        self._tools[tool.tool_id] = tool

    def register_gate(self, condition: RuntimeGateCondition) -> None:
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
            return RuntimeGateResult("approved", rule_id, evidence_path=evidence_path)
        return RuntimeGateResult(
            "rejected",
            rule_id,
            reason=condition.description or "gate condition failed",
            evidence_path=evidence_path,
            violations=({"type": "gate", "rule_id": rule_id},),
        )

    def run_tool(self, request_xml: bytes | str | Path) -> bytes:
        request = request_from_xml(request_xml)
        tool = self._tools.get(request.tool_id)
        if tool is None:
            return result_to_xml(_error_result(request, "unknown-tool", request.tool_id, "blocked"))
        result = tool.run(request)
        if result.request_id != request.request_id or result.tool_id != request.tool_id:
            raise RuntimeToolContractError("tool result requestId/toolId mismatch")
        return result_to_xml(result)

    @property
    def tool_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))

    @property
    def gate_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._gates))


def default_runtime_registry() -> RuntimeServiceRegistry:
    registry = RuntimeServiceRegistry()
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


def _default_runtime_tools() -> tuple[RuntimeToolDefinition, ...]:
    return (
        RuntimeToolDefinition("worktree-setup", "worktree", "Create runtime worktree.", _lifecycle_handler(create_worktree)),
        RuntimeToolDefinition("worktree-status", "worktree", "Read worktree status.", _lifecycle_handler(worktree_status)),
        RuntimeToolDefinition("worktree-cleanup", "worktree", "Remove requested worktree.", _lifecycle_handler(cleanup_worktree)),
        RuntimeToolDefinition("artifact-directories", "artifacts", "Prepare runtime artifact directories.", _lifecycle_handler(prepare_artifact_directories)),
        RuntimeToolDefinition("run-state", "state", "Create, update, append, and read run state.", _run_state_tool),
        RuntimeToolDefinition("execution-report", "report", "Write and read execution report.", _execution_report_tool),
        RuntimeToolDefinition("git-commit-boundary", "git", "Validate and create requested commit.", _lifecycle_handler(prepare_commit)),
        RuntimeToolDefinition("git-merge-boundary", "git", "Merge requested branch.", _lifecycle_handler(merge_commit)),
        RuntimeToolDefinition("work-item-completion", "completion", "Archive completed active plan.", _lifecycle_handler(complete_work_item)),
        RuntimeToolDefinition("dashboard-projection", "dashboard", "Read or write dashboard projection.", _dashboard_projection_tool),
        RuntimeToolDefinition("dashboard-ui", "dashboard-ui", "Start, stop, and health-check dashboard UI.", _dashboard_ui_tool),
        RuntimeToolDefinition("memory", "memory", "Search reviewed memory, cache, and graph context.", _memory_tool),
        RuntimeToolDefinition("observability", "observability", "Record and summarize runtime events.", _observability_tool),
        RuntimeToolDefinition("shell-command", "shell", "Run bounded repo-local command.", _shell_tool),
        RuntimeToolDefinition("dev-server-lifecycle", "dev-server", "Manage dev app lifecycle.", _server_lifecycle_tool),
        RuntimeToolDefinition("deploy-server-lifecycle", "deploy-server", "Manage prod app lifecycle.", _server_lifecycle_tool),
    )


def install_runtime_services(repo_root: Path | str | None = None) -> RuntimeInstallation:
    root = Path(repo_root) if repo_root is not None else None
    directories: tuple[Path, ...] = ()
    if root is not None:
        directories = tuple(
            root / relative
            for relative in (
                Path(".harness/runs"),
                Path(".harness/dashboard"),
                Path(".harness/gates"),
                Path(".harness/tools"),
            )
        )
        for directory in directories:
            directory.mkdir(parents=True, exist_ok=True)
    registry = default_runtime_registry()
    return RuntimeInstallation(
        repo_root=root,
        prepared_directories=directories,
        registered_gates=registry.gate_ids,
        registered_tools=registry.tool_ids,
        registry=registry,
    )


def _lifecycle_handler(handler: Callable[[Mapping[str, object]], Mapping[str, object]]) -> Callable[[RuntimeToolRequest], Mapping[str, object]]:
    def run(request: RuntimeToolRequest) -> Mapping[str, object]:
        return handler(_payload(request))

    return run


def _run_state_tool(request: RuntimeToolRequest) -> Mapping[str, object]:
    payload = _payload(request)
    operation = request.operation.lower()
    if operation == "create":
        return create_run_state(payload)
    if operation == "append_event":
        return append_run_event(payload)
    if operation == "update_status":
        return update_run_status(payload)
    if operation == "read":
        return read_run_state(payload)
    raise ValueError(f"unknown run-state operation: {request.operation}")


def _execution_report_tool(request: RuntimeToolRequest) -> Mapping[str, object]:
    payload = _payload(request)
    if request.operation.lower() == "write":
        return write_execution_report(payload)
    if request.operation.lower() == "read":
        return read_execution_report(payload)
    raise ValueError(f"unknown execution-report operation: {request.operation}")


def _dashboard_projection_tool(request: RuntimeToolRequest) -> Any:
    root = request.repo_root
    operation = request.operation.lower()
    if operation == "state":
        return json.loads(dashboard_state_json(root))
    if operation == "document":
        return document_dashboard_state(root)
    if operation == "runs":
        return [_json_safe(run) for run in load_dashboard_runs(root)]
    if operation == "write":
        run_id = _required(request, "run_id")
        state = RunStateStore(root).load(run_id)
        path = write_dashboard_projection(root, state)
        return {"path": str(path.relative_to(root))}
    raise ValueError(f"unknown dashboard-projection operation: {request.operation}")


def _dashboard_ui_tool(request: RuntimeToolRequest) -> Any:
    from harness_codex.runtime.ui_server import _ui_server_pid_path

    root = request.repo_root
    operation = request.operation.lower()
    host = str(request.input.get("host") or "127.0.0.1")
    port = int(request.input.get("port") or 8765)
    pid_path = _ui_server_pid_path(root)
    if operation == "start":
        if pid_path.is_file():
            return {"status": "already-running", "pid": pid_path.read_text(encoding="utf-8").strip(), "host": host, "port": port}
        process = subprocess.Popen(
            [sys.executable, "-m", "harness_codex.runtime.ui_server", "--repo-root", str(root), "--host", host, "--port", str(port)],
            cwd=root,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"status": "started", "pid": process.pid, "host": host, "port": port}
    if operation == "stop":
        if not pid_path.is_file():
            return {"status": "not-running"}
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        os.kill(pid, signal.SIGTERM)
        return {"status": "stopped", "pid": pid}
    if operation == "status":
        pid = pid_path.read_text(encoding="utf-8").strip() if pid_path.is_file() else ""
        return {"status": "running" if pid else "not-running", "pid": pid, "host": host, "port": port}
    if operation == "health":
        try:
            with urllib.request.urlopen(f"http://{host}:{port}/api/endpoints", timeout=float(request.input.get("timeout", 3))) as response:
                return {"status": "healthy", "http_status": response.status, "url": response.url}
        except (OSError, urllib.error.URLError) as exc:
            return _error_result(request, "ui-unhealthy", str(exc), "blocked")
    raise ValueError(f"unknown dashboard-ui operation: {request.operation}")


def _memory_tool(request: RuntimeToolRequest) -> Any:
    root = request.repo_root
    operation = request.operation.lower()
    if operation == "list":
        return [_json_safe(item) for item in load_memory_documents(root)]
    if operation == "search":
        hits = search_changeset_memory(root, _required(request, "query"))
        return [_json_safe(hit) for hit in hits]
    if operation == "reindex":
        return {"path": str(rebuild_memory_index(root).relative_to(root))}
    if operation == "cache-read":
        result = read_file_cache(root, _required(request, "path"), max_bytes=int(request.input.get("max_bytes", 1024 * 1024)))
        return _json_safe(result)
    if operation == "cache-warm":
        return _json_safe(warm_file_cache(root, request.input.get("paths", ()), max_bytes=int(request.input.get("max_bytes", 1024 * 1024))))
    if operation == "cache-stats":
        return file_cache_stats(root)
    if operation == "cache-clear":
        return {"cleared": clear_file_cache(root)}
    if operation == "graph-status":
        return _json_safe(graph_context_status(root))
    if operation == "graph-build":
        return _json_safe(build_graph_context(root, request.input.get("paths", ()), backend=request.input.get("backend"), model=request.input.get("model"), token_budget=request.input.get("token_budget"), no_cluster=bool(request.input.get("no_cluster", False))))
    if operation == "graph-rebuild":
        return _json_safe(rebuild_graph_context(root))
    if operation == "graph-query":
        return {"result": query_graph_context(root, _required(request, "query"), budget=int(request.input.get("budget", 1200)), dfs=bool(request.input.get("dfs", False)))}
    raise ValueError(f"unknown memory operation: {request.operation}")


def _observability_tool(request: RuntimeToolRequest) -> Any:
    root = request.repo_root
    run_id = _required(request, "run_id")
    operation = request.operation.lower()
    if operation == "emit":
        writer = RunEventWriter(root, run_id)
        ok = writer._append(dict(request.input.get("event", {})))
        return {"written": ok, "path": str(writer.path.relative_to(root))}
    if operation == "read":
        return list(read_run_events(root, run_id))
    if operation == "metrics-write":
        return {"path": str(write_run_metrics(root, run_id).relative_to(root))}
    if operation == "metrics-summary":
        return summarize_run_events(read_run_events(root, run_id), run_id=run_id)
    if operation == "metrics-render":
        return {"text": render_run_metrics(summarize_run_events(read_run_events(root, run_id), run_id=run_id))}
    raise ValueError(f"unknown observability operation: {request.operation}")


def _shell_tool(request: RuntimeToolRequest) -> Any:
    root = request.repo_root.resolve()
    command = request.input.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("shell command is required")
    cwd = (root / str(request.input.get("cwd") or ".")).resolve()
    if cwd != root and root not in cwd.parents:
        raise PermissionError("shell cwd must stay inside repo root")
    if not cwd.is_dir():
        raise ValueError(f"shell cwd does not exist: {cwd}")
    timeout = float(request.input.get("timeout", 60))
    if timeout <= 0 or timeout > 900:
        raise ValueError("shell timeout must be between 0 and 900 seconds")
    env = {key: str(value) for key, value in dict(request.input.get("env", {})).items() if key in {"CI", "PATH", "PYTHONPATH", "NODE_ENV"}}
    completed = subprocess.run(shlex.split(command), cwd=cwd, env={**os.environ, **env}, capture_output=True, text=True, timeout=timeout, check=False)
    limit = int(request.input.get("output_limit", 64 * 1024))
    output = {"exit_code": completed.returncode, "stdout": completed.stdout[:limit], "stderr": completed.stderr[:limit], "cwd": str(cwd.relative_to(root))}
    if completed.returncode:
        return _error_result(request, "command-failed", completed.stderr.strip() or f"exit code {completed.returncode}", "failed", output)
    return output


def _server_lifecycle_tool(request: RuntimeToolRequest) -> Any:
    environment = str(request.input.get("environment") or ("dev" if request.tool_id.startswith("dev-") else "prod"))
    action = request.operation.lower()
    if action not in {"start", "stop", "health", "deploy", "status", "env"}:
        raise ValueError(f"unknown server lifecycle operation: {request.operation}")
    args = request.input.get("args", ())
    if not isinstance(args, (list, tuple)):
        raise ValueError("server lifecycle args must be a list")
    return {"environment": environment, "action": action, "result": run_app_lifecycle(request.repo_root, (environment, action, *(str(item) for item in args)), timeout=int(request.input.get("timeout", 60)))}


def _payload(request: RuntimeToolRequest) -> dict[str, object]:
    payload = {**request.input, "repo_root": str(request.repo_root)}
    if request.run_id:
        payload["run_id"] = request.run_id
    if request.work_item_id:
        payload["work_item_id"] = request.work_item_id
    return payload


def _required(request: RuntimeToolRequest, key: str) -> str:
    value = request.input.get(key)
    if value is None or not str(value).strip():
        raise ValueError(f"runtime tool input requires {key}")
    return str(value)


def _error_result(request: RuntimeToolRequest, code: str, message: str, status: str, output: Any = None) -> RuntimeToolResult:
    return RuntimeToolResult(request.request_id, request.tool_id, status, {} if output is None else output, code, message)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {key: _json_safe(getattr(value, key)) for key in value.__dataclass_fields__}
    return str(value)


__all__ = [
    "RuntimeInstallation",
    "RuntimeServiceRegistry",
    "RuntimeTool",
    "RuntimeToolDefinition",
    "default_runtime_registry",
    "install_runtime_services",
]
