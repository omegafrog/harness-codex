from __future__ import annotations

from harness_codex.runtime import preflight
from harness_codex.runtime.gate_policy import GateRequirement


def test_empty_scope_keeps_focused_test_policy_required() -> None:
    assert preflight._gate_requirement((), "focused-tests") is GateRequirement.REQUIRED


def test_empty_scope_keeps_docker_as_non_waivable_blocker(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(preflight, "_tool_reference_text", lambda _: "docker")
    monkeypatch.setattr(preflight.shutil, "which", lambda _: None)

    checks = preflight._required_tool_checks(tmp_path, ())

    assert len(checks) == 1
    assert checks[0].check_id == "required-tool-docker"
    assert checks[0].severity == "blocking"
    assert checks[0].override_allowed is False


def test_empty_scope_preserves_legacy_waiver_for_non_docker_tool(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(preflight, "_tool_reference_text", lambda _: "semgrep")
    monkeypatch.setattr(preflight.shutil, "which", lambda _: None)

    checks = preflight._required_tool_checks(tmp_path, ())

    assert len(checks) == 1
    assert checks[0].check_id == "required-tool-semgrep"
    assert checks[0].severity == "blocking"
    assert checks[0].override_allowed is True
