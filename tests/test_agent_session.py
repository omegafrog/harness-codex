from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.agent_session import AgentSessionRequest, AgentSessionResult, CliAgentSessionAdapter


class _Cancelled:
    def is_cancelled(self) -> bool:
        return True


def test_cli_agent_session_runs_fake_provider_and_collects_final_message(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    provider.write_text(
        "#!/bin/sh\n"
        "while [ $# -gt 0 ]; do\n"
        "  if [ \"$1\" = \"--output-last-message\" ]; then shift; output=$1; fi\n"
        "  shift\n"
        "done\n"
        "cat >/dev/null\n"
        "printf '{\"session_id\":\"provider-1\"}\\n'\n"
        "printf '최종 응답' > \"$output\"\n",
        encoding="utf-8",
    )
    provider.chmod(0o755)
    session_dir = tmp_path / "session"
    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=session_dir,
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"provider": "codex", "provider_binary": str(provider)},
            prompt="<user_instruction>원문</user_instruction>",
            timeout_sec=5,
        )
    )

    assert result.status == "succeeded"
    assert result.termination_reason == "completed"
    assert result.final_message == "최종 응답"
    assert result.provider_session_id == "provider-1"
    assert all(path.is_file() for path in result.artifact_paths.values())


def test_agent_session_reports_missing_final_response(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    provider.write_text("#!/bin/sh\ncat >/dev/null\n", encoding="utf-8")
    provider.chmod(0o755)
    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"provider": "codex", "provider_binary": str(provider)},
            prompt="요청",
            timeout_sec=5,
        )
    )

    assert result.status == "failed"
    assert result.termination_reason == "missing_final_response"


def test_agent_session_provider_not_found_is_blocked(tmp_path: Path) -> None:
    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"provider": "custom_cli", "provider_command": ["missing-provider"]},
            prompt="요청",
            timeout_sec=5,
        )
    )

    assert result.status == "blocked"
    assert result.termination_reason == "provider_not_found"


def test_agent_session_cancellation_is_not_reported_as_timeout(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    provider.write_text("#!/bin/sh\nsleep 5\n", encoding="utf-8")
    provider.chmod(0o755)
    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"provider": "codex", "provider_binary": str(provider)},
            prompt="요청",
            timeout_sec=5,
            cancellation=_Cancelled(),
        )
    )

    assert result.status == "cancelled"
    assert result.termination_reason == "cancelled"


class _FakeAdapter:
    def __init__(self, result: AgentSessionResult) -> None:
        self.result = result
        self.request = None

    def run(self, request: AgentSessionRequest) -> AgentSessionResult:
        self.request = request
        return self.result
