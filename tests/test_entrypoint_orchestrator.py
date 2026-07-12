from __future__ import annotations

from pathlib import Path

from harness_codex import canonical_cli
from harness_codex.runtime.orchestrator_invocation import OrchestratorInvocationResult


def test_public_orchestrate_command_passes_prompt_to_agent(monkeypatch, tmp_path: Path, capsys) -> None:
    seen: dict[str, object] = {}

    def fake_invoke(prompt: str, *, repo_root: Path, session_id: str | None = None) -> OrchestratorInvocationResult:
        seen["prompt"] = prompt
        seen["repo_root"] = repo_root
        seen["session_id"] = session_id
        return OrchestratorInvocationResult(status="completed", output="최종 결과")

    monkeypatch.setattr(canonical_cli, "invoke_orchestrator", fake_invoke)

    assert canonical_cli.main(["--repo-root", str(tmp_path), "orchestrate", "사용자", "요청"]) == 0
    assert seen == {"prompt": "사용자 요청", "repo_root": tmp_path, "session_id": None}
    assert capsys.readouterr().out.strip() == "최종 결과"


def test_public_orchestrate_command_requires_prompt(tmp_path: Path, capsys) -> None:
    assert canonical_cli.main(["--repo-root", str(tmp_path), "orchestrate"]) == 2
    assert "requires a user prompt" in capsys.readouterr().err
