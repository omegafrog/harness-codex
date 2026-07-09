from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.runtime_services import (
    RuntimeGateCondition,
    RuntimeSchema,
    default_runtime_registry,
    install_runtime_services,
    load_runtime_services_manifest,
)

EXPECTED_DEFAULT_TOOLS = (
    "artifact-directories",
    "dashboard-projection",
    "dashboard-ui",
    "deploy-server-lifecycle",
    "dev-server-lifecycle",
    "memory",
    "observability",
    "selected-step-execution",
    "shell-command",
    "worktree-setup",
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
    selected = registry.run_tool("selected-step-execution", {})
    assert selected == {
        "status": "registered",
        "tool_id": "selected-step-execution",
        "capability": "selected-step",
        "description": "Execute one orchestration-agent-selected step and return only the step result.",
    }
    shell = registry.run_tool("shell-command", {})
    assert shell == {
        "status": "registered",
        "tool_id": "shell-command",
        "capability": "shell",
        "description": "Execute local shell commands as a runtime service.",
    }


def test_runtime_installer_prepares_dirs_and_manifest(tmp_path: Path) -> None:
    installation = install_runtime_services(tmp_path)

    assert installation.repo_root == tmp_path
    assert all(path.exists() for path in installation.prepared_directories)
    assert installation.registered_tools == EXPECTED_DEFAULT_TOOLS
    manifest = load_runtime_services_manifest(tmp_path)
    assert manifest["schemas"] == ["gate-verdict", "verification-report"]
    assert manifest["gates"] == ["verdict-status-present"]
    assert manifest["tools"] == list(EXPECTED_DEFAULT_TOOLS)
