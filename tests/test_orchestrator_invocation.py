from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.agent_session import AgentSessionResult
from harness_codex.runtime.orchestrator_invocation import invoke_orchestrator


class _FakeAdapter:
    def __init__(self) -> None:
        self.request = None

    def run(self, request):
        self.request = request
        return AgentSessionResult(status="succeeded", termination_reason="completed", final_message="완료")


def test_invoke_orchestrator_preserves_prompt_and_returns_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / ".codex" / "agents"
    config.mkdir(parents=True)
    (config / "workflow_orchestrator.toml").write_text(
        'name = "workflow_orchestrator"\ndeveloper_instructions = "지침"\n', encoding="utf-8"
    )
    skill = tmp_path / ".codex" / "skills" / "harness-orchestrate-instruction"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# skill", encoding="utf-8")
    adapter = _FakeAdapter()
    result = invoke_orchestrator("  사용자 요청  ", repo_root=tmp_path, session_adapter=adapter)

    assert result.status == "completed"
    assert result.output == "완료"
    assert adapter.request is not None
    assert "<user_instruction>\n  사용자 요청  \n</user_instruction>" in adapter.request.prompt


def test_invoke_orchestrator_rejects_empty_prompt(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="user_prompt is required"):
        invoke_orchestrator("  ", repo_root=tmp_path)


def test_invoke_orchestrator_returns_failure_without_agent_config(tmp_path: Path) -> None:
    result = invoke_orchestrator("요청", repo_root=tmp_path)

    assert result.status == "blocked"
    assert result.output == ""
    assert result.error and "workflow_orchestrator.toml" in result.error
