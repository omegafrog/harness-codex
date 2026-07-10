from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.runtime_services import default_runtime_registry
from harness_codex.runtime.runtime_tool_contract import (
    RuntimeToolRequest,
    request_to_xml,
    result_from_xml,
)


def _run(tmp_path: Path, tool_id: str, operation: str, **payload: object):
    request = RuntimeToolRequest(
        request_id=f"{tool_id}-{operation}",
        tool_id=tool_id,
        operation=operation,
        repo_root=tmp_path,
        input=payload,
    )
    return result_from_xml(default_runtime_registry().run_tool(request_to_xml(request)))


def test_dashboard_memory_and_observability_tools_execute(tmp_path: Path) -> None:
    dashboard = _run(tmp_path, "dashboard-projection", "state")
    memory = _run(tmp_path, "memory", "cache-stats")
    observed = _run(tmp_path, "observability", "emit", run_id="run-1", event={"event_type": "test"})
    events = _run(tmp_path, "observability", "read", run_id="run-1")

    assert dashboard.status == "completed"
    assert dashboard.output == []
    assert memory.status == "completed"
    assert memory.output["cache_files"] == 0
    assert observed.status == "completed"
    assert observed.output["written"] is True
    assert events.status == "completed"
    assert events.output[0]["event_type"] == "test"


def test_dashboard_ui_and_server_lifecycle_tools_return_real_status(tmp_path: Path) -> None:
    ui = _run(tmp_path, "dashboard-ui", "status")
    dev = _run(tmp_path, "dev-server-lifecycle", "status")
    prod = _run(tmp_path, "deploy-server-lifecycle", "status")

    assert ui.status == "completed"
    assert ui.output["status"] == "not-running"
    assert dev.status == "completed"
    assert prod.status == "completed"


def test_shell_tool_rejects_cwd_outside_repo(tmp_path: Path) -> None:
    result = _run(tmp_path, "shell-command", "run", command="pwd", cwd="../")

    assert result.status == "blocked"
    assert result.error_code == "permission-denied"


def test_unknown_runtime_tool_is_blocked(tmp_path: Path) -> None:
    result = _run(tmp_path, "not-a-tool", "run")

    assert result.status == "blocked"
    assert result.error_code == "unknown-tool"
