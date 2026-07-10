from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.runtime_services import (
    RuntimeGateCondition,
    RuntimeSchema,
    default_runtime_registry,
    install_runtime_services,
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


def test_runtime_schema_registry_supports_register_update_validate() -> None:
    registry = default_runtime_registry()
    registry.register_schema(RuntimeSchema(schema_id="custom", required_fields=("status",)))

    assert registry.validate_schema("custom", {"status": "ok"}).status == "pass"
    missing = registry.validate_schema("custom", {})
    assert missing.status == "fail"
    assert missing.violations == ("status",)

    registry.update_schema(RuntimeSchema(schema_id="custom", required_fields=("status", "rule_id")))
    updated = registry.validate_schema("custom", {"status": "ok"})
    assert updated.status == "fail"
    assert updated.violations == ("rule_id",)


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
        "status": "pass",
        "rule_id": "must-pass",
        "reason": "",
        "evidence_path": "evidence.xml",
        "violations": [],
    }
    assert failed.as_dict() == {
        "status": "fail",
        "rule_id": "must-pass",
        "reason": "payload must pass",
        "evidence_path": "evidence.xml",
        "violations": [{"type": "gate", "rule_id": "must-pass"}],
    }
    assert "owner_stage" not in failed.as_dict()
    assert "recommended_resume_target" not in failed.as_dict()


def test_default_registry_exposes_runtime_owned_service_tools() -> None:
    registry = default_runtime_registry()

    assert registry.tool_ids == EXPECTED_DEFAULT_TOOLS
    shell = registry.run_tool("shell-command", {})
    assert shell == {
        "status": "unavailable",
        "tool_id": "shell-command",
        "capability": "shell",
        "description": "Execute local shell commands as a runtime service.",
        "error": "runtime tool handler is not configured",
    }


def test_runtime_installer_prepares_runtime_outputs_without_handoff(tmp_path: Path) -> None:
    installation = install_runtime_services(tmp_path)

    expected_directories = (
        tmp_path / ".harness" / "runs",
        tmp_path / ".harness" / "dashboard",
        tmp_path / ".harness" / "schemas",
        tmp_path / ".harness" / "gates",
        tmp_path / ".harness" / "tools",
    )

    assert installation.repo_root == tmp_path
    assert installation.prepared_directories == expected_directories
    assert all(path.exists() for path in expected_directories)
    assert installation.registered_tools == EXPECTED_DEFAULT_TOOLS
    assert installation.registered_schemas == ("gate-verdict", "subagent-invocation-v1", "subagent-result-v1")
    assert installation.registered_gates == ("verdict-status-present",)
    assert not (tmp_path / ".harness" / "runtime-services.xml").exists()


def test_runtime_installer_without_repo_root_only_returns_registry() -> None:
    installation = install_runtime_services()

    assert installation.repo_root is None
    assert installation.prepared_directories == ()
    assert installation.registered_schemas == ("gate-verdict", "subagent-invocation-v1", "subagent-result-v1")
    assert installation.registered_gates == ("verdict-status-present",)
    assert installation.registered_tools == EXPECTED_DEFAULT_TOOLS


def test_runtime_installer_is_idempotent(tmp_path: Path) -> None:
    first = install_runtime_services(tmp_path)
    second = install_runtime_services(tmp_path)

    assert second == first
    assert not (tmp_path / ".harness" / "runtime-services.xml").exists()
