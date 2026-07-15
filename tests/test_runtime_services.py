from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.runtime_services import (
    RuntimeGateCondition,
    default_runtime_registry,
    install_runtime_services,
)
from harness_codex.runtime.runtime_tool_contract import (
    RuntimeToolRequest,
    request_to_xml,
    result_from_xml,
)

EXPECTED_DEFAULT_TOOLS = (
    "artifact-directories",
    "dashboard-projection",
    "dashboard-ui",
    "deploy-server-lifecycle",
    "dev-server-lifecycle",
    "execution-report",
    "git-commit-boundary",
    "git-merge-boundary",
    "memory",
    "observability",
    "run-state",
    "shell-command",
    "work-item-completion",
    "worktree-cleanup",
    "worktree-setup",
    "worktree-status",
)


def test_runtime_gate_registry_returns_verdict_only_results() -> None:
    registry = default_runtime_registry()
    registry.register_gate(
        RuntimeGateCondition(
            rule_id="must-pass",
            description="payload must pass",
            predicate=lambda payload: payload.get("ok") is True,
        )
    )

    passed = registry.run_gate("must-pass", {"ok": True}, evidence_path="evidence.xml")
    failed = registry.run_gate("must-pass", {"ok": False}, evidence_path="evidence.xml")

    assert passed.as_dict() == {
        "status": "approved",
        "rule_id": "must-pass",
        "reason": "",
        "evidence_path": "evidence.xml",
        "violations": [],
    }
    assert failed.as_dict() == {
        "status": "rejected",
        "rule_id": "must-pass",
        "reason": "payload must pass",
        "evidence_path": "evidence.xml",
        "violations": [{"type": "gate", "rule_id": "must-pass"}],
    }
    assert "owner_stage" not in failed.as_dict()
    assert "recommended_resume_target" not in failed.as_dict()


def test_runtime_gate_result_rejects_noncanonical_status() -> None:
    from harness_codex.runtime.runtime_services import RuntimeGateResult

    with pytest.raises(ValueError, match="approved or rejected"):
        RuntimeGateResult("pass", "must-pass")


def test_default_registry_executes_shell_tool(tmp_path: Path) -> None:
    registry = default_runtime_registry()

    assert registry.tool_ids == EXPECTED_DEFAULT_TOOLS
    request = RuntimeToolRequest(
        "req-1",
        "shell-command",
        "run",
        tmp_path,
        {"command": "python3 -c 'print(\"ok\")'"},
    )
    result = result_from_xml(registry.run_tool(request_to_xml(request)))
    assert result.status == "completed"
    assert result.output["stdout"].strip() == "ok"


def test_runtime_installer_prepares_runtime_outputs_without_handoff(tmp_path: Path) -> None:
    installation = install_runtime_services(tmp_path)

    expected_directories = (
        tmp_path / ".harness" / "runs",
        tmp_path / ".harness" / "dashboard",
        tmp_path / ".harness" / "gates",
        tmp_path / ".harness" / "tools",
    )

    assert installation.repo_root == tmp_path
    assert installation.prepared_directories == expected_directories
    assert all(path.exists() for path in expected_directories)
    assert installation.registered_tools == EXPECTED_DEFAULT_TOOLS
    assert installation.registered_gates == ("verdict-status-present",)
    assert not (tmp_path / ".harness" / "runtime-services.xml").exists()


def test_runtime_installer_without_repo_root_only_returns_registry() -> None:
    installation = install_runtime_services()

    assert installation.repo_root is None
    assert installation.prepared_directories == ()
    assert installation.registered_gates == ("verdict-status-present",)
    assert installation.registered_tools == EXPECTED_DEFAULT_TOOLS
    assert installation.registry is not None
    assert installation.registry.tool_ids == EXPECTED_DEFAULT_TOOLS


def test_runtime_installer_is_idempotent(tmp_path: Path) -> None:
    first = install_runtime_services(tmp_path)
    second = install_runtime_services(tmp_path)

    assert second == first
    assert not (tmp_path / ".harness" / "runtime-services.xml").exists()
