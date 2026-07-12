from __future__ import annotations

import os
from pathlib import Path
import time

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


def test_orchestrator_product_command_is_terminated(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    provider.write_text(
        "#!/bin/sh\n"
        "cat >/dev/null\n"
        "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"/bin/zsh -lc ./gradlew build\"}}'\n"
        "sleep 5\n",
        encoding="utf-8",
    )
    provider.chmod(0o755)
    result = CliAgentSessionAdapter(poll_interval_sec=0.01).run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"name": "workflow_orchestrator", "provider": "codex", "provider_binary": str(provider)},
            prompt="요청",
            timeout_sec=5,
        )
    )

    assert result.status == "failed"
    assert result.termination_reason == "orchestrator_boundary_violation"


def test_orchestrator_native_specialist_spawn_is_terminated(tmp_path: Path) -> None:
    provider = tmp_path / "provider"
    provider.write_text("#!/bin/sh\nprintf '%s\\n' '{\"item\": {\"type\": \"collab_tool_call\", \"tool\": \"spawn_agent\"}}'\nsleep 3\n", encoding="utf-8")
    provider.chmod(0o755)
    result = CliAgentSessionAdapter(poll_interval_sec=0.01).run(
        AgentSessionRequest(repo_root=tmp_path, session_dir=tmp_path / "session", agent_config_path=tmp_path / "agent.toml", agent_config={"name": "workflow_orchestrator", "provider_binary": str(provider)}, prompt="x", timeout_sec=5)
    )
    assert result.termination_reason == "orchestrator_boundary_violation"
    assert "runtime" in result.error


def test_orchestrator_rejects_direct_reads_and_allows_runtime_dispatch(tmp_path: Path) -> None:
    from harness_codex.runtime.agent_session import _allowed_orchestrator_command

    run_id = "run-1"
    assert _allowed_orchestrator_command("/bin/zsh -lc 'python3 -m harness_codex.orchestration.runtime_context --repo-root . --run-id run-1'", run_id)
    assert _allowed_orchestrator_command("/bin/zsh -lc 'python3 -m harness_codex.orchestration.runtime_dispatch --repo-root . --run-id run-1 --step-id review --change-set-id CHG-1 --work-item-id MAINT-1'", run_id)
    assert not _allowed_orchestrator_command("/bin/zsh -lc 'find .harness/runs -type f'", run_id)
    assert not _allowed_orchestrator_command("/bin/zsh -lc 'sed -n 1,20p .codex/agents/workflow_orchestrator.toml'", run_id)


def test_agent_session_passes_declared_provider_config_overrides(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    arguments_path = tmp_path / "arguments.txt"
    provider.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > \"{arguments_path}\"\n"
        "while [ \"$#\" -gt 0 ]; do\n"
        "  if [ \"$1\" = \"--output-last-message\" ]; then shift; output=$1; fi\n"
        "  shift\n"
        "done\n"
        "cat >/dev/null\n"
        "printf '완료' > \"$output\"\n",
        encoding="utf-8",
    )
    provider.chmod(0o755)

    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={
                "provider": "codex",
                "provider_binary": str(provider),
                "provider_config_overrides": ["mcp_servers.serena.enabled=false"],
            },
            prompt="요청",
            timeout_sec=5,
        )
    )

    assert result.status == "succeeded"
    assert arguments_path.read_text(encoding="utf-8").splitlines().count("-c") == 2
    assert "mcp_servers.serena.enabled=false" in arguments_path.read_text(encoding="utf-8")


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


def test_agent_session_timeout_reaps_provider_descendants(tmp_path: Path) -> None:
    provider = tmp_path / "provider.sh"
    child_pid_path = tmp_path / "child.pid"
    provider.write_text(
        "#!/bin/sh\n"
        "sleep 30 & child=$!\n"
        f"echo $child > \"{child_pid_path}\"\n"
        "wait $child\n",
        encoding="utf-8",
    )
    provider.chmod(0o755)
    result = CliAgentSessionAdapter().run(
        AgentSessionRequest(
            repo_root=tmp_path,
            session_dir=tmp_path / "session",
            agent_config_path=tmp_path / "agent.toml",
            agent_config={"provider": "codex", "provider_binary": str(provider)},
            prompt="요청",
            timeout_sec=1,
        )
    )

    assert result.termination_reason == "timeout"
    child_pid = int(child_pid_path.read_text(encoding="utf-8"))
    time.sleep(0.1)
    try:
        os.kill(child_pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError(f"provider child process survived timeout: {child_pid}")


class _FakeAdapter:
    def __init__(self, result: AgentSessionResult) -> None:
        self.result = result
        self.request = None

    def run(self, request: AgentSessionRequest) -> AgentSessionResult:
        self.request = request
        return self.result
