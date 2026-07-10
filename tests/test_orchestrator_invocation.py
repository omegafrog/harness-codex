from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.orchestrator_invocation import invoke_orchestrator


def test_invoke_orchestrator_preserves_prompt_and_returns_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / ".codex" / "agents"
    config.mkdir(parents=True)
    (config / "workflow_orchestrator.toml").write_text('name = "workflow_orchestrator"\n', encoding="utf-8")
    seen: dict[str, object] = {}

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["input"] = kwargs["input"]
        return type("Completed", (), {"returncode": 0, "stdout": "완료", "stderr": ""})()

    monkeypatch.setattr("harness_codex.runtime.orchestrator_invocation.subprocess.run", fake_run)

    result = invoke_orchestrator("  사용자 요청  ", repo_root=tmp_path)

    assert result.status == "completed"
    assert result.output == "완료"
    assert "<user_request>\n  사용자 요청  \n</user_request>" in str(seen["input"])
    assert "<orchestration_agent_instructions>" in str(seen["input"])
    assert seen["command"][0:2] == ["codex", "exec"]


def test_invoke_orchestrator_rejects_empty_prompt(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="user_prompt is required"):
        invoke_orchestrator("  ", repo_root=tmp_path)


def test_invoke_orchestrator_returns_failure_without_agent_config(tmp_path: Path) -> None:
    result = invoke_orchestrator("요청", repo_root=tmp_path)

    assert result.status == "failed"
    assert result.output == ""
    assert result.error and "config not found" in result.error
