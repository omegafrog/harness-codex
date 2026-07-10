from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.runtime_tool_contract import (
    RuntimeToolContractError,
    RuntimeToolRequest,
    RuntimeToolResult,
    request_from_xml,
    request_to_xml,
    result_from_xml,
    result_to_xml,
)


def test_runtime_tool_request_round_trips_nested_project_payload(tmp_path: Path) -> None:
    request = RuntimeToolRequest(
        request_id="req-1",
        tool_id="memory",
        operation="graph-query",
        repo_root=tmp_path,
        run_id="run-1",
        work_item_id="WI-1",
        input={"query": "boundary", "options": {"dfs": True, "budget": 400}},
    )

    assert request_from_xml(request_to_xml(request)) == request


def test_runtime_tool_result_round_trips_error_and_evidence() -> None:
    result = RuntimeToolResult(
        request_id="req-1",
        tool_id="shell-command",
        status="failed",
        output={"exit_code": 2},
        error_code="command-failed",
        error_message="failed",
        evidence=(".harness/runs/run-1/stderr.txt",),
    )

    assert result_from_xml(result_to_xml(result)) == result


@pytest.mark.parametrize(
    "xml",
    (
        b"<wrong />",
        b'<runtime-tool-request schemaVersion="2" requestId="r" toolId="x" operation="y" />',
        b'<runtime-tool-request schemaVersion="1" requestId="r" toolId="x" operation="y"><context repoRoot="."/><input><value kind="map"><entry key="x"><value kind="string">a</value><value kind="string">b</value></entry></value></input></runtime-tool-request>',
    ),
)
def test_runtime_tool_request_rejects_malformed_xml(xml: bytes) -> None:
    with pytest.raises(RuntimeToolContractError):
        request_from_xml(xml)


def test_runtime_tool_result_rejects_errorless_failure() -> None:
    with pytest.raises(RuntimeToolContractError, match="requires error"):
        result_to_xml(RuntimeToolResult("r", "tool", "failed"))


def test_runtime_tool_result_rejects_routing_fields() -> None:
    with pytest.raises(RuntimeToolContractError, match="routing fields"):
        result_to_xml(RuntimeToolResult("r", "tool", "completed", {"nested": {"retry": True}}))
